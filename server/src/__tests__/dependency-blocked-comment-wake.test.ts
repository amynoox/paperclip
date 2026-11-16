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
    const companyId = randomUUID(), devId = randomUUID(), ctoId = randomUUID();
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
    return { companyId, devId, ctoId, taskId, blockerId, ctoRunId };
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

  it("holds at the claim gate a CTO comment queued while the Dev was busy, once the blocker is added", async () => {
    const f = await seed({ blocked: false, devMaxConcurrent: 1 });
    // The Dev is busy on another task: the comment's run waits in the queue.
    const busyRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: busyRunId, companyId: f.companyId, agentId: f.devId, invocationSource: "assignment",
      status: "running", startedAt: new Date(), contextSnapshot: { issueId: randomUUID() } });
    await db.update(agents).set({ status: "running" }).where(eq(agents.id, f.devId));
    await request(app(f.companyId, { agentId: f.ctoId, runId: f.ctoRunId })).post(`/api/issues/${f.taskId}/comments`)
      .send({ body: "Please look at the build log." }).expect(201);
    await expect.poll(async () => (await devRuns(f))[0]?.status, { timeout: 20_000 }).toBe("queued");
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
  }, 120_000);

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
