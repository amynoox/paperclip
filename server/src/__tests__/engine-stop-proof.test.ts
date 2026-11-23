import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agentTaskSessions, agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, environmentLeases,
  heartbeatRunEvents, heartbeatRuns, issueComments, issues, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { runningProcesses, type AdapterExecutionContext, type AdapterExecutionResult } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { environmentService } from "../services/environments.js";
import { requestTaskRetry } from "../services/task-retry.js";
import { agentExecutionsHaveStopped } from "../services/agent-execution-stop.js";
import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import {
  ENGINE_STOP_UNPROVEN_KEY, PAUSE_CUT_ENGINE_STOP_UNPROVEN, PROVIDER_STOP_PROOF_RECORDED, hasEngineStopProof,
  markEngineStopsUnprovenAtPause, pauseCutEngineStopUnproven, readEngineStopProof, recordLiveProviderStopProof,
  verifyLiveProviderStopProof,
} from "../services/provider-stop-proof.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (_context: AdapterExecutionContext): Promise<AdapterExecutionResult> => ({
    exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Turn.", provider: "test", model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })) };
});

// STUDIO-0097. Production, 23 Nov 2026: a pause cut steered runs; the server saw the steering link end (the ssh client
// it records for the run) and took that for the engine's stop, so the run that continued the work kept the conversation
// and the folder while the engine could still write. The adapter that drives the engine hands its verified stop with
// the stop callback (the form agreed with the worker router on 15 Nov 2026); the host keeps it as an event of the run.
// Each case below runs real heartbeat runs with a stand-in adapter that does what the driving adapter does: it reports
// the link it spawned, and hands the proof (or not) to the host callback of its own execution.
const RUN = "0c3f8f4e-6f0b-4b7b-9a53-0d6a3f1c2b11";
const agreed = (runId: string, protocol = "codex_owned_v1", extra: Record<string, unknown> = {}) => ({
  schema: "paperclip.provider-stop-proof.v1", scope: "provider_and_launcher", runId, protocol, providerPid: 4321,
  providerExitCode: null, providerSignal: "SIGTERM", providerAbsent: true, launcherVerified: true,
  verifiedAt: new Date().toISOString(), ...extra });

describe("the engine stop proof: the form agreed on 15 Nov 2026", () => {
  it("is accepted field for field, with an exit code or with a signal, and only its known fields are kept", () => {
    const withSignal = verifyLiveProviderStopProof(RUN, { ...agreed(RUN), somethingElse: "dropped" });
    expect(withSignal).toMatchObject({ proof: { runId: RUN, providerPid: 4321, providerSignal: "SIGTERM", providerExitCode: null } });
    expect("proof" in withSignal && Object.keys(withSignal.proof).sort()).toEqual(["launcherVerified", "protocol", "providerAbsent",
      "providerExitCode", "providerPid", "providerSignal", "runId", "schema", "scope", "verifiedAt"]);
    expect(verifyLiveProviderStopProof(RUN, agreed(RUN, "claude_owned_v1", { providerExitCode: 0, providerSignal: null })))
      .toMatchObject({ proof: { protocol: "claude_owned_v1", providerExitCode: 0, providerSignal: null } });
  });

  it("is refused, with the name of what is wrong, for anything else", () => {
    const refused = (value: unknown, now?: Date | null) => {
      const result = verifyLiveProviderStopProof(RUN, value, now);
      return "refusal" in result ? result.refusal : "accepted";
    };
    expect(refused(undefined)).toBe("not_an_object");
    expect(refused("stopped")).toBe("not_an_object");
    expect(refused([agreed(RUN)])).toBe("not_an_object");
    expect(refused(agreed(RUN, "codex_owned_v1", { schema: "paperclip.provider-stop-proof.v0" }))).toBe("unknown_schema");
    expect(refused(agreed(RUN, "codex_owned_v1", { scope: "provider" }))).toBe("unknown_scope");
    expect(refused(agreed(randomUUID()))).toBe("another_run");
    expect(refused(agreed(RUN, "someone_else_v1"))).toBe("unknown_protocol");
    expect(refused(agreed(RUN, "codex_owned_v1", { providerAbsent: false }))).toBe("stop_not_verified");
    expect(refused(agreed(RUN, "codex_owned_v1", { launcherVerified: "true" }))).toBe("stop_not_verified");
    for (const providerPid of [0, -4, 1.5, "4321", null]) expect(refused(agreed(RUN, "codex_owned_v1", { providerPid }))).toBe("invalid_provider_pid");
    // Exactly one of the two: neither, both, or one that is not what it should be.
    expect(refused(agreed(RUN, "codex_owned_v1", { providerSignal: null }))).toBe("invalid_exit");
    expect(refused(agreed(RUN, "codex_owned_v1", { providerExitCode: 0 }))).toBe("invalid_exit");
    expect(refused(agreed(RUN, "codex_owned_v1", { providerSignal: "killed" }))).toBe("invalid_exit");
    expect(refused(agreed(RUN, "codex_owned_v1", { providerExitCode: "0", providerSignal: null }))).toBe("invalid_exit");
    expect(refused(agreed(RUN, "codex_owned_v1", { verifiedAt: "yesterday" }))).toBe("invalid_time");
    expect(refused(agreed(RUN, "codex_owned_v1", { verifiedAt: 1_700_000_000_000 }))).toBe("invalid_time");
    const later = new Date(Date.now() + 10 * 60_000).toISOString();
    expect(refused(agreed(RUN, "codex_owned_v1", { verifiedAt: later }))).toBe("time_in_the_future");
    // A proof read again was judged when it was kept.
    expect(refused(agreed(RUN, "codex_owned_v1", { verifiedAt: later }), null)).toBe("accepted");
  });
});

