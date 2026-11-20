import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentTaskSessions, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issues,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { runningProcesses, type AdapterExecutionContext, type AdapterExecutionResult } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";

const SUCCESS: AdapterExecutionResult = { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
  summary: "Turn.", provider: "test", model: "test-model" };
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (_context: AdapterExecutionContext): Promise<AdapterExecutionResult> => ({
    exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Turn.", provider: "test", model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })) };
});

// STUDIO-0075: production, 20 Nov 2026, 03:00 UTC. Two routed runs (claude_local, codex_local) ended
// `router_provider_stop_unverified` after the link to their worker machine was lost. Their results named no session,
// the server wrote the PREVIOUS session back, and their retries opened new conversations in the same remote folder.
// The owner's rule: a machine that loses its connection must not lose its work; the same role resumes where it was.
// Each case runs real heartbeat runs of a codex_local agent with a stand-in adapter that does what the real adapters
// now do: it tells the host the session as soon as its engine announces it, then the run is cut.
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("the session of a run that is cut", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("cut-run-session-kept-");
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
  /** What a real adapter does when its engine announces the session. */
  const announce = (context: AdapterExecutionContext, sessionId: string) =>
    context.onSessionAnnounced!({ sessionId, sessionDisplayId: sessionId, sessionParams: paramsOf(sessionId) });
  /** The failure the worker router's envelope returns for a lost link: it names no session. */
  const CUT: AdapterExecutionResult = { exitCode: 1, signal: null, timedOut: false,
    errorCode: "router_provider_stop_unverified", errorMessage: "router provider stop unverified" };

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Cut run", defaultResponsibleUserId: "responsible-user",
      issuePrefix: `C${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: "responsible-user", name: "Fixture user", email: "responsible-user@example.test",
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user",
      status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Dev Unity", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Routed task", status: "in_progress", priority: "medium",
      assigneeAgentId: agentId });
    return { companyId, agentId, issueId };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;
  const runs = (f: Fixture) => db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, f.agentId))).orderBy(asc(heartbeatRuns.createdAt));
  const taskSession = async (f: Fixture) => (await db.select().from(agentTaskSessions).where(and(
    eq(agentTaskSessions.companyId, f.companyId), eq(agentTaskSessions.agentId, f.agentId),
    eq(agentTaskSessions.taskKey, f.issueId))))[0] ?? null;
  /** One run of the role on the task, with what the engine does during it. Returns the run once it is settled. */
  async function runOnce(f: Fixture, turn: (context: AdapterExecutionContext) => Promise<AdapterExecutionResult>) {
    const before = (await runs(f)).length;
    mockAdapterExecute.mockImplementationOnce(turn);
    await heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
      payload: { issueId: f.issueId }, requestedByActorType: "user", requestedByActorId: "responsible-user",
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_commented" } });
    await vi.waitFor(async () => {
      const all = await runs(f);
      expect(all.length).toBeGreaterThan(before);
      expect(["succeeded", "failed", "cancelled", "timed_out"]).toContain(all[before]!.status);
    }, { timeout: 20_000, interval: 100 });
    const run = (await runs(f))[before]!;
    await heartbeat.waitForRunExecutionDrain(run.id);
    return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]!;
  }
  /** The session the next run of the role on the task is given to resume. */
  async function resumedByNextRun(f: Fixture) {
    let given: AdapterExecutionContext["runtime"] | null = null;
    await runOnce(f, async context => { given = context.runtime; return SUCCESS; });
    return { sessionId: given!.sessionId, sessionParams: given!.sessionParams };
  }
  /** A first run that ends well in session S0: the task's session before the cut. */
  const firstRun = (f: Fixture) => runOnce(f, async () => ({ ...SUCCESS, sessionId: "S0", sessionDisplayId: "S0", sessionParams: paramsOf("S0") }));

  it("keeps the announced session when the cut run's result names none, and the retry resumes it", async () => {
    const f = await seed();
    await firstRun(f);
    expect((await taskSession(f))?.sessionParamsJson).toMatchObject({ sessionId: "S0" });
    let duringTheRun: unknown = null;
    const cut = await runOnce(f, async context => {
      await announce(context, "S1");
      // Kept at once: a server stop now would not lose it.
      duringTheRun = (await taskSession(f))?.sessionParamsJson;
      return CUT;
    });
    expect(cut).toMatchObject({ status: "failed", errorCode: "router_provider_stop_unverified", sessionIdAfter: "S1" });
    expect(duringTheRun).toMatchObject({ sessionId: "S1" });
    const kept = await taskSession(f);
    expect(kept).toMatchObject({ sessionDisplayId: "S1", lastRunId: cut.id });
    expect(kept!.sessionParamsJson).toMatchObject(paramsOf("S1"));
    // The configuration fingerprint a finished run gets is on it.
    expect(Object.keys(kept!.sessionParamsJson ?? {}).some(key => key.startsWith("__paperclip"))).toBe(true);
    expect(await resumedByNextRun(f)).toMatchObject({ sessionId: "S1", sessionParams: paramsOf("S1") });
  });

  it("keeps the announced session when the adapter throws", async () => {
    const f = await seed();
    await firstRun(f);
    const cut = await runOnce(f, async context => { await announce(context, "S1"); throw new Error("link lost"); });
    expect(cut).toMatchObject({ status: "failed", sessionIdAfter: "S1" });
    expect((await taskSession(f))?.sessionParamsJson).toMatchObject(paramsOf("S1"));
    expect(await resumedByNextRun(f)).toMatchObject({ sessionId: "S1" });
  });

  it("keeps the announced session of a run a stop cut before its result came", async () => {
    const f = await seed();
    await firstRun(f);
    const cut = await runOnce(f, async context => {
      await announce(context, "S1");
      await heartbeat.cancelRun(context.runId, "Cancelled due to agent pause");
      return { ...CUT, errorCode: "router_cancelled", errorMessage: "router cancelled" };
    });
    expect(cut).toMatchObject({ status: "cancelled", sessionIdAfter: "S1" });
    expect((await taskSession(f))?.sessionParamsJson).toMatchObject(paramsOf("S1"));
    expect(await resumedByNextRun(f)).toMatchObject({ sessionId: "S1" });
  });

  it("keeps the announced session against a result that names another one", async () => {
    const f = await seed();
    await firstRun(f);
    const cut = await runOnce(f, async context => {
      await announce(context, "S1");
      return { ...CUT, sessionId: "R9", sessionDisplayId: "R9", sessionParams: paramsOf("R9") };
    });
    expect(cut).toMatchObject({ status: "failed", sessionIdAfter: "S1" });
    expect((await taskSession(f))?.sessionParamsJson).toMatchObject(paramsOf("S1"));
  });

  it("forgets the session when the result asks for it, also when that result comes late", async () => {
    const f = await seed();
    await firstRun(f);
    await runOnce(f, async context => { await announce(context, "S1"); return { ...CUT, clearSession: true }; });
    expect(await taskSession(f)).toBeNull();
    expect(await resumedByNextRun(f)).toMatchObject({ sessionId: null });

    const late = await seed();
    await firstRun(late);
    await runOnce(late, async context => {
      await announce(context, "S1");
      await heartbeat.cancelRun(context.runId, "Cancelled due to agent pause");
      return { ...CUT, clearSession: true };
    });
    expect(await taskSession(late)).toBeNull();
  });

  it("leaves a run that ends well to its own result", async () => {
    const f = await seed();
    await firstRun(f);
    const done = await runOnce(f, async context => {
      await announce(context, "S1");
      return { ...SUCCESS, sessionId: "S2", sessionDisplayId: "S2", sessionParams: paramsOf("S2") };
    });
    expect(done).toMatchObject({ status: "succeeded", sessionIdAfter: "S2" });
    expect((await taskSession(f))?.sessionParamsJson).toMatchObject(paramsOf("S2"));
  });

  it("keeps the previous session when the engine announced nothing before the cut", async () => {
    const f = await seed();
    await firstRun(f);
    await runOnce(f, async () => CUT);
    expect((await taskSession(f))?.sessionParamsJson).toMatchObject(paramsOf("S0"));
    await runOnce(f, async () => { throw new Error("link lost"); });
    expect((await taskSession(f))?.sessionParamsJson).toMatchObject(paramsOf("S0"));
    expect(await resumedByNextRun(f)).toMatchObject({ sessionId: "S0" });
  });

  it("does not hand the kept session to a run whose configuration changed", async () => {
    const f = await seed();
    await firstRun(f);
    await runOnce(f, async context => { await announce(context, "S1"); return CUT; });
    await db.update(agents).set({ adapterConfig: { model: "another-model" } }).where(eq(agents.id, f.agentId));
    expect(await resumedByNextRun(f)).toMatchObject({ sessionId: null });
  });
});
