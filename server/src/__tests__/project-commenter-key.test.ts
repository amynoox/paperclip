/**
 * STUDIO-0102: a `project_commenter` key finds, reads and comments on the tickets of its projects, and does nothing
 * else. A dedicated agent that never runs carries it; two relays post one comment on the ticket that follows an
 * outside event (a pull request, a build). Every case below goes through the real authentication of an agent key,
 * the route guard mounted as in app.ts, and the real routes; every refusal is checked to leave nothing written.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog, agentApiKeys, agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, documents, issueComments,
  issueDocuments, issueWorkProducts, issues, projects,
} from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { projectCommenterRouteGuard } from "../middleware/project-commenter-scope.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { companyRoutes } from "../routes/companies.js";
import { secretRoutes } from "../routes/secrets.js";
import { agentService } from "../services/agents.js";
import { authorizationService } from "../services/authorization.js";
import { PROJECT_COMMENTER_HOURLY_CAP } from "../services/cross-issue-influence-limit.js";
import { hashProjectCommenterToken } from "../lib/agent-records.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("a project_commenter key (STUDIO-0102)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  const companyId = randomUUID(), otherCompanyId = randomUUID(), userId = `board-${randomUUID()}`;
  const devQa = randomUUID(), otherProject = randomUUID(), foreignProject = randomUUID();
  const commenterId = randomUUID(), qaId = randomUUID(), integratorId = randomUUID(), foreignAgentId = randomUUID();
  const tracking = randomUUID(), integration = randomUUID(), byComment = randomUUID(), byDocument = randomUUID();
  const elsewhere = randomUUID(), foreignIssue = randomUUID(), closed = randomUUID(), capped = randomUUID();
  const marker = `PR-${randomUUID().slice(0, 8)}`, buildId = `build-${randomUUID().slice(0, 8)}`, docOnly = `doc-${randomUUID().slice(0, 8)}`;
  let token = "", standardToken = "", capKeyToken = "";

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("project-commenter-key-");
    db = createDb(database.connectionString);
    await db.insert(authUsers).values({ id: userId, name: "Board", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values([
      { id: companyId, name: "Studio", issuePrefix: `P${companyId.slice(0, 5).toUpperCase()}`, defaultResponsibleUserId: userId },
      { id: otherCompanyId, name: "Other", issuePrefix: `Q${otherCompanyId.slice(0, 5).toUpperCase()}` },
    ]);
    await db.insert(companyMemberships).values([{ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" }]);
    await db.insert(projects).values([
      { id: devQa, companyId, name: "Dev et QA", status: "in_progress" },
      { id: otherProject, companyId, name: "Another project", status: "in_progress" },
      { id: foreignProject, companyId: otherCompanyId, name: "Foreign project", status: "in_progress" },
    ]);
    const agent = (id: string, company: string, name: string, wake: boolean) => ({ id, companyId: company, name, role: "general",
      status: "idle" as const, adapterType: "process", adapterConfig: {}, permissions: {},
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: wake } } });
    // The dedicated agent that never runs, and two holders of tracking tickets.
    await db.insert(agents).values([agent(commenterId, companyId, "Event relay", false), agent(qaId, companyId, "Quality Manager", true),
      agent(integratorId, companyId, "Game Integrator", true), agent(foreignAgentId, otherCompanyId, "Foreign", true)]);
    let n = 0;
    const ticket = (id: string, projectId: string, title: string, assigneeAgentId: string, status = "in_progress", company = companyId) => ({
      id, companyId: company, projectId, title, status, assigneeAgentId, issueNumber: ++n, identifier: `P-${n}`, responsibleUserId: userId,
      description: "The ticket's own text.", ...(status === "done" ? { completedAt: new Date() } : {}) });
    await db.insert(issues).values([
      ticket(tracking, devQa, `Follow ${marker}`, qaId), ticket(integration, devQa, `Integrate ${marker}`, integratorId),
      ticket(byComment, devQa, "Debug build follow-up", qaId), ticket(byDocument, devQa, "Planned work", qaId),
      ticket(elsewhere, otherProject, `Elsewhere ${marker}`, qaId), ticket(closed, devQa, "Closed follow-up", qaId, "done"),
      ticket(capped, devQa, "A busy follow-up", qaId),
      ticket(foreignIssue, foreignProject, `Foreign ${marker}`, foreignAgentId, "todo", otherCompanyId),
    ]);
    // The build id is written only in a comment of its follow-up; the other word only in a document.
    await db.insert(issueComments).values({ companyId, issueId: byComment, authorAgentId: qaId, body: `Accepted ${buildId}` });
    const [doc] = await db.insert(documents).values({ companyId, title: "Plan", latestBody: `The plan names ${docOnly}.` }).returning();
    await db.insert(issueDocuments).values({ companyId, issueId: byDocument, documentId: doc!.id, key: "plan" });
    await db.insert(issueWorkProducts).values({ companyId, projectId: devQa, issueId: tracking, type: "pull_request", provider: "github",
      externalId: "389", title: "Pull request 389", url: "https://example.test/pull/389", status: "open", summary: "not for the relay",
      metadata: { private: "not for the relay" } });
    const keys = agentService(db);
    token = (await keys.createApiKey(commenterId, "event relay", { kind: "project_commenter", projectIds: [devQa] }, { responsibleUserId: userId })).token;
    capKeyToken = (await keys.createApiKey(commenterId, "second relay", { kind: "project_commenter", projectIds: [devQa] }, { responsibleUserId: userId })).token;
    standardToken = (await keys.createApiKey(commenterId, "standard", { kind: "standard" }, { responsibleUserId: userId })).token;
    app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    app.use(projectCommenterRouteGuard);
    app.use("/api", issueRoutes(db, {} as any, {}));
    app.use("/api", agentRoutes(db));
    app.use("/api", companyRoutes(db));
    app.use("/api", secretRoutes(db));
    app.use(errorHandler);
  }, 120_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  const as = (key = token) => ({ Authorization: `Bearer ${key}` });
  const get = (path: string, key = token) => request(app).get(path).set(as(key));
  const post = (path: string, body: unknown, key = token) => request(app).post(path).set(as(key)).send(body as object);
  const commentsOf = (issueId: string) => db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
  const search = (q: string, key = token) => get(`/api/companies/${companyId}/issues?q=${encodeURIComponent(q)}&projectId=${devQa}&limit=50`, key);
  const idsOf = (res: request.Response) => (res.body as Array<{ id: string }>).map(row => row.id).sort();
  const denied = (res: request.Response) => {
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code).toBe("project_commenter_route_denied");
  };

  it("finds the tickets of every holder of its project by their text, a comment's text included, never a document's", async () => {
    const res = await search(marker);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(idsOf(res)).toEqual([tracking, integration].sort());
    // Each row: what finding the ticket needs, and nothing else.
    for (const row of res.body) expect(Object.keys(row).sort()).toEqual(["assigneeAgentId", "companyId", "id", "projectId", "status"]);
    expect(idsOf(await search(buildId))).toEqual([byComment]);
    // The word written only in a document: found by a standard key, not by this one.
    expect(idsOf(await search(docOnly))).toEqual([]);
    expect((await search(docOnly, standardToken)).body.map((row: { id: string }) => row.id)).toContain(byDocument);
  });

  it("reads the tracking ticket in a reduced view: its holder, status and work products, no documents, no description", async () => {
    const res = await get(`/api/issues/${tracking}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ id: tracking, companyId, projectId: devQa, assigneeAgentId: qaId, status: "in_progress",
      workProducts: [{ type: "pull_request", provider: "github", externalId: "389", url: "https://example.test/pull/389" }] });
  });

  it("comments: the body is kept whole, with its HTML comment, read back whole, and wakes the holder; the cursor and the bounds", async () => {
    const body = `Pull request 389 was merged.\n\n<!-- facteur-v1 key=${randomUUID()} -->`;
    const res = await post(`/api/issues/${tracking}/comments`, { body, reopen: false });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [comment] = (await commentsOf(tracking)).filter(row => row.body === body);
    expect(comment).toMatchObject({ authorAgentId: commenterId, body });
    await expect.poll(async () => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, qaId)))
      .some(wake => (wake.payload as Record<string, unknown> | null)?.commentId === comment!.id), { timeout: 20_000 }).toBe(true);
    const read = await get(`/api/issues/${tracking}/comments?order=asc&limit=100`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const mine = (read.body as Array<Record<string, unknown>>).find(row => row.id === comment!.id);
    expect(mine).toEqual({ id: comment!.id, authorAgentId: commenterId, body });
    const page = await get(`/api/issues/${tracking}/comments?order=asc&limit=100&afterCommentId=${comment!.id}`);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    // The comment's write is in the activity log, with the key that made it.
    const logged = await db.select().from(activityLog).where(and(eq(activityLog.action, "issue.cross_issue_influence_observed"),
      eq(activityLog.entityId, tracking), sql`${activityLog.details}->>'keyId' is not null`));
    expect(logged.length).toBeGreaterThanOrEqual(1);
    expect(logged[0]).toMatchObject({ agentId: commenterId, runId: null, details: expect.objectContaining({ cap: PROJECT_COMMENTER_HOURLY_CAP, window: "1h" }) });
  });

  it("the cursor: a page after a comment, as the product gives it today", async () => {
    const first = await post(`/api/issues/${tracking}/comments`, { body: "Event one." });
    const second = await post(`/api/issues/${tracking}/comments`, { body: "Event two." });
    expect([first.status, second.status]).toEqual([201, 201]);
    const standard = await get(`/api/issues/${tracking}/comments?order=asc&limit=100&afterCommentId=${first.body.id}`, standardToken);
    const mine = await get(`/api/issues/${tracking}/comments?order=asc&limit=100&afterCommentId=${first.body.id}`);
    expect(mine.status).toBe(200);
    expect((mine.body as Array<{ id: string }>).map(row => row.id)).toEqual((standard.body as Array<{ id: string }>).map(row => row.id));
  });

  it("the 21st comment of the hour is refused, clearly, and logged; the 20 before it pass", async () => {
    for (let i = 1; i <= PROJECT_COMMENTER_HOURLY_CAP; i += 1) {
      const res = await post(`/api/issues/${capped}/comments`, { body: `Event ${i}.` }, capKeyToken);
      expect(res.status, `${i}: ${JSON.stringify(res.body)}`).toBe(201);
    }
    const over = await post(`/api/issues/${capped}/comments`, { body: "One too many." }, capKeyToken);
    expect(over.status, JSON.stringify(over.body)).toBe(429);
    expect((await commentsOf(capped)).filter(row => row.body === "One too many.")).toEqual([]);
    const rows = await db.select({ action: activityLog.action }).from(activityLog).where(and(eq(activityLog.entityId, capped),
      sql`${activityLog.details}->>'keyId' is not null`));
    expect(rows.filter(row => row.action === "issue.cross_issue_influence_observed")).toHaveLength(PROJECT_COMMENTER_HOURLY_CAP);
    expect(rows.filter(row => row.action === "issue.cross_issue_influence_cap_rejected")).toHaveLength(1);
    // The other key of the same scope counts its own.
    expect((await post(`/api/issues/${capped}/comments`, { body: "From the first key." })).status).toBe(201);
  }, 120_000);

  it("comments on a closed ticket of its project and leaves it closed; reopen: true is refused", async () => {
    const res = await post(`/api/issues/${closed}/comments`, { body: "A late event on a closed follow-up.", reopen: false });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    denied(await post(`/api/issues/${closed}/comments`, { body: "Reopen it.", reopen: true }));
    expect((await db.select({ status: issues.status }).from(issues).where(eq(issues.id, closed)))[0]!.status).toBe("done");
    expect((await commentsOf(closed)).filter(row => row.body === "Reopen it.")).toEqual([]);
  });

  it("refuses to create a ticket, to change a status or an assignee, and writes nothing", async () => {
    const before = (await db.select().from(issues).where(eq(issues.companyId, companyId))).length;
    denied(await post(`/api/companies/${companyId}/issues`, { title: "Made by the relay", projectId: devQa }));
    denied(await request(app).patch(`/api/issues/${tracking}`).set(as()).send({ status: "done" }));
    denied(await request(app).patch(`/api/issues/${tracking}`).set(as()).send({ assigneeAgentId: commenterId }));
    denied(await post(`/api/issues/${tracking}/checkout`, { agentId: commenterId, expectedStatuses: ["in_progress"] }));
    expect((await db.select().from(issues).where(eq(issues.companyId, companyId))).length).toBe(before);
    expect((await db.select().from(issues).where(eq(issues.id, tracking)))[0]).toMatchObject({ status: "in_progress", assigneeAgentId: qaId });
  });

  it("refuses to read or comment outside its project and outside its company", async () => {
    for (const [issueId, label] of [[elsewhere, "another project"], [foreignIssue, "another company"]] as const) {
      const res = await post(`/api/issues/${issueId}/comments`, { body: `Not for ${label}.`, reopen: false });
      expect([403, 404], `${label}: ${res.status} ${JSON.stringify(res.body)}`).toContain(res.status);
      expect((await commentsOf(issueId)).filter(row => row.body === `Not for ${label}.`)).toEqual([]);
      expect([403, 404]).toContain((await get(`/api/issues/${issueId}`)).status);
      expect([403, 404]).toContain((await get(`/api/issues/${issueId}/comments`)).status);
    }
  });

  it("refuses the list without its project, with another project, another company, another filter or view", async () => {
    denied(await get(`/api/companies/${companyId}/issues?q=${marker}`));
    denied(await get(`/api/companies/${companyId}/issues?q=${marker}&projectId=${otherProject}`));
    denied(await get(`/api/companies/${companyId}/issues?projectId=${devQa}&assigneeAgentId=${qaId}`));
    denied(await get(`/api/companies/${companyId}/issues?projectId=${devQa}&view=compact`));
    denied(await get(`/api/companies/${otherCompanyId}/issues?projectId=${foreignProject}`));
    denied(await get(`/api/issues/${tracking}?view=core`));
    denied(await get(`/api/issues/${tracking}/comments?after=${randomUUID()}`));
  });

  it("refuses to read a secret, a document, an attachment, the activity, the company, the agents, its own agent and keys", async () => {
    for (const path of [
      `/api/companies/${companyId}/secrets`, `/api/issues/${byDocument}/documents`, `/api/issues/${byDocument}/documents/plan`,
      `/api/issues/${tracking}/attachments`, `/api/issues/${tracking}/activity`, `/api/companies/${companyId}`,
      `/api/companies/${companyId}/agents`, `/api/agents/me`, `/api/agents/${commenterId}`, `/api/agents/${commenterId}/keys`,
    ]) denied(await get(path));
  });

  it("refuses a tool route and a catalog route", async () => {
    denied(await get(`/api/companies/${companyId}/tools`));
    denied(await post(`/api/companies/${companyId}/tool-access/tokens`, {}));
    denied(await get(`/api/companies/${companyId}/skills/catalog`));
    denied(await get(`/api/companies/${companyId}/catalog`));
  });

  it("refuses the other fields of a comment", async () => {
    for (const extra of [{ resume: true }, { interrupt: true }, { attachmentIds: [randomUUID()] }, { authorType: "user" },
      { onBehalfOfUserId: userId }, { metadata: {} }, { presentation: null }, { clientRequestId: randomUUID() }]) {
      denied(await post(`/api/issues/${tracking}/comments`, { body: "With more.", ...extra }));
    }
    denied(await post(`/api/issues/${tracking}/comments`, { reopen: false }));
    expect((await commentsOf(tracking)).filter(row => row.body === "With more.")).toEqual([]);
  });

  it("the authorization service refuses every other action of such a key, even where no route guard stands", async () => {
    const authz = authorizationService(db);
    const actor = { type: "agent" as const, agentId: commenterId, companyId, keyId: randomUUID(), source: "agent_key" as const,
      onBehalfOfUserId: userId, keyScope: { kind: "project_commenter" as const, projectIds: [devQa] } };
    const issue = (issueId: string, projectId: string) => ({ type: "issue" as const, companyId, issueId, projectId });
    for (const action of ["issue:mutate", "tasks:assign", "secrets:read", "secrets:propose", "agent:read", "agent:wake", "agent_config:update",
      "company_scope:read", "project:read", "runtime:manage", "decision_queue:manage"] as const) {
      expect((await authz.decide({ actor, action: action as never, resource: issue(tracking, devQa) })).allowed, action).toBe(false);
    }
    expect((await authz.decide({ actor, action: "issue:comment", resource: issue(elsewhere, otherProject) })).allowed).toBe(false);
    expect((await authz.decide({ actor, action: "issue:read", resource: { type: "issue", companyId } })).allowed).toBe(false);
    expect((await authz.decide({ actor, action: "issue:comment", resource: issue(tracking, devQa) })).allowed).toBe(true);
  });

  it("a server without the scope cannot find the key: its token is kept under a hash of its own", async () => {
    expect(token.startsWith("pcc_")).toBe(true);
    // What a server without the scope looks up: the plain hash of the token. Nothing answers to it.
    const plain = createHash("sha256").update(token).digest("hex");
    expect(await db.select({ id: agentApiKeys.id }).from(agentApiKeys).where(eq(agentApiKeys.keyHash, plain))).toEqual([]);
    expect(await db.select({ id: agentApiKeys.id }).from(agentApiKeys).where(eq(agentApiKeys.keyHash, hashProjectCommenterToken(token)))).toHaveLength(1);
    // A key of this scope kept under the plain hash (as a server without the scope would have it) is refused here.
    const forged = `pcp_${randomUUID().replaceAll("-", "")}`;
    await db.insert(agentApiKeys).values({ companyId, agentId: commenterId, name: "plain", responsibleUserId: userId,
      keyHash: createHash("sha256").update(forged).digest("hex"), scopeConfig: { kind: "project_commenter", projectIds: [devQa] } });
    expect((await get(`/api/issues/${tracking}`, forged)).status).toBe(401);
    // A token of that prefix for a key of another scope is refused too.
    const other = `pcc_${randomUUID().replaceAll("-", "")}`;
    await db.insert(agentApiKeys).values({ companyId, agentId: commenterId, name: "other scope", responsibleUserId: userId,
      keyHash: hashProjectCommenterToken(other), scopeConfig: null });
    expect((await get(`/api/companies/${companyId}/issues?q=${marker}`, other)).status).toBe(401);
  });

  it("a key of another scope gains nothing: a standard key of the same agent still needs a run to comment, and is not reduced", async () => {
    const res = await post(`/api/issues/${tracking}/comments`, { body: "From a standard key." }, standardToken);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code ?? res.body.details?.code).toBe("cross_issue_influence_run_context_required");
    const list = await get(`/api/companies/${companyId}/issues?q=${marker}`, standardToken);
    expect(list.status).toBe(200);
    expect(Object.keys(list.body[0] ?? {})).toContain("title");
  });

  it("the server mounts the guard right after the actor is resolved, before any route", () => {
    const source = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    const actor = source.indexOf("actorMiddleware(db, {"), guard = source.indexOf("app.use(projectCommenterRouteGuard);");
    expect(actor).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(actor);
    const between = source.slice(actor, guard);
    // Only the actor's own and the cloud control's middlewares come between: no route is mounted before the guard.
    expect(between.match(/app\.use\(/g)?.length ?? 0).toBe(1);
    expect(between).toContain("app.use(cloudControlMiddleware());");
  });

  it("a key of this scope names projects of its agent's company only", async () => {
    await expect(agentService(db).createApiKey(commenterId, "foreign", { kind: "project_commenter", projectIds: [foreignProject] },
      { responsibleUserId: userId })).rejects.toThrow(/projects of its agent's company/);
  });
});
