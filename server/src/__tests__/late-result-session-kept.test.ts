import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentTaskSessions, agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issues,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { runningProcesses, type AdapterExecutionContext, type AdapterExecutionResult } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";

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
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip).each([
  { adapterType: "codex_local", first: "thread-first", cut: "thread-cut", other: "thread-other" },
  { adapterType: "claude_local", first: "11111111-1111-4111-8111-111111111111", cut: "22222222-2222-4222-8222-222222222222",
    other: "33333333-3333-4333-8333-333333333333" },
])("the session a failed $adapterType run returns", ({ adapterType, first, cut, other }) => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("late-result-session-kept-");
    db = createDb(database.connectionString);
    heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => SUCCESS);
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
    return { companyId, agentId, issueId };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;
  const runs = (f: Fixture) => db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, f.agentId))).orderBy(asc(heartbeatRuns.createdAt));
  const reread = async (runId: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!;
  const taskSession = async (f: Fixture) => (await db.select().from(agentTaskSessions).where(and(
    eq(agentTaskSessions.companyId, f.companyId), eq(agentTaskSessions.agentId, f.agentId),
    eq(agentTaskSessions.taskKey, f.issueId))))[0] ?? null;
  const TERMINAL = ["succeeded", "failed", "cancelled", "timed_out"];
  /** Waits for the run after the first `before` runs of the role, settled. */
  async function settledRunAfter(f: Fixture, before: number) {
    await vi.waitFor(async () => {
      const all = await runs(f);
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
      expect(TERMINAL, JSON.stringify({ runs: all.map(run => [run.status, run.errorCode]),
        wakes: wakes.map(wake => [wake.status, wake.reason, wake.error]) })).toContain(all[before]?.status);
    }, { timeout: 12_000, interval: 100 });
    const run = (await runs(f))[before]!;
    await heartbeat.waitForRunExecutionDrain(run.id);
    return reread(run.id);
  }
  /** One run of the role on its task, as the assignment wakes it, with what the adapter does and returns. */
  async function runOnce(f: Fixture, turn: (context: AdapterExecutionContext) => Promise<AdapterExecutionResult>) {
    const before = (await runs(f)).length;
    mockAdapterExecute.mockImplementationOnce(turn);
    await heartbeat.wakeup(f.agentId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: f.issueId, mutation: "update" }, requestedByActorType: "user", requestedByActorId: "responsible-user",
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, source: "issue.update" } });
    return settledRunAfter(f, before);
  }
  /** The session the next run of the role on the task is given to resume, and that run. */
  async function nextRun(f: Fixture, start: (f: Fixture, turn: (context: AdapterExecutionContext) => Promise<AdapterExecutionResult>) => Promise<typeof heartbeatRuns.$inferSelect> = runOnce) {
    let given: AdapterExecutionContext["runtime"] | null = null;
    const run = await start(f, async context => { given = context.runtime; return SUCCESS; });
    return { run, sessionId: given!.sessionId, sessionParams: given!.sessionParams };
  }
  /** A first run that ends well: the task's session before the cut. */
  const firstRun = (f: Fixture) => runOnce(f, async () => ({ ...SUCCESS, sessionId: first, sessionDisplayId: first, sessionParams: paramsOf(first) }));

  it("a lost link: the session of the failure result is kept, and the transient retry resumes it", async () => {
    const f = await seed();
    await firstRun(f);
    const lost = await runOnce(f, async () => routerFailure("router_provider_stop_unverified", cut));
    expect(lost).toMatchObject({ status: "failed", errorCode: "router_provider_stop_unverified", sessionIdAfter: cut });
    const kept = await taskSession(f);
    expect(kept).toMatchObject({ sessionDisplayId: cut, lastRunId: lost.id });
    expect(kept!.sessionParamsJson).toMatchObject(paramsOf(cut));
    // The server's own retry of a lost link, when its delay has passed.
    const retry = await nextRun(f, async (fixture, turn) => {
      const before = (await runs(fixture)).length;
      const scheduled = (await runs(fixture)).find(run => run.status === "scheduled_retry");
      expect(scheduled, "the transient retry of the lost link").toMatchObject({ retryOfRunId: lost.id });
      mockAdapterExecute.mockImplementationOnce(turn);
      await heartbeat.promoteDueScheduledRetries(new Date(Date.now() + 15 * 60_000));
      await heartbeat.resumeQueuedRuns();
      return settledRunAfter(fixture, before - 1);
    });
    expect(retry.run).toMatchObject({ retryOfRunId: lost.id, status: "succeeded" });
    expect(retry).toMatchObject({ sessionId: cut, sessionParams: paramsOf(cut) });
  });

  it("a pause that cancels the run: the session of its late result is kept, and the next run resumes it", async () => {
    const f = await seed();
    await firstRun(f);
    const cancelled = await runOnce(f, async () => {
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
    expect(await nextRun(f)).toMatchObject({ sessionId: cut, sessionParams: paramsOf(cut) });
  });

  it("a run another path settled first: the session of its late result is kept", async () => {
    const f = await seed();
    await firstRun(f);
    const stopped = await runOnce(f, async context => {
      await heartbeat.cancelRun(context.runId, "Cancelled by the board");
      return routerFailure("router_interactive_transport_lost", cut);
    });
    expect(stopped).toMatchObject({ status: "cancelled", sessionIdAfter: cut });
    expect((await taskSession(f))?.sessionParamsJson).toMatchObject(paramsOf(cut));
    expect(await nextRun(f)).toMatchObject({ sessionId: cut });
  });

  it("a late result does not replace the session a later run of the role already wrote", async () => {
    const f = await seed();
    await firstRun(f);
    await runOnce(f, async context => {
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
    await firstRun(f);
    const stopped = await runOnce(f, async context => {
      await heartbeat.cancelRun(context.runId, "Cancelled by the board");
      return routerFailure("router_cancelled", null);
    });
    expect(stopped.status).toBe("cancelled");
    expect(await taskSession(f)).toMatchObject({ sessionDisplayId: first });
  });

  it("clearSession in a failure forgets the session, also when the result comes late", async () => {
    const f = await seed();
    await firstRun(f);
    await runOnce(f, async () => routerFailure("router_provider_stop_unverified", null, { clearSession: true }));
    expect(await taskSession(f)).toBeNull();

    const late = await seed();
    await firstRun(late);
    await runOnce(late, async context => {
      await heartbeat.cancelRun(context.runId, "Cancelled by the board");
      return routerFailure("router_cancelled", null, { clearSession: true });
    });
    expect(await taskSession(late)).toBeNull();
    expect(await nextRun(late)).toMatchObject({ sessionId: null });
  });

  it("another configuration: the kept session is not handed to the next run, and the run's log says so", async () => {
    const f = await seed();
    await firstRun(f);
    await runOnce(f, async context => {
      await heartbeat.cancelRun(context.runId, "Cancelled by the board");
      return routerFailure("router_cancelled", cut);
    });
    expect((await taskSession(f))?.sessionParamsJson).toMatchObject(paramsOf(cut));
    await db.update(agents).set({ adapterConfig: { model: "another-model" } }).where(eq(agents.id, f.agentId));
    const next = await nextRun(f);
    expect(next).toMatchObject({ sessionId: null });
    expect((await heartbeat.readLog(next.run.id)).content).toMatch(/Skipping saved session resume for task/);
  });
});
