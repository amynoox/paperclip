/**
 * STUDIO-0099: the wake a person asks for on a task.
 *
 * Production, 23 Nov 2026: three tasks already assigned to a role were put in progress by the Board while that role was
 * being paused; no wake was requested for any of them, and nothing was replayed when the role resumed. Two holes:
 * - a person who puts an assigned task to work (todo → in_progress) woke nobody, pause or not;
 * - a wake a person asks for on a task, refused because the agent is paused, left no row: the resume replays the
 *   refused wakes of the system and of agents, and had nothing to replay for a person's.
 * Through the real issue routes, as the Board and as an agent, with real wakes and runs.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { PAUSE_MISSED_WAKE_REASON, replayWakesMissedDuringPause } from "../services/pause-missed-wakes.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Each case runs real runs through an embedded database; the default delay of a case is too short under load.
vi.setConfig({ testTimeout: 90_000 });
const support = await getEmbeddedPostgresTestSupport();
const ADAPTER = "codex_local";

(support.supported ? describe : describe.skip)("the wake a person asks for on a task (STUDIO-0099)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-person-wake-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await db.insert(authUsers).values({ id: "board-user", name: "Board", email: "board@example.test", emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
    registerServerAdapter({
      type: ADAPTER, supportsLocalAgentJwt: false,
      execute: async () => ({ exitCode: 0, signal: null, timedOut: false, resultJson: {} }),
      testEnvironment: async () => ({ adapterType: ADAPTER, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 90_000);
  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(ADAPTER);
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  async function seed(options: { status?: string; assigned?: boolean } = {}) {
    const companyId = randomUUID(), devId = randomUUID(), ctoId = randomUUID(), taskId = randomUUID(), ctoTaskId = randomUUID();
    const devRunId = randomUUID(), ctoRunId = randomUUID();
    const prefix = `W${companyId.replaceAll("-", "").slice(0, 5).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Person wake", issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "board-user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board-user", status: "active", membershipRole: "operator" });
    await db.insert(agents).values([
      { id: devId, companyId, name: "Dev", role: "engineer", status: "idle", adapterType: ADAPTER, adapterConfig: {}, permissions: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 2 } } },
      { id: ctoId, companyId, name: "CTO", role: "cto", status: "running", adapterType: ADAPTER, adapterConfig: {}, permissions: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true } } },
    ]);
    await db.insert(issues).values([
      { id: taskId, companyId, title: "Dev task", status: options.status ?? "todo", assigneeAgentId: options.assigned === false ? null : devId,
        issueNumber: 1, identifier: `${prefix}-1`, responsibleUserId: "board-user" },
      { id: ctoTaskId, companyId, title: "CTO task", status: "in_progress", assigneeAgentId: ctoId, issueNumber: 2, identifier: `${prefix}-2`, responsibleUserId: "board-user" },
    ]);
    // Each agent writes from a live run of its own, on another task: the task under test has no run yet.
    await db.insert(heartbeatRuns).values([
      { id: ctoRunId, companyId, agentId: ctoId, invocationSource: "assignment", status: "running", startedAt: new Date(), contextSnapshot: { issueId: ctoTaskId } },
      { id: devRunId, companyId, agentId: devId, invocationSource: "assignment", status: "running", startedAt: new Date(), contextSnapshot: { issueId: ctoTaskId } },
    ]);
    return { companyId, devId, ctoId, taskId, ctoTaskId, devRunId, ctoRunId };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;

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
  const board = (f: Fixture) => app(f.companyId);
  const asAgent = (f: Fixture, agentId: string, runId: string) => app(f.companyId, { agentId, runId });
  /** Every wake asked for the Dev on the task, whatever became of it. */
  const wakesOf = (f: Fixture) => db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
    eq(agentWakeupRequests.agentId, f.devId), sql`${agentWakeupRequests.payload}->>'issueId' = ${f.taskId}`));
  const runsOf = (f: Fixture) => db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, f.devId),
    sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.taskId}`));
  /** The route sends its wakes after it answered: wait until nothing of the task is on its way. */
  async function settled(f: Fixture) {
    await heartbeat.drainActiveRunExecutions();
    await expect.poll(async () => (await runsOf(f)).filter(run => ["queued", "running"].includes(run.status)).length, { timeout: 20_000 }).toBe(0);
    await heartbeat.drainActiveRunExecutions();
  }
  /** The first run of the Dev on the task. The product may start others afterwards by itself (a run that ends without a
   * disposition is followed by a repair run): they are not what a wake of these cases starts. */
  const firstRunOf = async (f: Fixture) => (await runsOf(f)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
  const replayedWakesOf = async (f: Fixture) => (await wakesOf(f)).filter(wake => wake.reason === PAUSE_MISSED_WAKE_REASON);
  const statusOf = async (f: Fixture) => (await db.select({ status: issues.status }).from(issues).where(eq(issues.id, f.taskId)))[0]!.status;
  const pause = (f: Fixture) => db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.devId));
  /** The role resumes: what the lifecycle worker does once the agent is ready again (agent-lifecycle-driver.ts). */
  async function resume(f: Fixture) {
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.devId));
    return replayWakesMissedDuringPause(db, { companyId: f.companyId, agentId: f.devId,
      wakeup: (agentId, opts) => heartbeat.wakeup(agentId, opts) });
  }

  it("a person puts an assigned task to work (todo → in_progress): the assignee is woken and starts", async () => {
    const f = await seed();
    await request(board(f)).patch(`/api/issues/${f.taskId}`).send({ status: "in_progress" }).expect(200);
    await expect.poll(async () => (await wakesOf(f)).map(wake => [wake.reason, wake.requestedByActorType]), { timeout: 20_000 })
      .toEqual([["issue_status_changed", "user"]]);
    await settled(f);
    expect((await firstRunOf(f))!.contextSnapshot).toMatchObject({ issueId: f.taskId, source: "issue.status_change" });
  });

  it("the assignee puts its own task in progress: it is not woken", async () => {
    const f = await seed();
    await request(asAgent(f, f.devId, f.devRunId)).patch(`/api/issues/${f.taskId}`).send({ status: "in_progress" }).expect(200);
    expect(await statusOf(f)).toBe("in_progress");
    await settled(f);
    expect(await wakesOf(f)).toEqual([]);
    expect(await runsOf(f)).toEqual([]);
  });

  it("another agent puts the task in progress: nobody is woken, as before", async () => {
    const f = await seed();
    await request(asAgent(f, f.ctoId, f.ctoRunId)).patch(`/api/issues/${f.taskId}`).send({ status: "in_progress" }).expect(200);
    expect(await statusOf(f)).toBe("in_progress");
    await settled(f);
    expect(await wakesOf(f)).toEqual([]);
    expect(await runsOf(f)).toEqual([]);
  });

  it("a person's other changes of status keep their rule: in_progress → todo wakes nobody, backlog → todo wakes the assignee", async () => {
    const back = await seed({ status: "in_progress" });
    await request(board(back)).patch(`/api/issues/${back.taskId}`).send({ status: "todo" }).expect(200);
    await settled(back);
    expect(await wakesOf(back)).toEqual([]);
    const fromBacklog = await seed({ status: "backlog" });
    await request(board(fromBacklog)).patch(`/api/issues/${fromBacklog.taskId}`).send({ status: "todo" }).expect(200);
    await expect.poll(async () => (await wakesOf(fromBacklog)).map(wake => wake.reason), { timeout: 20_000 }).toEqual(["issue_status_changed"]);
    await settled(fromBacklog);
  });

  it("the assignee is paused: the person's wake is refused and leaves its row, and the resume replays it once", async () => {
    const f = await seed();
    await pause(f);
    // The Board is answered as before: its change is made.
    await request(board(f)).patch(`/api/issues/${f.taskId}`).send({ status: "in_progress" }).expect(200);
    expect(await statusOf(f)).toBe("in_progress");
    await expect.poll(async () => (await wakesOf(f)).map(wake => [wake.status, wake.reason, wake.requestedByActorType]), { timeout: 20_000 })
      .toEqual([["skipped", "agent.not_invokable", "user"]]);
    await settled(f);
    expect(await runsOf(f)).toEqual([]);
    const [refused] = await wakesOf(f);
    // The role resumes: one wake for the task, which starts its run.
    expect(await resume(f)).toEqual({ issues: 1, woken: 1 });
    await settled(f);
    const replayed = await replayedWakesOf(f);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!.payload).toMatchObject({ issueId: f.taskId, missedWakeRequestId: refused!.id });
    expect(await firstRunOf(f)).toMatchObject({ status: "succeeded", wakeupRequestId: replayed[0]!.id });
    // Resumed again (another pause and resume later): nothing is replayed twice.
    expect(await resume(f)).toMatchObject({ woken: 0 });
    await settled(f);
    expect(await replayedWakesOf(f)).toHaveLength(1);
  });

  it("a task assigned by a person to a paused agent: the wake leaves its row and the resume replays it", async () => {
    const f = await seed({ assigned: false });
    await pause(f);
    await request(board(f)).patch(`/api/issues/${f.taskId}`).send({ assigneeAgentId: f.devId }).expect(200);
    await expect.poll(async () => (await wakesOf(f)).map(wake => [wake.status, wake.reason, wake.requestedByActorType]), { timeout: 20_000 })
      .toEqual([["skipped", "agent.not_invokable", "user"]]);
    expect(await resume(f)).toEqual({ issues: 1, woken: 1 });
    await settled(f);
    const replayed = await replayedWakesOf(f);
    expect(replayed).toHaveLength(1);
    expect(await firstRunOf(f)).toMatchObject({ status: "succeeded", wakeupRequestId: replayed[0]!.id });
  });

  it("the caller of a refused wake is answered as before, and a wake that names no task leaves no row", async () => {
    const f = await seed();
    await pause(f);
    const refusal = await heartbeat.wakeup(f.devId, { source: "automation", triggerDetail: "system", reason: "issue_status_changed",
      payload: { issueId: f.taskId, mutation: "update" }, requestedByActorType: "user", requestedByActorId: "board-user",
      contextSnapshot: { issueId: f.taskId, source: "issue.status_change" } }).then(() => null, error => error);
    // A refusal, not a wait saved for the caller.
    expect(refusal).toMatchObject({ status: 409 });
    expect(refusal?.constructor?.name).not.toBe("PersistedExecutionWaitRefusal");
    expect((await wakesOf(f)).map(wake => [wake.status, wake.reason])).toEqual([["skipped", "agent.not_invokable"]]);
    const before = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.devId))).length;
    await heartbeat.wakeup(f.devId, { source: "on_demand", triggerDetail: "manual", reason: "manual",
      requestedByActorType: "user", requestedByActorId: "board-user" }).catch(() => null);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.devId))).length).toBe(before);
  });
});
