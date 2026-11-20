// studio.25 assembly: two cases that cross STUDIO-0075 (the session a LATE result names is kept for its task) with
// what removes a session on purpose: a person's reset, and the guard of STUDIO-0078 that gives a session up after
// repeated failures (the series of TR-2069). A removal always wins over the late result of a run created before it.
// Both cases fail on a tree without STUDIO-0075.
import { randomUUID } from "node:crypto";
import { and, asc, eq, gt } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agentTaskSessions, agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb,
  heartbeatRunEvents, heartbeatRuns, issueComments, issues, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { runningProcesses, type AdapterExecutionContext, type AdapterExecutionResult } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { createHeartbeatRunState } from "../services/heartbeat/run-state.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (_context: AdapterExecutionContext): Promise<AdapterExecutionResult> => ({
    exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Turn.", provider: "test", model: "test-model",
  })),
);
vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })) };
});

const adapterType = "codex_local";
const FIRST = "thread-first";
const CUT = "thread-cut";
// The two names the trees under test share as text: the mark a removal leaves (STUDIO-0075) and the guard's (STUDIO-0078).
const TASK_SESSION_REMOVED = "agent.task_session_removed";
const GUARD_MARK = "relaunchLoopGuard";
const ACK_UNCERTAIN = "router_interactive_ack_uncertain";
const SUCCESS: AdapterExecutionResult = { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
  summary: "Turn.", provider: "test", model: "test-model" };