const SUCCESS: AdapterExecutionResult = { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
  summary: "Turn.", provider: "test", model: "test-model" };
type Turn = (context: AdapterExecutionContext) => Promise<AdapterExecutionResult>;
vi.setConfig({ testTimeout: 90_000 });
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip).each([
  { adapterType: "codex_local", protocol: "codex_owned_v1", first: "thread-first", cut: "thread-cut" },
  { adapterType: "claude_local", protocol: "claude_owned_v1", first: "11111111-1111-4111-8111-111111111111",
    cut: "22222222-2222-4222-8222-222222222222" },
])("a pause cuts a $adapterType run", ({ adapterType, protocol, first, cut }) => {
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
    database = await startEmbeddedPostgresTestDatabase("engine-stop-proof-");
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
  /** What the driving adapter returns for a run a pause cut: its failure, with the session its engine had opened. */
  const cancelledResult = (): AdapterExecutionResult => ({ exitCode: 1, signal: null, timedOut: false, errorCode: "router_cancelled",
    errorMessage: "router cancelled", sessionId: cut, sessionDisplayId: cut, sessionParams: paramsOf(cut) });
  /** The number of a process that does not exist on this host: the steering link, gone. */
  const LINK_PID = 2_000_000_000;

  async function seed(steered: boolean) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Engine stop", defaultResponsibleUserId: "responsible-user",
      issuePrefix: `E${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: "responsible-user", name: "Fixture user", email: "responsible-user@example.test",
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user",
      status: "active", membershipRole: "member" }).onConflictDoNothing();
    await db.insert(agents).values({ id: agentId, companyId, name: "Dev Unity", role: "engineer", status: "active", adapterType,
      adapterConfig: steered ? { experimentalLiveSteering: true } : {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Steered task", status: "todo", priority: "medium",
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
  async function personMessage(f: Fixture) {
    const commentId = randomUUID();
    await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId, authorType: "user",
      authorUserId: "responsible-user", body: "Go on." });
    await heartbeat.wakeup(f.agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: "responsible-user",
      payload: { issueId: f.issueId, commentId }, contextSnapshot: { issueId: f.issueId, wakeCommentId: commentId } }).catch(() => undefined);
  }
  async function nextExecution(f: Fixture, trigger: () => Promise<unknown>) {
    const done = executions.get(f.companyId)!.length;
    await trigger();
    return execution(f, done + 1);
  }
  /** The resume of the role files this Retry for the run its pause cut (pause-resume-continuation.ts writes this key). */
  const resumeRetry = async (f: Fixture, runId: string) => {
    const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "responsible-user",
      actorSource: "local_implicit", observedRunId: runId, idempotencyKey: `pause-resume:${runId}:${randomUUID()}` });
    expect(receipt).toMatchObject({ accepted: true });
    await heartbeat.resumeTaskRetry(f.companyId, receipt.requestId!);
  };
  const workspaceChoiceOf = async (f: Fixture, runId: string) => (await db.select().from(activityLog).where(and(
    eq(activityLog.companyId, f.companyId), eq(activityLog.entityId, f.issueId), eq(activityLog.runId, runId))))
    .filter(entry => entry.action === "issue.fresh_workspace_selected" || entry.action === "issue.retry_workspace_reused")
    .map(entry => [entry.action, entry.details?.mode, entry.details?.reason ?? null]);
  const folderOf = (run: { contextSnapshot: Record<string, unknown> | null }) =>
    String((run.contextSnapshot?.paperclipWorkspace as { cwd?: unknown } | undefined)?.cwd);
  const proofEventsOf = async (runId: string) => (await db.select().from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.runId, runId), eq(heartbeatRunEvents.eventType, PROVIDER_STOP_PROOF_RECORDED)))).map(event => event.payload);
  const unprovenLinesOf = async (f: Fixture) => (await db.select().from(activityLog).where(and(
    eq(activityLog.companyId, f.companyId), eq(activityLog.action, PAUSE_CUT_ENGINE_STOP_UNPROVEN))));

  /**
   * A first run that ends well in session `first`; then the run a pause cuts. The driving adapter reports the link it
   * spawned (the host records its process identity, as in production), the pause cancels the run, and `afterCut` is
   * what the adapter does before it returns: hand a proof, or nothing.
   */
  async function pauseCutRun(f: Fixture, afterCut: (context: AdapterExecutionContext) => Promise<void> = async () => undefined) {
    turns.get(f.companyId)!.push(
      async () => ({ ...SUCCESS, sessionId: first, sessionDisplayId: first, sessionParams: paramsOf(first) }),
      async context => {
        await context.onSpawn?.({ pid: LINK_PID, processGroupId: null, startedAt: new Date().toISOString() });
        await heartbeat.cancelActiveForAgent(f.agentId);
        await afterCut(context);
        return cancelledResult();
      });
    await assignmentWake(f);
    await execution(f, 1);
    await assignmentWake(f);
    const run = (await execution(f, 2)).run;
    // What the server records of the run's process is the link: its number, no group.
    expect(run, await state(f)).toMatchObject({ status: "cancelled", processGroupId: null });
    expect([LINK_PID, LINK_PID - 1]).toContain(run.processPid);
    expect(await taskSession(f)).toMatchObject({ sessionDisplayId: cut, lastRunId: run.id });
    return run;
  }
  const handsProof = (extra: Record<string, unknown> = {}) => async (context: AdapterExecutionContext) => {
    await context.onProviderStopProof?.(agreed(context.runId, protocol, extra));
  };
  /**
   * The lease the cut run held, released. `ssh`: the role's own environment, a run steered through a link of its own.
   * `local`: a run the worker router dispatched to a machine. `endedMinutesAgo`: over ssh the pause's own rule accepts
   * the link's absence ten minutes after the run ended (STUDIO-0043).
   */
  async function heldLease(f: Fixture, runId: string, provider: "ssh" | "local", endedMinutesAgo = 0) {
    const ended = new Date(Date.now() - endedMinutesAgo * 60_000);
    if (endedMinutesAgo) await db.update(heartbeatRuns).set({ finishedAt: ended }).where(eq(heartbeatRuns.id, runId));
    const environment = await environmentService(db).ensureLocalEnvironment(f.companyId);
    if (provider === "ssh") await db.delete(environmentLeases).where(eq(environmentLeases.heartbeatRunId, runId));
    await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: environment.id, heartbeatRunId: runId,
      issueId: f.issueId, provider, status: "expired", leasePolicy: "ephemeral", releasedAt: ended,
      ...(provider === "ssh" ? { providerLeaseId: `ssh://worker@mac-03:22${FOLDER}/${runId}`, cleanupStatus: "success" } : {}),
      metadata: { agentId: f.agentId, driver: provider } });
  }
  const steeredOf = async (runId: string) => (await reread(runId)).runnerProfileJson?.adapterInteractiveProtocol ?? null;
  /** The pause's own conclusion, run by the lifecycle worker's host step for an agent in `pausing`. */
  async function pauseConcludes(f: Fixture, pausedMinutesAgo: number) {
    await db.update(agents).set({ status: "paused", lifecycleState: "pausing", pausedAt: new Date(Date.now() - pausedMinutesAgo * 60_000) })
      .where(eq(agents.id, f.agentId));
    // The lifecycle worker's agent carries its lifecycle fields only: not the time it was paused.
    const [agent] = await db.select({ id: agents.id, companyId: agents.companyId, lifecycleState: agents.lifecycleState,
      lifecycleVersion: agents.lifecycleVersion, lifecycleHolds: agents.lifecycleHolds,
      lifecycleRequiredPluginIds: agents.lifecycleRequiredPluginIds, lifecycleError: agents.lifecycleError,
      lifecycleOperation: agents.lifecycleOperation }).from(agents).where(eq(agents.id, f.agentId));
    const outcome = await createLifecycleDriver(db, {} as never).runHost(agent as never);
    await db.update(agents).set({ status: "active", lifecycleState: "ready", pausedAt: null }).where(eq(agents.id, f.agentId));
    return outcome;
  }

  it("steered through a link of its own, no proof handed: the pause still concludes, the run is marked and said once on its task, and the resume starts in a new conversation and a new folder", async () => {
    const f = await seed(true);
    const cancelled = await pauseCutRun(f);
    expect(await steeredOf(cancelled.id)).toBe("adapter_interactive_v1");
    expect(await proofEventsOf(cancelled.id)).toEqual([]);
    // The run has just ended: the link's absence is not accepted yet, and there is no proof of the engine's stop.
    await heldLease(f, cancelled.id, "ssh");
    expect(await agentExecutionsHaveStopped(db, [f.agentId], { pauseStop: true })).toBe(false);
    expect(await pauseConcludes(f, 1)).toBe("pending");
    expect(await unprovenLinesOf(f)).toEqual([]);
    // Ten minutes later the pause concludes on the link's absence, as before this patch.
    await heldLease(f, cancelled.id, "ssh", 11);
    expect(await pauseCutEngineStopUnproven(db, { companyId: f.companyId, runId: cancelled.id })).toBe(true);
    expect(await pauseConcludes(f, 12)).toBe("complete");
    expect((await reread(cancelled.id)).resultJson?.[ENGINE_STOP_UNPROVEN_KEY]).toMatchObject({ version: 1, reason: "no_engine_stop_proof" });
    const lines = await unprovenLinesOf(f);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ actorType: "system", agentId: f.agentId, entityType: "issue", entityId: f.issueId,
      details: { interruptedRunId: cancelled.id, reason: "no_engine_stop_proof", leaseProviders: ["ssh"] } });
    // Where the engine ran: the environment the run's lease names, by its id, its name and its driver, and the lease.
    const environment = await environmentService(db).ensureLocalEnvironment(f.companyId);
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, cancelled.id));
    expect(lines[0]!.details).toMatchObject({ environmentIds: [environment.id],
      environments: [{ id: environment.id, name: environment.name, driver: environment.driver }], leaseIds: [lease!.id] });
    // Nothing of the lease's own address is written.
    expect(JSON.stringify(lines[0]!.details)).not.toContain("mac-03");
    // Concluded again (the worker's next tick, another pause later): nothing is said twice.
    expect(await pauseConcludes(f, 12)).toBe("complete");
    expect(await markEngineStopsUnprovenAtPause(db, { id: f.agentId, companyId: f.companyId }, new Date(0))).toBe(0);
    expect(await unprovenLinesOf(f)).toHaveLength(1);
    // The resume of the role: its Retry is admitted, and starts in a new conversation and a new isolated workspace.
    const next = await nextExecution(f, () => resumeRetry(f, cancelled.id));
    expect(next.run.contextSnapshot).toMatchObject({ previousRunId: cancelled.id, forceFreshSession: true });
    expect(next.sessionId).toBeNull();
    expect(await workspaceChoiceOf(f, next.run.id)).toEqual([["issue.fresh_workspace_selected", "fresh_isolated_workspace", "no_engine_stop_proof"]]);
    expect(folderOf(next.run)).not.toBe(folderOf(cancelled));
    expect(folderOf(next.run)).toContain("isolated-workspace-attempts");
  });

  it("steered through a link of its own, the proof handed with the stop: the pause concludes at once, nothing is marked, and the resume keeps the conversation and the folder", async () => {
    const f = await seed(true);
    const cancelled = await pauseCutRun(f, handsProof());
    expect(await steeredOf(cancelled.id)).toBe("adapter_interactive_v1");
    expect(await proofEventsOf(cancelled.id)).toMatchObject([{ schema: "paperclip.provider-stop-proof.v1", runId: cancelled.id,
      protocol, providerPid: 4321, providerSignal: "SIGTERM", providerAbsent: true, launcherVerified: true, channel: "live" }]);
    expect(await readEngineStopProof(db, f.companyId, cancelled.id)).toMatchObject({ runId: cancelled.id, providerPid: 4321 });
    // The run has just ended: no ten minutes are waited for, the engine's stop is proven.
    await heldLease(f, cancelled.id, "ssh");
    expect(await agentExecutionsHaveStopped(db, [f.agentId], { pauseStop: true })).toBe(true);
    // Only a pause concludes on it: a termination keeps the receipt of the lease's own driver.
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
    expect(await pauseCutEngineStopUnproven(db, { companyId: f.companyId, runId: cancelled.id })).toBe(false);
    expect(await pauseConcludes(f, 1)).toBe("complete");
    expect((await reread(cancelled.id)).resultJson).not.toHaveProperty(ENGINE_STOP_UNPROVEN_KEY);
    expect(await unprovenLinesOf(f)).toEqual([]);
    const next = await nextExecution(f, () => resumeRetry(f, cancelled.id));
    expect(next.run.contextSnapshot).toMatchObject({ previousRunId: cancelled.id });
    expect(next.run.contextSnapshot).not.toHaveProperty("forceFreshSession");
    expect({ sessionId: next.sessionId, sessionParams: next.sessionParams }).toMatchObject({ sessionId: cut, sessionParams: paramsOf(cut) });
    expect(await workspaceChoiceOf(f, next.run.id)).toEqual([["issue.retry_workspace_reused", "pause_resume_task_workspace", null]]);
    expect(folderOf(next.run)).toBe(folderOf(cancelled));
  });

  // A steered run cut early has often recorded no session (production, 23 Nov 2026: a role paused in the middle of
  // its first turn). Nothing here counts on one: the pause concludes on the proof, and the resume has none to resume.
  it("a cut run that recorded no session, the proof handed: the pause concludes at once and the resume starts a conversation in the same folder", async () => {
    const f = await seed(true);
    turns.get(f.companyId)!.push(async context => {
      await context.onSpawn?.({ pid: LINK_PID, processGroupId: null, startedAt: new Date().toISOString() });
      await heartbeat.cancelActiveForAgent(f.agentId);
      await handsProof()(context);
      return { exitCode: 1, signal: null, timedOut: false, errorCode: "router_cancelled", errorMessage: "router cancelled" };
    });
    await assignmentWake(f);
    const cancelled = (await execution(f, 1)).run;
    expect(cancelled).toMatchObject({ status: "cancelled" });
    expect(await taskSession(f)).toBeNull();
    await heldLease(f, cancelled.id, "ssh");
    expect(await agentExecutionsHaveStopped(db, [f.agentId], { pauseStop: true })).toBe(true);
    expect(await pauseConcludes(f, 1)).toBe("complete");
    expect(await unprovenLinesOf(f)).toEqual([]);
    const next = await nextExecution(f, () => resumeRetry(f, cancelled.id));
    expect(next.run.contextSnapshot).toMatchObject({ previousRunId: cancelled.id });
    expect(next.sessionId).toBeNull();
    expect(await workspaceChoiceOf(f, next.run.id)).toEqual([["issue.retry_workspace_reused", "pause_resume_task_workspace", null]]);
    expect(folderOf(next.run)).toBe(folderOf(cancelled));
  });

  it("a proof no longer applies once the run records a new launch: the engine launched after it is not proven stopped", async () => {
    const f = await seed(true);
    const cancelled = await pauseCutRun(f, async context => {
      // The first launch of the run stopped and was proven; the adapter then launched the engine again.
      await handsProof()(context);
      await context.onSpawn?.({ pid: LINK_PID - 1, processGroupId: null, startedAt: new Date().toISOString() });
    });
    expect(await proofEventsOf(cancelled.id)).toHaveLength(1);
    expect(await hasEngineStopProof(db, f.companyId, cancelled.id)).toBe(false);
    await heldLease(f, cancelled.id, "ssh", 11);
    expect(await pauseCutEngineStopUnproven(db, { companyId: f.companyId, runId: cancelled.id })).toBe(true);
    const next = await nextExecution(f, () => resumeRetry(f, cancelled.id));
    expect(next.run.contextSnapshot).toMatchObject({ forceFreshSession: true });
    expect(await workspaceChoiceOf(f, next.run.id)).toEqual([["issue.fresh_workspace_selected", "fresh_isolated_workspace", "no_engine_stop_proof"]]);
  });

  it("a proof that is not the agreed form, or not this run's, or older than the launch, is refused and changes nothing", async () => {
    const f = await seed(true);
    const cancelled = await pauseCutRun(f, async context => {
      await context.onProviderStopProof?.(agreed(randomUUID(), protocol));
      await context.onProviderStopProof?.(agreed(context.runId, protocol, { providerAbsent: false }));
      await context.onProviderStopProof?.("stopped");
    });
    const scope = { companyId: f.companyId, runId: cancelled.id, agentId: f.agentId };
    expect(await recordLiveProviderStopProof(db, scope, agreed(cancelled.id, protocol, { launcherVerified: false })))
      .toEqual({ recorded: false, refusal: "stop_not_verified" });
    // Verified ten minutes before the launch the run records: another launch's stop.
    const before = new Date((await reread(cancelled.id)).processStartedAt!.getTime() - 10 * 60_000).toISOString();
    expect(await recordLiveProviderStopProof(db, scope, agreed(cancelled.id, protocol, { verifiedAt: before })))
      .toEqual({ recorded: false, refusal: "older_than_the_launch" });
    // Another company's, or another agent's run: nothing is found to keep it on.
    expect(await recordLiveProviderStopProof(db, { ...scope, companyId: randomUUID() }, agreed(cancelled.id, protocol)))
      .toEqual({ recorded: false, refusal: "run_not_found" });
    expect(await proofEventsOf(cancelled.id)).toEqual([]);
    await heldLease(f, cancelled.id, "ssh", 11);
    expect(await pauseCutEngineStopUnproven(db, { companyId: f.companyId, runId: cancelled.id })).toBe(true);
    // The agreed form, handed for this run: kept.
    expect(await recordLiveProviderStopProof(db, scope, agreed(cancelled.id, protocol))).toEqual({ recorded: true });
    expect(await pauseCutEngineStopUnproven(db, { companyId: f.companyId, runId: cancelled.id })).toBe(false);
  });

  it("a run the worker router dispatched (steered, a local lease): nothing changes without a proof, and a proof handed is kept as a trace", async () => {
    for (const proven of [false, true]) {
      const f = await seed(true);
      const cancelled = await pauseCutRun(f, proven ? handsProof() : undefined);
      expect(await steeredOf(cancelled.id)).toBe("adapter_interactive_v1");
      // What the server sees of the router's final `stopped`: the proof the adapter handed, as an event of the run.
      expect(await proofEventsOf(cancelled.id)).toHaveLength(proven ? 1 : 0);
      await heldLease(f, cancelled.id, "local");
      expect(await pauseCutEngineStopUnproven(db, { companyId: f.companyId, runId: cancelled.id })).toBe(false);
      expect(await agentExecutionsHaveStopped(db, [f.agentId], { pauseStop: true })).toBe(true);
      expect(await pauseConcludes(f, 1)).toBe("complete");
      expect((await reread(cancelled.id)).resultJson).not.toHaveProperty(ENGINE_STOP_UNPROVEN_KEY);
      expect(await unprovenLinesOf(f)).toEqual([]);
      const next = await nextExecution(f, () => resumeRetry(f, cancelled.id));
      expect(next.run.contextSnapshot).not.toHaveProperty("forceFreshSession");
      expect({ sessionId: next.sessionId, sessionParams: next.sessionParams }).toMatchObject({ sessionId: cut, sessionParams: paramsOf(cut) });
      expect(await workspaceChoiceOf(f, next.run.id)).toEqual([["issue.retry_workspace_reused", "pause_resume_task_workspace", null]]);
      expect(folderOf(next.run)).toBe(folderOf(cancelled));
    }
  });

  it("a run that is not steered (an ssh lease, no live steering): nothing changes, the resume keeps the conversation and the folder", async () => {
    const f = await seed(false);
    const cancelled = await pauseCutRun(f);
    expect(await steeredOf(cancelled.id)).toBeNull();
    await heldLease(f, cancelled.id, "ssh", 11);
    expect(await pauseCutEngineStopUnproven(db, { companyId: f.companyId, runId: cancelled.id })).toBe(false);
    expect(await pauseConcludes(f, 12)).toBe("complete");
    expect((await reread(cancelled.id)).resultJson).not.toHaveProperty(ENGINE_STOP_UNPROVEN_KEY);
    expect(await unprovenLinesOf(f)).toEqual([]);
    const next = await nextExecution(f, () => resumeRetry(f, cancelled.id));
    expect(next.run.contextSnapshot).not.toHaveProperty("forceFreshSession");
    expect({ sessionId: next.sessionId, sessionParams: next.sessionParams }).toMatchObject({ sessionId: cut, sessionParams: paramsOf(cut) });
    expect(await workspaceChoiceOf(f, next.run.id)).toEqual([["issue.retry_workspace_reused", "pause_resume_task_workspace", null]]);
  });

  it("only a run this pause cut is marked: not one cut before the pause, not one a person stopped", async () => {
    const f = await seed(true);
    const cancelled = await pauseCutRun(f);
    await heldLease(f, cancelled.id, "ssh", 11);
    // The pause started after the run ended: the run is an earlier pause's.
    expect(await markEngineStopsUnprovenAtPause(db, { id: f.agentId, companyId: f.companyId }, new Date(Date.now() - 5 * 60_000))).toBe(0);
    // An agent that is not paused has no pause to speak of (its row says no time).
    expect(await markEngineStopsUnprovenAtPause(db, { id: f.agentId, companyId: f.companyId })).toBe(0);
    expect(await unprovenLinesOf(f)).toEqual([]);
    // The same run, when the pause started before it ended: marked, with the time read from the agent's row.
    await db.update(agents).set({ pausedAt: new Date(Date.now() - 12 * 60_000) }).where(eq(agents.id, f.agentId));
    expect(await markEngineStopsUnprovenAtPause(db, { id: f.agentId, companyId: f.companyId })).toBe(1);
    await db.update(agents).set({ pausedAt: null }).where(eq(agents.id, f.agentId));
    expect(await unprovenLinesOf(f)).toHaveLength(1);
    // A steered run a person stopped is not a pause's cut: its own rules apply, unchanged.
    const stopped = await seed(true);
    turns.get(stopped.companyId)!.push(async context => {
      await context.onSpawn?.({ pid: LINK_PID, processGroupId: null, startedAt: new Date().toISOString() });
      await heartbeat.cancelRun(context.runId, "Cancelled by the board",
        { resultJson: { cancelledByActorType: "user", cancelledByUserId: "responsible-user" } });
      return cancelledResult();
    });
    await assignmentWake(stopped);
    const run = (await execution(stopped, 1)).run;
    expect(run).toMatchObject({ status: "cancelled" });
    await heldLease(stopped, run.id, "ssh", 11);
    expect(await pauseCutEngineStopUnproven(db, { companyId: stopped.companyId, runId: run.id })).toBe(false);
    expect(await markEngineStopsUnprovenAtPause(db, { id: stopped.agentId, companyId: stopped.companyId }, new Date(0))).toBe(0);
  });

  // NOT covered by this patch, written down as it is: only the resume's own Retry is given a new conversation and a
  // new folder. A person who writes on the task after the pause is still answered in the kept conversation.
  it("not covered: a person's message after the pause still goes on in the conversation kept from an unproven run", async () => {
    const f = await seed(true);
    const cancelled = await pauseCutRun(f);
    await heldLease(f, cancelled.id, "ssh", 11);
    expect(await pauseCutEngineStopUnproven(db, { companyId: f.companyId, runId: cancelled.id })).toBe(true);
    const next = await nextExecution(f, () => personMessage(f));
    expect(next.run.contextSnapshot).toMatchObject({ previousRunId: cancelled.id });
    expect(next).toMatchObject({ sessionId: cut });
  });
});
