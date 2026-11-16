/**
 * STUDIO-0063: an agent's comment on an issue waiting on unresolved blockers.
 *
 * Production 15 Nov 2026, TR-1258: the CTO set a blocker and commented on the Dev's task in one call; the
 * assignment wake was held, the comment wake started the Dev's run. The rule now, through the real routes:
 * - an agent's comment waits with the issue, at admission and at the claim gate (a comment queued while the
 *   assignee was busy, before the blocker was added);
 * - a person's comment and a verified blocker stall keep their way in; another role reaches the blocked assignee
 *   with a card on its own task addressed to the assignee (an existing path, proven here);
 * - the held comments are handed to the assignee with the wake that follows the blockers' resolution.
 * Third version (second independent review): a comment held at the CLAIM gate is handed over too, merged comments
 * included; so are held comments when the blockers are removed or cancelled, or the issue reassigned; a person's
 * bounded run does not consume them; a mentioned non-assignee passes as before; all held comments are named.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { buildPaperclipWakePayload } from "../services/heartbeat/run-preparation.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const ADAPTER = "codex_local";

(support.supported ? describe : describe.skip)("agent comments on a dependency-blocked issue (STUDIO-0063)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const dispatched: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-blocked-comment-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await db.insert(authUsers).values({ id: "board-user", name: "Board", email: "board@example.test", emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
    registerServerAdapter({
      type: ADAPTER, supportsLocalAgentJwt: false,
      execute: async (input) => { dispatched.push(input.runId); return { exitCode: 0, signal: null, timedOut: false, resultJson: {} }; },
      testEnvironment: async () => ({ adapterType: ADAPTER, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 90_000);
  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(ADAPTER);
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  async function seed(options: { blocked?: boolean; devMaxConcurrent?: number } = {}) {
    const companyId = randomUUID(), devId = randomUUID(), ctoId = randomUUID(), qaId = randomUUID(), dev2Id = randomUUID();
    const taskId = randomUUID(), blockerId = randomUUID(), ctoTaskId = randomUUID(), ctoRunId = randomUUID();
    const prefix = `B${companyId.replaceAll("-", "").slice(0, 5).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Blocked comment", issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "board-user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board-user", status: "active", membershipRole: "operator" });
    await db.insert(agents).values([
      { id: devId, companyId, name: "Dev", role: "engineer", status: "idle", adapterType: ADAPTER, adapterConfig: {}, permissions: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: options.devMaxConcurrent ?? 2 } } },
      { id: ctoId, companyId, name: "CTO", role: "cto", status: "running", adapterType: ADAPTER, adapterConfig: {}, permissions: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true } } },
      { id: qaId, companyId, name: "QA", role: "qa", status: "idle", adapterType: ADAPTER, adapterConfig: {}, permissions: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true } } },
      { id: dev2Id, companyId, name: "Dev2", role: "engineer", status: "idle", adapterType: ADAPTER, adapterConfig: {}, permissions: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true } } },
    ]);
    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Blocker", status: "todo", issueNumber: 1, identifier: `${prefix}-1`, responsibleUserId: "board-user" },
      { id: taskId, companyId, title: "Dev task", status: "todo", assigneeAgentId: devId, issueNumber: 2, identifier: `${prefix}-2`, responsibleUserId: "board-user" },
      { id: ctoTaskId, companyId, title: "CTO task", status: "in_progress", assigneeAgentId: ctoId, issueNumber: 3, identifier: `${prefix}-3`, responsibleUserId: "board-user" },
    ]);
    // The CTO writes from its own live run on its own task.
    await db.insert(heartbeatRuns).values({ id: ctoRunId, companyId, agentId: ctoId, invocationSource: "assignment",
      status: "running", startedAt: new Date(), contextSnapshot: { issueId: ctoTaskId } });
    if (options.blocked !== false) {
      await request(app(companyId)).patch(`/api/issues/${taskId}`).send({ blockedByIssueIds: [blockerId] }).expect(200);
    }
    return { companyId, devId, ctoId, qaId, dev2Id, taskId, blockerId, ctoRunId };
  }

  function app(companyId: string, agentActor?: { agentId: string; runId: string }) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = { type: agentActor ? "agent" : "board", ...(agentActor ? { ...agentActor, companyId } : {}),
        source: "session", userId: "board-user", companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "operator" }], isInstanceAdmin: false };
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  const devRuns = (f: { devId: string; taskId: string }) => db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.agentId, f.devId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.taskId}`));
  const heldFor = (f: { devId: string }, commentId: string) => db.select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
    .from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, f.devId), sql`${agentWakeupRequests.payload}->>'commentId' = ${commentId}`));
  const agentRuns = (agentId: string, taskId: string) => db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.agentId, agentId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${taskId}`));
  const cto = (f: { companyId: string; ctoId: string; ctoRunId: string }) => app(f.companyId, { agentId: f.ctoId, runId: f.ctoRunId });
  const ctoComment = async (f: { companyId: string; ctoId: string; ctoRunId: string; taskId: string }, body: string) => {
    await request(cto(f)).post(`/api/issues/${f.taskId}/comments`).send({ body }).expect(201);
    return commentIdOf(f.taskId, body);
  };
  // Held comments only (a recovery wake held by the same gate carries no comment).
  const heldRequests = (f: { companyId: string; taskId: string }) => db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.reason, "issue_dependencies_blocked"),
    eq(agentWakeupRequests.status, "skipped"), eq(agentWakeupRequests.requestedByActorType, "agent"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${f.taskId}`,
    sql`(${agentWakeupRequests.payload} ? 'commentId' or ${agentWakeupRequests.payload} ? 'commentIds')`));
  // The run that carries held comments, once started; its packet shows them.
  const carrierOf = async (agentId: string, taskId: string, predicate: (context: any) => boolean = () => true) => {
    let found: typeof heartbeatRuns.$inferSelect | undefined;
    await expect.poll(async () => {
      found = (await agentRuns(agentId, taskId)).find(run => Array.isArray((run.contextSnapshot as any)?.heldDependencyCommentIds)
        && predicate(run.contextSnapshot));
      return Boolean(found);
    }, { timeout: 20_000 }).toBe(true);
    await heartbeat.drainActiveRunExecutions();
    return found!;
  };
  const packetOf = (f: { companyId: string }, agentId: string, run: typeof heartbeatRuns.$inferSelect) =>
    buildPaperclipWakePayload({ db, companyId: f.companyId, agentId, runId: run.id,
      contextSnapshot: run.contextSnapshot as Record<string, unknown> });
  const finishBlocker = (f: { companyId: string; blockerId: string }) =>
    request(app(f.companyId)).patch(`/api/issues/${f.blockerId}`).send({ status: "done" }).expect(200);
  const commentIdOf = async (taskId: string, body: string) =>
    (await db.select({ id: issueComments.id }).from(issueComments).where(and(eq(issueComments.issueId, taskId), eq(issueComments.body, body))))[0]!.id;

  it("holds the CTO's comment written with the blocker in one call (TR-1258), then hands it over when the blocker is done", async () => {
    const f = await seed({ blocked: false });
    const body = "Mission attributed; admission held until the group is ready.";
    await request(app(f.companyId, { agentId: f.ctoId, runId: f.ctoRunId })).patch(`/api/issues/${f.taskId}`)
      .send({ blockedByIssueIds: [f.blockerId], comment: body }).expect(200);
    await heartbeat.drainActiveRunExecutions();
    const commentId = await commentIdOf(f.taskId, body);
    // The route sends its wakes after answering: wait for the request it records.
    await expect.poll(() => heldFor(f, commentId), { timeout: 20_000 }).toEqual([{ status: "skipped", reason: "issue_dependencies_blocked" }]);
    expect(await devRuns(f)).toEqual([]);

    // The blocker is done: the Dev's dependency wake carries the held comment, and its wake packet shows it.
    await request(app(f.companyId)).patch(`/api/issues/${f.blockerId}`).send({ status: "done" }).expect(200);
    const resolvedRun = async () => (await devRuns(f)).find((run) => (run.contextSnapshot as any)?.wakeReason === "issue_blockers_resolved");
    await expect.poll(resolvedRun, { timeout: 20_000 }).toBeDefined();
    await heartbeat.drainActiveRunExecutions();
    const resolved = await resolvedRun();
    expect((resolved!.contextSnapshot as any).heldDependencyCommentIds).toEqual([commentId]);
    const packet = await buildPaperclipWakePayload({ db, companyId: f.companyId, agentId: f.devId, runId: resolved!.id,
      contextSnapshot: resolved!.contextSnapshot as Record<string, unknown> });
    expect(JSON.stringify(packet)).toContain(body);
  }, 120_000);

  it("holds at the claim gate the CTO comments queued while the Dev was busy, merged ones included, and hands them over", async () => {
    const f = await seed({ blocked: false, devMaxConcurrent: 1 });
    // The Dev is busy on another task: the comment's run waits in the queue.
    const busyRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: busyRunId, companyId: f.companyId, agentId: f.devId, invocationSource: "assignment",
      status: "running", startedAt: new Date(), contextSnapshot: { issueId: randomUUID() } });
    await db.update(agents).set({ status: "running" }).where(eq(agents.id, f.devId));
    const first = await ctoComment(f, "Please look at the build log.");
    await expect.poll(async () => (await devRuns(f))[0]?.status, { timeout: 20_000 }).toBe("queued");
    // A second comment merges into the same queued run.
    const second = await ctoComment(f, "And the test report.");
    await expect.poll(async () => JSON.stringify((await devRuns(f))[0]?.contextSnapshot ?? {}), { timeout: 20_000 }).toContain(second);
    expect(await devRuns(f)).toHaveLength(1);
    const [queued] = await devRuns(f);
    // The blocker comes after; then the busy run ends and the queue is resumed.
    await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`).send({ blockedByIssueIds: [f.blockerId] }).expect(200);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busyRunId));
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.devId));
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id));
    expect(after).toMatchObject({ status: "cancelled", errorCode: "issue_dependencies_blocked" });
    expect(dispatched).not.toContain(queued!.id);
    // The claim recorded both comments as held, like an admission hold.
    const held = await heldRequests(f);
    expect(held.flatMap(row => [(row.payload as any).commentId, ...((row.payload as any).commentIds ?? [])])).toEqual(
      expect.arrayContaining([first, second]));
    // The blocker is done: the dependency wake hands both over, in full in its packet.
    await finishBlocker(f);
    const carrier = await carrierOf(f.devId, f.taskId, context => context.wakeReason === "issue_blockers_resolved");
    expect((carrier.contextSnapshot as any).heldDependencyCommentIds).toEqual([first, second]);
    const packet = JSON.stringify(await packetOf(f, f.devId, carrier));
    expect(packet).toContain("Please look at the build log.");
    expect(packet).toContain("And the test report.");
  }, 120_000);

  it("keeps a person's exception for a queued run that merged a person's comment with an agent's", async () => {
    const f = await seed({ blocked: false, devMaxConcurrent: 1 });
    const busyRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: busyRunId, companyId: f.companyId, agentId: f.devId, invocationSource: "assignment",
      status: "running", startedAt: new Date(), contextSnapshot: { issueId: randomUUID() } });
    await db.update(agents).set({ status: "running" }).where(eq(agents.id, f.devId));
    await ctoComment(f, "Agent first.");
    await expect.poll(async () => (await devRuns(f))[0]?.status, { timeout: 20_000 }).toBe("queued");
    await request(app(f.companyId)).post(`/api/issues/${f.taskId}/comments`).send({ body: "Person second." }).expect(201);
    const personId = await commentIdOf(f.taskId, "Person second.");
    await expect.poll(async () => JSON.stringify((await devRuns(f))[0]?.contextSnapshot ?? {}), { timeout: 20_000 }).toContain(personId);
    const [queued] = await devRuns(f);
    await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`).send({ blockedByIssueIds: [f.blockerId] }).expect(200);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busyRunId));
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.devId));
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id));
    expect(after!.status).not.toBe("cancelled");
    expect(dispatched).toContain(queued!.id);
  }, 120_000);

  it("hands held comments over when the blockers are removed instead of done", async () => {
    const f = await seed();
    const held = await ctoComment(f, "Removed-blocker note.");
    await expect.poll(async () => (await heldRequests(f)).length, { timeout: 20_000 }).toBe(1);
    expect(await devRuns(f)).toEqual([]);
    await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`).send({ blockedByIssueIds: [] }).expect(200);
    const carrier = await carrierOf(f.devId, f.taskId);
    expect((carrier.contextSnapshot as any).heldDependencyCommentIds).toEqual([held]);
    expect(JSON.stringify(await packetOf(f, f.devId, carrier))).toContain("Removed-blocker note.");
  }, 120_000);

  it("hands held comments over with the cancelled blocker's handoff, and no longer holds while every blocker is cancelled", async () => {
    const f = await seed();
    const held = await ctoComment(f, "Before the cancel.");
    await expect.poll(async () => (await heldRequests(f)).length, { timeout: 20_000 }).toBe(1);
    await request(app(f.companyId)).patch(`/api/issues/${f.blockerId}`).send({ status: "cancelled" }).expect(200);
    const carrier = await carrierOf(f.devId, f.taskId);
    expect((carrier.contextSnapshot as any).cancelledBlockerIssueId).toBe(f.blockerId);
    expect((carrier.contextSnapshot as any).heldDependencyCommentIds).toEqual([held]);
    // Nothing would lift a cancelled blocker: an agent's comment now reaches the assignee as a bounded run.
    const after = await ctoComment(f, "After the cancel.");
    await expect.poll(async () => (await devRuns(f)).some(run => JSON.stringify(run.contextSnapshot).includes(after)), { timeout: 20_000 }).toBe(true);
    await heartbeat.drainActiveRunExecutions();
    const heldNow = await heldRequests(f);
    expect(heldNow.length, JSON.stringify({ held: heldNow.map(r => r.payload),
      runs: (await devRuns(f)).map(r => ({ s: r.status, e: r.errorCode, c: r.contextSnapshot })) })).toBe(1);
  }, 120_000);

  it("hands held comments over to the new assignee after a reassignment", async () => {
    const f = await seed();
    const held = await ctoComment(f, "For whoever owns this task.");
    await expect.poll(async () => (await heldRequests(f)).length, { timeout: 20_000 }).toBe(1);
    await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`).send({ assigneeAgentId: f.dev2Id }).expect(200);
    await heartbeat.drainActiveRunExecutions();
    await finishBlocker(f);
    const carrier = await carrierOf(f.dev2Id, f.taskId);
    expect((carrier.contextSnapshot as any).heldDependencyCommentIds).toEqual([held]);
  }, 120_000);

  it("does not let a person's bounded run consume the agents' held comments (lastRun)", async () => {
    const f = await seed();
    const held = await ctoComment(f, "Held before the person.");
    await expect.poll(async () => (await heldRequests(f)).length, { timeout: 20_000 }).toBe(1);
    await request(app(f.companyId)).post(`/api/issues/${f.taskId}/comments`).send({ body: "Person meanwhile." }).expect(201);
    await expect.poll(async () => (await devRuns(f)).length, { timeout: 20_000 }).toBe(1);
    await heartbeat.drainActiveRunExecutions();
    const [personRun] = await devRuns(f);
    expect((personRun!.contextSnapshot as any).heldDependencyCommentIds).toBeUndefined();
    await finishBlocker(f);
    const carrier = await carrierOf(f.devId, f.taskId, context => context.wakeReason === "issue_blockers_resolved");
    expect((carrier.contextSnapshot as any).heldDependencyCommentIds).toEqual([held]);
    // Handed over once: a later run of the issue carries nothing more.
    const laterId = await ctoComment(f, "A later note.");
    await expect.poll(async () => (await devRuns(f)).some(run => JSON.stringify(run.contextSnapshot).includes(laterId)), { timeout: 20_000 }).toBe(true);
    await heartbeat.drainActiveRunExecutions();
    const others = (await devRuns(f)).filter(run => run.id !== personRun!.id && run.id !== carrier.id);
    expect(others.length).toBeGreaterThan(0);
    for (const run of others) expect((run.contextSnapshot as any).heldDependencyCommentIds).toBeUndefined();
  }, 120_000);

  it("still wakes, as before, a role that is not the blocked issue's assignee for an agent's comment", async () => {
    const f = await seed();
    // In this fork a mention never wakes (queue.ts: "Mentions only annotate comments"), before and after this change.
    // A non-assignee reached by an agent's comment wake on the Dev's blocked task (a review participant, for example)
    // passes the dependency gate as before; only the assignee is held.
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.taskId, authorType: "agent",
      authorAgentId: f.ctoId, body: `[@QA](agent://${f.qaId}) can you check the fixture?` }).returning();
    const commentWake = (agentId: string) => heartbeat.wakeup(agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId: f.taskId, commentId: comment!.id }, requestedByActorType: "agent", requestedByActorId: f.ctoId,
      contextSnapshot: { issueId: f.taskId, taskId: f.taskId, wakeReason: "issue_commented", commentId: comment!.id,
        wakeCommentId: comment!.id, source: "issue.comment" },
    });
    const qaRun = await commentWake(f.qaId);
    expect(qaRun, JSON.stringify(await db.select({ s: agentWakeupRequests.status, r: agentWakeupRequests.reason,
      e: agentWakeupRequests.error }).from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.qaId)))).not.toBeNull();
    expect(qaRun!.contextSnapshot).toMatchObject({ dependencyBlockedInteraction: true });
    // The same wake for the blocked assignee is held.
    expect(await commentWake(f.devId)).toBeNull();
    await heartbeat.drainActiveRunExecutions();
    expect((await devRuns(f)).filter(run => JSON.stringify(run.contextSnapshot).includes(comment!.id))).toEqual([]);
  }, 120_000);

  it("names every held comment and shows the latest twenty in full", async () => {
    const f = await seed();
    // The route limits an agent's comment rate: two come through the route, the twenty others are written as the
    // admission writes them (an agent comment and its skipped issue_dependencies_blocked request).
    const ids: string[] = [];
    for (let i = 1; i <= 22; i += 1) {
      const body = `Held note ${String(i).padStart(2, "0")}.`;
      if (i <= 2) { ids.push(await ctoComment(f, body)); continue; }
      const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.taskId, authorType: "agent",
        authorAgentId: f.ctoId, body, createdAt: new Date(Date.now() + i) }).returning();
      await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.devId, source: "automation",
        triggerDetail: "system", reason: "issue_dependencies_blocked", status: "skipped", requestedByActorType: "agent",
        requestedByActorId: f.ctoId, requestedAt: new Date(Date.now() + 1000 + i), finishedAt: new Date(),
        payload: { issueId: f.taskId, commentId: comment!.id } });
      ids.push(comment!.id);
    }
    await expect.poll(async () => (await heldRequests(f)).length, { timeout: 30_000 }).toBe(22);
    await finishBlocker(f);
    const carrier = await carrierOf(f.devId, f.taskId);
    expect((carrier.contextSnapshot as any).heldDependencyCommentIds).toEqual(ids);
    const packet = await packetOf(f, f.devId, carrier) as any;
    expect(packet.heldDependencyComments).toMatchObject({ heldCount: 22, shownCount: 20, olderInThreadCount: 2 });
    // The packet lists the latest twenty (its usual inline body limit applies) and asks the agent to read the thread.
    expect(packet.commentIds).toEqual(ids.slice(2));
    expect(packet.truncated).toBe(true);
    expect(packet.fallbackFetchNeeded).toBe(true);
    expect(JSON.stringify(packet)).not.toContain("Held note 02.");
  }, 180_000);

  it("keeps a person's comment as a bounded interaction run on the blocked issue", async () => {
    const f = await seed();
    await request(app(f.companyId)).post(`/api/issues/${f.taskId}/comments`).send({ body: "Explain the dependency." }).expect(201);
    await expect.poll(async () => (await devRuns(f)).length, { timeout: 20_000 }).toBe(1);
    await heartbeat.drainActiveRunExecutions();
    const runs = await devRuns(f);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.contextSnapshot).toMatchObject({ wakeReason: "issue_commented", dependencyBlockedInteraction: true });
  }, 120_000);

  it("reaches the blocked assignee through a card on the asker's own task, addressed to the assignee", async () => {
    const f = await seed();
    const ctoTaskId = (await db.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, f.companyId), eq(issues.title, "CTO task"))))[0]!.id;
    // The CTO asks from its own task (a card is created by a run of the same issue), addressed to the Dev.
    const created = await request(app(f.companyId, { agentId: f.ctoId, runId: f.ctoRunId })).post(`/api/issues/${ctoTaskId}/interactions`).send({
      kind: "ask_user_questions", addresseeAgentId: f.devId, resolverPolicy: "anyone",
      payload: { version: 1, questions: [{ id: "q", prompt: "Is WIN-01 free?", selectionMode: "single",
        options: [{ id: "y", label: "Yes" }, { id: "n", label: "No" }] }] },
    });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    // The Dev's wake on the CTO's task is admitted (not held by the Dev's own blockers). As in production (TR-1258,
    // 15 Nov: card at 21:08:11, addressee run at 21:09:01 when the asker's run ended), it waits for the asker's run.
    const cardWakes = () => db.select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, f.devId), sql`${agentWakeupRequests.payload}->>'issueId' = ${ctoTaskId}`));
    await expect.poll(async () => (await cardWakes()).length, { timeout: 20_000 }).toBeGreaterThan(0);
    expect((await cardWakes()).every((wake) => wake.status !== "skipped" && wake.reason !== "issue_dependencies_blocked")).toBe(true);
    expect(await devRuns(f)).toEqual([]);
    // A card put by the CTO on the Dev's own blocked task is refused by the route (not from a run of that task).
    const refused = await request(app(f.companyId, { agentId: f.ctoId, runId: f.ctoRunId })).post(`/api/issues/${f.taskId}/interactions`).send({
      kind: "ask_user_questions", addresseeAgentId: f.devId, resolverPolicy: "anyone",
      payload: { version: 1, questions: [{ id: "q", prompt: "?", selectionMode: "single", options: [{ id: "y", label: "Yes" }] }] },
    });
    expect(refused.status).toBe(422);
  }, 120_000);

  it("still wakes the assignee for an agent's comment when the issue is not blocked", async () => {
    const f = await seed({ blocked: false });
    await request(app(f.companyId, { agentId: f.ctoId, runId: f.ctoRunId })).post(`/api/issues/${f.taskId}/comments`)
      .send({ body: "A note on an open task." }).expect(201);
    await expect.poll(async () => (await devRuns(f)).length, { timeout: 20_000 }).toBe(1);
    await heartbeat.drainActiveRunExecutions();
  }, 120_000);
});