type Turn = (context: AdapterExecutionContext) => Promise<AdapterExecutionResult>;
vi.setConfig({ testTimeout: 180_000 });
const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("a session removed on purpose, then the late result of a run created before the removal", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const turns = new Map<string, Turn[]>();
  const executions = new Map<string, Array<{ runId: string; runtime: AdapterExecutionContext["runtime"] }>>();
  const play: Turn = async context => {
    const key = context.agent.companyId;
    executions.set(key, [...(executions.get(key) ?? []), { runId: context.runId, runtime: context.runtime }]);
    const turn = turns.get(key)?.shift();
    return turn ? turn(context) : SUCCESS;
  };
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("late-result-after-removal-");
    db = createDb(database.connectionString);
    heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    mockAdapterExecute.mockImplementation(play);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    runningProcesses.clear();
  });
  afterAll(async () => { await database?.cleanup(); });

  const FOLDER = "/srv/work/6d499883/63d1cf8b/work";
  const paramsOf = (sessionId: string) => ({ sessionId, cwd: FOLDER,
    remoteExecution: { transport: "ssh", host: "mac-03", port: 22, username: "worker", remoteCwd: FOLDER } });
  const opens = (sessionId: string): AdapterExecutionResult =>
    ({ ...SUCCESS, sessionId, sessionDisplayId: sessionId, sessionParams: paramsOf(sessionId) });
  /** The worker router's failure result: the ordinary session fields, with one of its codes. */
  const routerFailure = (errorCode: string, sessionId: string | null): AdapterExecutionResult => ({
    exitCode: 1, signal: null, timedOut: false, errorCode, errorMessage: errorCode.replaceAll("_", " "),
    ...(sessionId ? { sessionId, sessionDisplayId: sessionId, sessionParams: paramsOf(sessionId) } : {}) });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Assembly", defaultResponsibleUserId: "responsible-user",
      issuePrefix: `A${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: "responsible-user", name: "Fixture user", email: "responsible-user@example.test",
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user",
      status: "active", membershipRole: "member" }).onConflictDoNothing();
    await db.insert(agents).values({ id: agentId, companyId, name: "Dev Unity", role: "engineer", status: "active",
      adapterType, adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Routed task", status: "todo", priority: "medium",
      assigneeAgentId: agentId });
    turns.set(companyId, []);
    executions.set(companyId, []);
    return { companyId, agentId, issueId };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;
  const reread = async (runId: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!;
  const taskSession = async (f: Fixture) => (await db.select().from(agentTaskSessions).where(and(
    eq(agentTaskSessions.companyId, f.companyId), eq(agentTaskSessions.agentId, f.agentId),
    eq(agentTaskSessions.taskKey, f.issueId))))[0] ?? null;
  const state = async (f: Fixture) => JSON.stringify({
    runs: (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)).orderBy(asc(heartbeatRuns.createdAt)))
      .map(run => [run.status, run.errorCode, run.sessionIdBefore]),
    wakes: (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)))
      .map(wake => [wake.status, wake.reason, wake.error]),
    task: (await db.select().from(issues).where(eq(issues.id, f.issueId))).map(issue => [issue.status, issue.assigneeAgentId === f.agentId]) });
  /** The n-th execution of the adapter for the task, once its run is settled. */
  async function execution(f: Fixture, n: number) {
    await vi.waitFor(async () => {
      expect(executions.get(f.companyId)!.length, await state(f)).toBeGreaterThanOrEqual(n);
      const run = await reread(executions.get(f.companyId)![n - 1]!.runId);
      expect(["succeeded", "failed", "cancelled", "timed_out"], await state(f)).toContain(run.status);
    }, { timeout: 25_000, interval: 100 });
    const { runId, runtime } = executions.get(f.companyId)![n - 1]!;
    await heartbeat.waitForRunExecutionDrain(runId);
    return { run: await reread(runId), sessionId: runtime.sessionId, sessionParams: runtime.sessionParams };
  }
  const assignmentWake = (f: Fixture) => heartbeat.wakeup(f.agentId, { source: "assignment", triggerDetail: "system",
    reason: "issue_assigned", payload: { issueId: f.issueId, mutation: "update" },
    requestedByActorType: "user", requestedByActorId: "responsible-user",
    contextSnapshot: { issueId: f.issueId, taskId: f.issueId, source: "issue.update" } });
  /** A comment on the task, as the manager's answer that restarted the role at each turn of TR-2069. */
  async function answer(f: Fixture) {
    const commentId = randomUUID();
    await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId, authorType: "user",
      authorUserId: "responsible-user", body: "Try again, the build is ready." });
    await heartbeat.wakeup(f.agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: "responsible-user",
      payload: { issueId: f.issueId, commentId }, contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_commented",
        commentId, wakeCommentId: commentId } }).catch(() => undefined);
  }
  /**
   * What starts the role again on the task: the server's own retry of the failed run when it scheduled one (its delay
   * is taken as passed), else an answer on the task.
   */
  async function again(f: Fixture) {
    const [scheduled] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      eq(heartbeatRuns.status, "scheduled_retry")));
    if (!scheduled) return answer(f);
    await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(Date.now() - 60_000) }).where(eq(heartbeatRuns.id, scheduled.id));
    await heartbeat.promoteDueScheduledRetries();
    await heartbeat.resumeQueuedRuns();
  }
  async function nextExecution(f: Fixture, trigger: () => Promise<unknown>) {
    const done = executions.get(f.companyId)!.length;
    await trigger();
    return execution(f, done + 1);
  }
  /** What the run says of its late result: the record in its result, and its event. */
  async function lateResultOf(runId: string) {
    const events = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, runId),
      eq(heartbeatRunEvents.eventType, "run.late_result")));
    return { record: (await reread(runId)).resultJson?.lateResult, events: events.map(event => [event.level, event.payload?.session]) };
  }
  /** A first run that ends well in session FIRST, then the run whose engine opened CUT and that ends as `cutTurn` says. */
  async function cutRun(f: Fixture, cutTurn: Turn) {
    turns.get(f.companyId)!.push(async () => opens(FIRST), cutTurn);
    await assignmentWake(f);
    await execution(f, 1);
    expect((await taskSession(f))?.sessionParamsJson).toMatchObject(paramsOf(FIRST));
    await assignmentWake(f);
    return (await execution(f, 2)).run;
  }

  it("(a) a person resets the session, then the late result of a run created before the reset arrives: the session is not put back", async () => {
    // Without a reset, the session a late result names is kept for the task: this is what a removal must win over.
    const plain = await seed();
    const kept = await cutRun(plain, async () => {
      await heartbeat.cancelActiveForAgent(plain.agentId);
      return routerFailure("router_cancelled", CUT);
    });
    expect(kept).toMatchObject({ status: "cancelled", sessionIdAfter: CUT });
    expect(await taskSession(plain)).toMatchObject({ sessionDisplayId: CUT, lastRunId: kept.id });
    expect(await lateResultOf(kept.id)).toMatchObject({ record: { session: "kept" }, events: [["info", "kept"]] });
    // The same cut run, and a person resets the role's session for the task before the result arrives.
    const f = await seed();
    const cancelled = await cutRun(f, async () => {
      await heartbeat.cancelActiveForAgent(f.agentId);
      expect(await taskSession(f)).toMatchObject({ sessionDisplayId: FIRST });
      await heartbeat.resetRuntimeSession(f.agentId, { taskKey: f.issueId });
      expect(await taskSession(f)).toBeNull();
      return routerFailure("router_cancelled", CUT);
    });
    expect(cancelled).toMatchObject({ status: "cancelled" });
    expect(cancelled.sessionIdAfter).toBeNull();
    expect(await taskSession(f)).toBeNull();
    expect(await lateResultOf(cancelled.id)).toMatchObject({ record: { session: "left", sameSessionAsTask: false }, events: [["info", "left"]] });
  });

  it("(b) TR-2069: the guard gives the session up after three empty failures, then a late result of a run of the series arrives: the dead session is not put back, and the next run starts on a fresh session", async () => {
    const f = await seed();
    // A run that resumes a session fails as TR-2069 did and returns that session; a run that starts fresh ends well
    // and names no session.
    const turn: Turn = async context => (context.runtime.sessionId ? routerFailure(ACK_UNCERTAIN, context.runtime.sessionId) : SUCCESS);
    turns.get(f.companyId)!.push(async () => opens(FIRST));
    await assignmentWake(f);
    await execution(f, 1);
    expect(await taskSession(f)).toMatchObject({ sessionDisplayId: FIRST });
    // The role is started again and again (the server's retry, or an answer on the task). The series forms on the real
    // run path, and the guard acts at the start of the run that follows three empty failures.
    const guarded = async () => {
      for (const { runId, runtime } of executions.get(f.companyId)!) {
        const run = await reread(runId);
        if (run.contextSnapshot?.[GUARD_MARK]) return { run, sessionId: runtime.sessionId };
      }
      return null;
    };
    for (let starts = 0; starts < 8 && !(await guarded()); starts += 1) {
      turns.get(f.companyId)!.push(turn);
      await nextExecution(f, () => again(f));
    }
    const fresh = await guarded();
    expect(fresh, await state(f)).not.toBeNull();
    const mark = fresh!.run.contextSnapshot![GUARD_MARK] as { action: string; droppedSessionId: string; failedRunIds: string[] };
    expect(mark).toMatchObject({ action: "fresh_session", droppedSessionId: FIRST });
    expect(mark.failedRunIds).toHaveLength(3);
    expect(fresh!.sessionId ?? null).toBeNull();
    await heartbeat.waitForRunExecutionDrain(fresh!.run.id);
    expect(await taskSession(f)).toBeNull();
    // The guard's removal left the mark of a removal made on purpose, after the runs of the series were created.
    const lastOfTheSeries = await reread(mark.failedRunIds[2]!);
    expect(lastOfTheSeries).toMatchObject({ status: "failed", errorCode: ACK_UNCERTAIN, sessionIdBefore: FIRST });
    const removals = await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.agentId, f.agentId),
      eq(activityLog.action, TASK_SESSION_REMOVED), gt(activityLog.createdAt, lastOfTheSeries.createdAt)));
    // Soft: on a tree without the mark, what follows shows what the late result then does.
    expect.soft(removals.length, await state(f)).toBeGreaterThanOrEqual(1);
    // A result of that run arrives late and names the dead session: written as the completion of a late result
    // writes it (run-completion.ts, persistLateSessionState). It is refused.
    const written = await createHeartbeatRunState(db).upsertTaskSession({
      companyId: f.companyId, agentId: f.agentId, adapterType, taskKey: f.issueId,
      sessionParamsJson: paramsOf(FIRST), sessionDisplayId: FIRST, lastRunId: lastOfTheSeries.id, lastError: null,
      lateResultOfRun: { id: lastOfTheSeries.id, createdAt: lastOfTheSeries.createdAt },
    } as Parameters<ReturnType<typeof createHeartbeatRunState>["upsertTaskSession"]>[0]);
    expect(written).toBeNull();
    expect(await taskSession(f)).toBeNull();
    // The role's next run starts on a fresh session, not on the dead one; the guard has nothing more to drop.
    turns.get(f.companyId)!.push(turn);
    const next = await nextExecution(f, () => again(f));
    expect(next.sessionId ?? null, await state(f)).toBeNull();
    expect(next.run.sessionIdBefore).toBeNull();
    expect(next.run.status).toBe("succeeded");
  });
});
