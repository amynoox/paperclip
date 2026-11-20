import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentTaskSessions, agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, environmentLeases,
  heartbeatRunEvents, heartbeatRuns, issueComments, issues, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { runningProcesses, type AdapterExecutionContext, type AdapterExecutionResult } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { environmentService } from "../services/environments.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (_context: AdapterExecutionContext): Promise<AdapterExecutionResult> => ({
    exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Turn.", provider: "test", model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })) };
});

// STUDIO-0075: production, 20 Nov 2026, 03:00 UTC. Two routed runs (claude_local, codex_local) lost the link to their
// worker machine; their retries opened new conversations in the same remote folder. The owner's rule: a machine that
// loses its connection must not lose its work; the same role resumes where it was, on the same machine.
// From its version 0.30.19 the worker router returns, in its FAILURE result, the session its engine had opened: the
// ordinary fields of an adapter result, for four codes. Each case runs real heartbeat runs with a stand-in adapter that
// returns results of that shape, and reads what the server keeps for the task and hands to the next run.
const SUCCESS: AdapterExecutionResult = { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
  summary: "Turn.", provider: "test", model: "test-model" };
type Turn = (context: AdapterExecutionContext) => Promise<AdapterExecutionResult>;
vi.setConfig({ testTimeout: 90_000 });
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip).each([
  { adapterType: "codex_local", first: "thread-first", cut: "thread-cut", other: "thread-other" },
  { adapterType: "claude_local", first: "11111111-1111-4111-8111-111111111111", cut: "22222222-2222-4222-8222-222222222222",
    other: "33333333-3333-4333-8333-333333333333" },
])("the session a failed $adapterType run returns", ({ adapterType, first, cut, other }) => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  // The product starts runs by itself too (it repairs the task's disposition after a run that ends well, it retries a
  // lost link): a turn is taken by whichever run of the task executes next, and every execution is recorded.
  const turns = new Map<string, Turn[]>();
  const executions = new Map<string, Array<{ runId: string; runtime: AdapterExecutionContext["runtime"] }>>();
  const play: Turn = async context => {
    const key = context.agent.companyId;
    executions.set(key, [...(executions.get(key) ?? []), { runId: context.runId, runtime: context.runtime }]);
    const turn = turns.get(key)?.shift();
    return turn ? turn(context) : SUCCESS;
  };
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("late-result-session-kept-");
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
  const MACHINE = { transport: "ssh", host: "mac-03", port: 22, username: "worker", remoteCwd: FOLDER };
  const paramsOf = (sessionId: string) => ({ sessionId, cwd: FOLDER, remoteExecution: MACHINE });
  /** The worker router's failure result: the ordinary session fields, with one of its four codes. */
  const routerFailure = (errorCode: string, sessionId: string | null, extra: Partial<AdapterExecutionResult> = {}): AdapterExecutionResult => ({
    exitCode: 1, signal: null, timedOut: false, errorCode, errorMessage: errorCode.replaceAll("_", " "),
    ...(sessionId ? { sessionId, sessionDisplayId: sessionId, sessionParams: paramsOf(sessionId) } : {}), ...extra });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Cut run", defaultResponsibleUserId: "responsible-user",
      issuePrefix: `C${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
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
      .map(run => [run.status, run.errorCode]),
    wakes: (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)))
      .map(wake => [wake.status, wake.reason, wake.error, wake.payload?.executionWait]),
    task: (await db.select().from(issues).where(eq(issues.id, f.issueId))).map(issue => issue.status) });
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
  /** The wake the issue update route sends to the assignee. */
  const assignmentWake = (f: Fixture) => heartbeat.wakeup(f.agentId, { source: "assignment", triggerDetail: "system",
    reason: "issue_assigned", payload: { issueId: f.issueId, mutation: "update" },
    requestedByActorType: "user", requestedByActorId: "responsible-user",
    contextSnapshot: { issueId: f.issueId, taskId: f.issueId, source: "issue.update" } });
  /** A person writes on the task: the wake of the comment route. */
  async function personMessage(f: Fixture) {
    const commentId = randomUUID();
    await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId, authorType: "user",
      authorUserId: "responsible-user", body: "Go on." });
    await heartbeat.wakeup(f.agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: "responsible-user",
      payload: { issueId: f.issueId, commentId }, contextSnapshot: { issueId: f.issueId, wakeCommentId: commentId } }).catch(() => undefined);
  }
  /**
   * What production holds about a cut run and the stand-in adapter does not write: its process is recorded and gone,
   * its lease is released. A person's request to continue needs that proof (explicit-native-continuation.ts).
   */
  async function stopProven(f: Fixture, runId: string) {
    await db.update(heartbeatRuns).set({ processPid: 2_000_000_000 }).where(eq(heartbeatRuns.id, runId));
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, agentId: f.agentId, runId, seq: 100_000,
      eventType: "native.process_identity_recorded", stream: "system", level: "info", message: "identity" });
    const environment = await environmentService(db).ensureLocalEnvironment(f.companyId);
    await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: environment.id, heartbeatRunId: runId,
      issueId: f.issueId, provider: "local", status: "expired", leasePolicy: "ephemeral", releasedAt: new Date(),
      metadata: { agentId: f.agentId, driver: "local" } });
  }
  /**
   * A first run that ends well in session `first`, then the run whose engine opened session `cut` and that ends as
   * `cutTurn` says. Returns that second run.
   */
  async function cutRun(f: Fixture, cutTurn: Turn) {
    turns.get(f.companyId)!.push(async () => ({ ...SUCCESS, sessionId: first, sessionDisplayId: first, sessionParams: paramsOf(first) }), cutTurn);
    await assignmentWake(f);
    await execution(f, 1);
    expect((await taskSession(f))?.sessionParamsJson).toMatchObject(paramsOf(first));
    // The product repairs the disposition by itself after a run that ends well; this wake joins that run or starts one.
    await assignmentWake(f);
    return (await execution(f, 2)).run;
  }
  /** What the next execution of the adapter for the task is given to resume, after `trigger`. */
  async function nextExecution(f: Fixture, trigger: () => Promise<unknown>) {
    const done = executions.get(f.companyId)!.length;
    await trigger();
    return execution(f, done + 1);
  }

  it("a lost link: the session of the failure result is kept, and the transient retry resumes it", async () => {
    const f = await seed();
    const lost = await cutRun(f, async () => routerFailure("router_provider_stop_unverified", cut));
    expect(lost).toMatchObject({ status: "failed", errorCode: "router_provider_stop_unverified", sessionIdAfter: cut });
    const kept = await taskSession(f);
    expect(kept).toMatchObject({ sessionDisplayId: cut, lastRunId: lost.id });
    expect(kept!.sessionParamsJson).toMatchObject(paramsOf(cut));
    // The server's own retry of a lost link, once its delay has passed.
    const retry = await nextExecution(f, async () => {
      const [scheduled] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        eq(heartbeatRuns.status, "scheduled_retry")));
      expect(scheduled, await state(f)).toMatchObject({ retryOfRunId: lost.id });
      await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(Date.now() - 60_000) }).where(eq(heartbeatRuns.id, scheduled!.id));
      await heartbeat.promoteDueScheduledRetries();
      await heartbeat.resumeQueuedRuns();
    });
    expect(retry.run).toMatchObject({ retryOfRunId: lost.id });
    expect(retry).toMatchObject({ sessionId: cut, sessionParams: paramsOf(cut) });
  });

  it("a pause that cancels the run: the session of its late result is kept, and the person's request after it resumes that session", async () => {
    const f = await seed();
    const cancelled = await cutRun(f, async () => {
      // The pause route stops the role's runs; the router's result comes after.
      await heartbeat.cancelActiveForAgent(f.agentId);
      return routerFailure("router_cancelled", cut);
    });
    expect(cancelled).toMatchObject({ status: "cancelled", sessionIdAfter: cut });
    const kept = await taskSession(f);
    expect(kept).toMatchObject({ sessionDisplayId: cut, lastRunId: cancelled.id });
    expect(kept!.sessionParamsJson).toMatchObject(paramsOf(cut));
    // The configuration fingerprint a finished run gets is on it.
    expect(Object.keys(kept!.sessionParamsJson ?? {}).some(key => key.startsWith("__paperclip"))).toBe(true);
    // The role is resumed and a person asks to go on: the run that continues the cut run is given that session.
    await stopProven(f, cancelled.id);
    const next = await nextExecution(f, () => personMessage(f));
    expect(next.run.contextSnapshot).toMatchObject({ previousRunId: cancelled.id });
    expect(next).toMatchObject({ sessionId: cut, sessionParams: paramsOf(cut) });
  });

  it("a run another path settled first: the session of its late result is kept", async () => {
    const f = await seed();
    const stopped = await cutRun(f, async context => {
      await heartbeat.cancelRun(context.runId, "Cancelled by the board");
      return routerFailure("router_interactive_transport_lost", cut);
    });
    expect(stopped).toMatchObject({ status: "cancelled", sessionIdAfter: cut });
    expect(await taskSession(f)).toMatchObject({ sessionDisplayId: cut, lastRunId: stopped.id });
    expect((await taskSession(f))?.sessionParamsJson).toMatchObject(paramsOf(cut));
  });

  it("a late result does not replace the session a later run of the role already wrote", async () => {
    const f = await seed();
    await cutRun(f, async context => {
      await heartbeat.cancelRun(context.runId, "Cancelled by the board");
      // Meanwhile a later run of the role on the task has ended and written its own session.
      const [later] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "succeeded",
        contextSnapshot: { issueId: f.issueId }, createdAt: new Date(Date.now() + 60_000), finishedAt: new Date() }).returning();
      await db.update(agentTaskSessions).set({ sessionParamsJson: paramsOf(other), sessionDisplayId: other, lastRunId: later!.id })
        .where(and(eq(agentTaskSessions.agentId, f.agentId), eq(agentTaskSessions.taskKey, f.issueId)));
      return routerFailure("router_cancelled", cut);
    });
    expect(await taskSession(f)).toMatchObject({ sessionDisplayId: other });
  });

  it("a late result that names no session leaves the task's session as it was", async () => {
    const f = await seed();
    const stopped = await cutRun(f, async context => {
      await heartbeat.cancelRun(context.runId, "Cancelled by the board");
      return routerFailure("router_cancelled", null);
    });
    expect(stopped).toMatchObject({ status: "cancelled", sessionIdAfter: null });
    const kept = await taskSession(f);
    expect(kept).toMatchObject({ sessionDisplayId: first });
    // Nothing was written for the late run: the row is still the first run's.
    expect(kept!.lastRunId).not.toBe(stopped.id);
  });

  it("clearSession in a failure forgets the session, also when the result comes late", async () => {
    const f = await seed();
    await cutRun(f, async () => routerFailure("router_provider_stop_unverified", null, { clearSession: true }));
    expect(await taskSession(f)).toBeNull();

    const late = await seed();
    await cutRun(late, async context => {
      await heartbeat.cancelRun(context.runId, "Cancelled by the board");
      return routerFailure("router_cancelled", null, { clearSession: true });
    });
    expect(await taskSession(late)).toBeNull();
  });

  it("another configuration: the kept session is not handed to the next run, and the run's log says so", async () => {
    const f = await seed();
    const lost = await cutRun(f, async () => routerFailure("router_provider_stop_unverified", cut));
    expect((await taskSession(f))?.sessionParamsJson).toMatchObject(paramsOf(cut));
    await db.update(agents).set({ adapterConfig: { model: "another-model" } }).where(eq(agents.id, f.agentId));
    const retry = await nextExecution(f, async () => {
      await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(Date.now() - 60_000) })
        .where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "scheduled_retry")));
      await heartbeat.promoteDueScheduledRetries();
      await heartbeat.resumeQueuedRuns();
    });
    expect(retry.run).toMatchObject({ retryOfRunId: lost.id });
    expect(retry).toMatchObject({ sessionId: null });
    expect((await heartbeat.readLog(retry.run.id)).content).toMatch(/Skipping saved session resume for task/);
  });
});
