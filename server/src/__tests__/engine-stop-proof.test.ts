import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agentTaskSessions, agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, environmentLeases,
  environments, heartbeatRunEvents, heartbeatRuns, issueComments, issues, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { runningProcesses, type AdapterExecutionContext, type AdapterExecutionResult } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { environmentService } from "../services/environments.js";
import { requestTaskRetry } from "../services/task-retry.js";
import { agentExecutionsHaveStopped } from "../services/agent-execution-stop.js";
import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import { PROCESS_IDENTITY_RECORDED } from "../services/native-local-process-stop.js";
import {
  ENGINE_STOP_UNPROVEN_KEY, PAUSE_CUT_ENGINE_STOPPED, PAUSE_CUT_ENGINE_STOP_UNPROVEN, PROVIDER_IDENTITY_ANNOUNCED,
  PROVIDER_STOP_OBSERVATION_RECORDED, PROVIDER_STOP_PROOF_RECORDED, PROVIDER_STOP_UNPROVEN_CONTINUATION,
  forgetProviderStopObservationAttempts, hasEngineStopProof, isServerReservedProviderEvent, markEngineStopsUnprovenAtPause,
  observeProviderStop, pauseCutEngineStopUnproven, readEngineStopProof, readProviderIdentityAnnouncement,
  recordLiveProviderStopProof, recordProviderIdentityAnnouncement, verifyLiveProviderStopProof,
  verifyProviderIdentityAnnouncement, verifyProviderStopObservation,
} from "../services/provider-stop-proof.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (_context: AdapterExecutionContext): Promise<AdapterExecutionResult> => ({
    exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Turn.", provider: "test", model: "test-model",
  })),
);
/** The stand-in for the driving adapter's own look at the machine, and whether the adapter has that function at all. */
const observer = vi.hoisted(() => ({ canObserve: true, read: vi.fn(async (_input: Record<string, unknown>): Promise<unknown> => null) }));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute,
    ...(observer.canObserve ? { readProviderStop: observer.read } : {}) })) };
});

// STUDIO-0097. Production, 23 Nov 2026: a pause cut steered runs; the server saw the steering link end (the ssh client
// it records for the run) and took that for the engine's stop, so the run that continued the work kept the conversation
// and the folder while the engine could still write. What proves the stop is the server's own observation of the
// machine: the adapter that drives the engine announces it while the run lives, and after the run ended the server asks
// that adapter to look at the processes of the session's account. Each case below runs real heartbeat runs with a
// stand-in adapter that does what the driving adapter does: it reports the link it spawned, announces its engine (or
// not), and answers the server's observation (or not).
const RUN = "0c3f8f4e-6f0b-4b7b-9a53-0d6a3f1c2b11";
const STARTED = "2026-11-23T10:00:00Z";
const ENGINE_PID = 4321;
const agreed = (runId: string, protocol = "codex_owned_v1", extra: Record<string, unknown> = {}) => ({
  schema: "paperclip.provider-stop-proof.v1", scope: "provider_and_launcher", runId, protocol, providerPid: ENGINE_PID,
  providerExitCode: null, providerSignal: "SIGTERM", providerAbsent: true, launcherVerified: true,
  verifiedAt: new Date().toISOString(), ...extra });
const identity = (runId: string, protocol = "codex_owned_v1", extra: Record<string, unknown> = {}) => ({
  schema: "paperclip.provider-identity.v1", runId, protocol, route: "direct", providerPid: ENGINE_PID,
  providerStartedAt: STARTED, ...extra });
const ANNOUNCED = { providerPid: ENGINE_PID, providerStartedAt: STARTED };
const ENGINE = { pid: ENGINE_PID, startedAt: STARTED, name: "codex" };
const CHILD = { pid: 4400, startedAt: "2026-11-23T10:03:20Z", name: "node" };
const observed = (runId: string, outcome: "absent" | "alive" | "unreadable", extra: Record<string, unknown> = {}) => ({
  schema: "paperclip.provider-stop-observation.v1", runId, observedAt: new Date().toISOString(), outcome, reason: null,
  engine: null, since: [], sinceCount: 0, stopped: [], ...extra });

describe("what the adapter says of its engine's stop: the form handed with the stop callback, kept as a trace", () => {
  it("is accepted field for field, with an exit code or with a signal, and only its known fields are kept", () => {
    const withSignal = verifyLiveProviderStopProof(RUN, { ...agreed(RUN), somethingElse: "dropped" });
    expect(withSignal).toMatchObject({ proof: { runId: RUN, providerPid: ENGINE_PID, providerSignal: "SIGTERM", providerExitCode: null } });
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
    expect(refused(agreed(RUN, "codex_owned_v1", { verifiedAt: later }), null)).toBe("accepted");
  });
});

describe("the engine's announcement", () => {
  it("is accepted field for field; its start time is kept in the very text given, and nothing else is kept", () => {
    const direct = verifyProviderIdentityAnnouncement(RUN, { ...identity(RUN), somethingElse: "dropped" });
    expect(direct).toEqual({ announcement: { schema: "paperclip.provider-identity.v1", runId: RUN, protocol: "codex_owned_v1",
      route: "direct", machine: null, providerPid: ENGINE_PID, providerStartedAt: STARTED } });
    expect(verifyProviderIdentityAnnouncement(RUN, identity(RUN, "claude_owned_v1", { route: "router", machine: "mac-03",
      providerStartedAt: "2026-11-23T10:00:00.250Z" }))).toMatchObject({ announcement: { route: "router", machine: "mac-03",
      providerStartedAt: "2026-11-23T10:00:00.250Z" } });
  });

  it("is refused, with the name of what is wrong, for anything else", () => {
    const refused = (value: unknown) => {
      const result = verifyProviderIdentityAnnouncement(RUN, value);
      return "refusal" in result ? result.refusal : "accepted";
    };
    expect(refused(null)).toBe("not_an_object");
    expect(refused([identity(RUN)])).toBe("not_an_object");
    expect(refused(identity(RUN, "codex_owned_v1", { schema: "paperclip.provider-identity.v0" }))).toBe("unknown_schema");
    expect(refused(identity(randomUUID()))).toBe("another_run");
    expect(refused(identity(RUN, "someone_else_v1"))).toBe("unknown_protocol");
    expect(refused(identity(RUN, "codex_owned_v1", { route: "elsewhere" }))).toBe("unknown_route");
    for (const providerPid of [0, -1, 2.5, "4321", null]) expect(refused(identity(RUN, "codex_owned_v1", { providerPid }))).toBe("invalid_provider_pid");
    for (const providerStartedAt of ["Mon Nov 23 10:00:00 2026", "2026-11-23 10:00:00", "2026-11-23T10:00:00+01:00", "2026-13-45T10:00:00Z", 1_700_000_000, null])
      expect(refused(identity(RUN, "codex_owned_v1", { providerStartedAt }))).toBe("invalid_start_time");
    expect(refused(identity(RUN, "codex_owned_v1", { machine: "mac 03; rm" }))).toBe("invalid_machine");
  });
});

describe("the observation of the machine", () => {
  const check = (value: unknown, now?: Date | null) => verifyProviderStopObservation(RUN, value, ANNOUNCED, now);
  const refused = (value: unknown, now?: Date | null) => {
    const result = check(value, now);
    return "refusal" in result ? result.refusal : "accepted";
  };

  it("is accepted in its three outcomes, and only numbers, start times, program names and a signal are kept of a process", () => {
    expect(check({ ...observed(RUN, "absent"), proof: { anything: true }, somethingElse: "dropped" })).toMatchObject({ observation: {
      outcome: "absent", engine: null, since: [], sinceCount: 0, stopped: [], announced: ANNOUNCED } });
    const alive = check(observed(RUN, "alive", { engine: { ...ENGINE, name: "/usr/local/bin/codex", arguments: "--secret" },
      since: [{ ...CHILD, cwd: "/srv/work" }], sinceCount: 1 }));
    expect(alive).toMatchObject({ observation: { outcome: "alive", engine: ENGINE, since: [CHILD], sinceCount: 1 } });
    expect(JSON.stringify(alive)).not.toMatch(/secret|srv\/work|usr\/local/);
    expect("observation" in alive && Object.keys(alive.observation).sort()).toEqual(["announced", "engine", "observedAt", "outcome",
      "reason", "runId", "schema", "since", "sinceCount", "stopped"]);
    expect(check(observed(RUN, "absent", { stopped: [{ ...ENGINE, signal: "SIGTERM" }] }))).toMatchObject({ observation: {
      outcome: "absent", stopped: [{ ...ENGINE, signal: "SIGTERM" }] } });
    expect(check(observed(RUN, "unreadable", { reason: "machine_unreachable" }))).toMatchObject({ observation: {
      outcome: "unreadable", reason: "machine_unreachable" } });
    // The whole number may be greater than what is listed, when the list is full.
    const many = Array.from({ length: 32 }, (_, index) => ({ ...CHILD, pid: 5000 + index }));
    expect(check(observed(RUN, "alive", { since: many, sinceCount: 90 }))).toMatchObject({ observation: { sinceCount: 90 } });
  });

  it("is refused, with the name of what is wrong, for anything else", () => {
    expect(refused(undefined)).toBe("not_an_object");
    expect(refused(observed(RUN, "absent", { schema: "paperclip.provider-stop-observation.v0" }))).toBe("unknown_schema");
    expect(refused(observed(randomUUID(), "absent"))).toBe("another_run");
    expect(refused({ ...observed(RUN, "absent"), outcome: "stopped" })).toBe("unknown_outcome");
    expect(refused(observed(RUN, "absent", { observedAt: "now" }))).toBe("invalid_time");
    const later = new Date(Date.now() + 10 * 60_000).toISOString();
    expect(refused(observed(RUN, "absent", { observedAt: later }))).toBe("time_in_the_future");
    expect(refused(observed(RUN, "absent", { observedAt: later }), null)).toBe("accepted");
    // The engine shown alive must be the announced one, by its number AND its start time.
    expect(refused(observed(RUN, "alive", { engine: { ...ENGINE, pid: 999 } }))).toBe("engine_is_not_the_announced_one");
    expect(refused(observed(RUN, "alive", { engine: { ...ENGINE, startedAt: "2026-11-23T11:00:00Z" } }))).toBe("engine_is_not_the_announced_one");
    expect(refused(observed(RUN, "alive", { engine: { pid: ENGINE_PID, startedAt: STARTED } }))).toBe("invalid_engine");
    expect(refused(observed(RUN, "alive", { engine: { ...ENGINE, name: "codex\nexec --token" } }))).toBe("invalid_engine");
    expect(refused(observed(RUN, "alive", { since: [{ ...CHILD, startedAt: "10:03" }], sinceCount: 1 }))).toBe("invalid_since");
    expect(refused(observed(RUN, "alive", { since: "many", sinceCount: 3 }))).toBe("invalid_since");
    expect(refused(observed(RUN, "alive", { since: Array.from({ length: 33 }, () => CHILD), sinceCount: 33 }))).toBe("invalid_since");
    expect(refused(observed(RUN, "alive", { since: [CHILD], sinceCount: 0 }))).toBe("invalid_since_count");
    expect(refused(observed(RUN, "alive", { since: [CHILD], sinceCount: 4 }))).toBe("invalid_since_count");
    expect(refused(observed(RUN, "absent", { stopped: [ENGINE] }))).toBe("invalid_stopped");
    // "absent" with something still there is no proof; "alive" with nothing there says nothing.
    expect(refused(observed(RUN, "absent", { engine: ENGINE }))).toBe("outcome_and_lists_disagree");
    expect(refused(observed(RUN, "absent", { since: [CHILD], sinceCount: 1 }))).toBe("outcome_and_lists_disagree");
    expect(refused(observed(RUN, "alive"))).toBe("outcome_and_lists_disagree");
  });

  it("the event types of an engine's identity and stop are the server's own", () => {
    for (const type of [PROVIDER_IDENTITY_ANNOUNCED, PROVIDER_STOP_PROOF_RECORDED, PROVIDER_STOP_OBSERVATION_RECORDED,
      PROVIDER_STOP_UNPROVEN_CONTINUATION, "provider.stop_anything", "provider.identity_anything"]) expect(isServerReservedProviderEvent(type)).toBe(true);
    for (const type of ["provider.event", "provider.notice", "provider.session.load", "adapter.invoke", "lifecycle"])
      expect(isServerReservedProviderEvent(type)).toBe(false);
  });
});

const SUCCESS: AdapterExecutionResult = { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
  summary: "Turn.", provider: "test", model: "test-model" };
type Turn = (context: AdapterExecutionContext) => Promise<AdapterExecutionResult>;
type Look = (input: { runId: string; announcement: Record<string, unknown>; target: Record<string, unknown>; stop: boolean; signal: AbortSignal }) => unknown;
vi.setConfig({ testTimeout: 90_000 });
/** The registry itself, not the stand-in above: the adapters the server holds by type. */
const registry = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip).each([
  { adapterType: "codex_local", protocol: "codex_owned_v1", first: "thread-first", cut: "thread-cut", after: "thread-after" },
  { adapterType: "claude_local", protocol: "claude_owned_v1", first: "11111111-1111-4111-8111-111111111111",
    cut: "22222222-2222-4222-8222-222222222222", after: "33333333-3333-4333-8333-333333333333" },
])("a pause cuts a $adapterType run", ({ adapterType, protocol, first, cut, after }) => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const turns = new Map<string, Turn[]>();
  const executions = new Map<string, Array<{ runId: string; runtime: AdapterExecutionContext["runtime"] }>>();
  /** What the machine answers for a run, and what the server asked. No entry: the machine does not answer. */
  const looks = new Map<string, Look>();
  const asked: Array<{ runId: string; stop: boolean; announcement: Record<string, unknown>; target: Record<string, unknown> }> = [];
  const askedFor = (runId: string) => asked.filter(call => call.runId === runId);
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
    setObserver(true);
    observer.read.mockImplementation(async input => {
      const call = input as Parameters<Look>[0];
      asked.push({ runId: call.runId, stop: call.stop, announcement: call.announcement, target: call.target });
      const look = looks.get(call.runId);
      return look ? look(call) : observed(call.runId, "unreadable", { reason: "machine_unreachable" });
    });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    runningProcesses.clear();
    forgetProviderStopObservationAttempts();
    setObserver(true);
  });
  afterAll(async () => { setObserver(false); await database?.cleanup(); });
  /**
   * Whether the adapter of this type has the function the server looks with. The server finds it on the adapter the
   * registry holds for the agent's type (`getServerAdapter(type).readProviderStop`): it is put on, or taken off, that
   * very object, and on the stand-in that runs the turns.
   */
  function setObserver(on: boolean) {
    observer.canObserve = on;
    const registered = registry.getServerAdapter(adapterType) as { readProviderStop?: unknown };
    if (on) registered.readProviderStop = observer.read;
    else delete registered.readProviderStop;
  }

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
    // The role's own environment: the machine the server reaches by ssh, where its engine runs.
    const [machine] = await db.insert(environments).values({ name: `Role machine ${companyId.slice(0, 8)}`, driver: "ssh",
      config: { host: "mac-03", port: 22, username: "worker", remoteWorkspacePath: FOLDER } }).returning();
    turns.set(companyId, []);
    executions.set(companyId, []);
    return { companyId, agentId, issueId, machine: machine! };
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
  const eventsOf = async (runId: string, eventType: string) => (await db.select().from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.runId, runId), eq(heartbeatRunEvents.eventType, eventType))).orderBy(asc(heartbeatRunEvents.seq)))
    .map(event => event.payload);
  const linesOf = async (f: Fixture, action: string) => (await db.select().from(activityLog).where(and(
    eq(activityLog.companyId, f.companyId), eq(activityLog.action, action))));
  const unprovenLinesOf = (f: Fixture) => linesOf(f, PAUSE_CUT_ENGINE_STOP_UNPROVEN);

  /**
   * A first run that ends well in session `first`; then the run a pause cuts. The driving adapter reports the link it
   * spawned (the host records its process identity, as in production), announces its engine (unless `announce` is
   * false), the pause cancels the run, and `afterCut` is what the adapter does before it returns.
   */
  async function pauseCutRun(f: Fixture, options: { announce?: boolean; afterCut?: (context: AdapterExecutionContext) => Promise<void> } = {}) {
    turns.get(f.companyId)!.push(
      async () => ({ ...SUCCESS, sessionId: first, sessionDisplayId: first, sessionParams: paramsOf(first) }),
      async context => {
        await context.onSpawn?.({ pid: LINK_PID, processGroupId: null, startedAt: new Date().toISOString() });
        if (options.announce !== false) await context.onProviderIdentity?.(identity(context.runId, protocol));
        await heartbeat.cancelActiveForAgent(f.agentId);
        await options.afterCut?.(context);
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
  /**
   * The lease the cut run held, released. `ssh`: the role's own environment, a run steered through a link of its own.
   * `local`: a run the worker router dispatched to a machine. `endedSecondsAgo`: when the run ended (over ssh the
   * pause's own rule accepts the link's absence ten minutes after that, STUDIO-0043; the engine is given its grace).
   */
  async function heldLease(f: Fixture, runId: string, provider: "ssh" | "local", endedSecondsAgo = 0) {
    const ended = new Date(Date.now() - endedSecondsAgo * 1000);
    if (endedSecondsAgo) await db.update(heartbeatRuns).set({ finishedAt: ended }).where(eq(heartbeatRuns.id, runId));
    const environmentId = provider === "ssh" ? f.machine.id : (await environmentService(db).ensureLocalEnvironment(f.companyId)).id;
    if (provider === "ssh") await db.delete(environmentLeases).where(eq(environmentLeases.heartbeatRunId, runId));
    await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId, heartbeatRunId: runId,
      issueId: f.issueId, provider, status: "expired", leasePolicy: "ephemeral", releasedAt: ended,
      ...(provider === "ssh" ? { providerLeaseId: `ssh://worker@mac-03:22${FOLDER}/${runId}`, cleanupStatus: "success" } : {}),
      metadata: { agentId: f.agentId, driver: provider, ...(provider === "ssh" ? { remoteCwd: FOLDER } : {}) } });
  }
  const ELEVEN_MINUTES = 11 * 60;
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
  const scopeOf = (f: Fixture, runId: string) => ({ companyId: f.companyId, runId });

  it("the machine observed, nothing left: the pause concludes within seconds, nothing is marked, and the work goes on in the same conversation and the same folder", async () => {
    const f = await seed(true);
    const cancelled = await pauseCutRun(f);
    expect(await steeredOf(cancelled.id)).toBe("adapter_interactive_v1");
    // The server kept the engine's announcement, as an event of the run.
    expect(await eventsOf(cancelled.id, PROVIDER_IDENTITY_ANNOUNCED)).toMatchObject([{ ...identity(cancelled.id, protocol), machine: null, channel: "live" }]);
    looks.set(cancelled.id, input => observed(input.runId, "absent"));
    await heldLease(f, cancelled.id, "ssh");
    // The run has just ended: no ten minutes are waited for. The pause's own reading asks the machine and concludes.
    expect(await agentExecutionsHaveStopped(db, [f.agentId], { pauseStop: true })).toBe(true);
    expect(Date.now() - (await reread(cancelled.id)).finishedAt!.getTime()).toBeLessThan(10_000);
    // What the adapter was asked: this run, the announcement as the server kept it, the role's own machine, and no stop
    // (the engine is still in the grace it is given).
    expect(askedFor(cancelled.id)).toEqual([{ runId: cancelled.id, stop: false,
      announcement: { ...identity(cancelled.id, protocol), machine: null },
      target: expect.objectContaining({ kind: "remote", transport: "ssh", environmentId: f.machine.id, remoteCwd: FOLDER,
        spec: expect.objectContaining({ host: "mac-03", username: "worker" }) }) }]);
    expect(await eventsOf(cancelled.id, PROVIDER_STOP_OBSERVATION_RECORDED)).toMatchObject([{ outcome: "absent", engine: null,
      since: [], sinceCount: 0, stopped: [], announced: ANNOUNCED, channel: "observation" }]);
    expect(await readEngineStopProof(db, f.companyId, cancelled.id)).toMatchObject({ runId: cancelled.id, outcome: "absent" });
    // Proven once: the machine is not asked again.
    expect(await agentExecutionsHaveStopped(db, [f.agentId], { pauseStop: true })).toBe(true);
    expect(askedFor(cancelled.id)).toHaveLength(1);
    // Only a pause concludes on it: a termination keeps the receipt of the lease's own driver.
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
    expect(await pauseCutEngineStopUnproven(db, scopeOf(f, cancelled.id))).toBe(false);
    expect(await pauseConcludes(f, 1)).toBe("complete");
    expect((await reread(cancelled.id)).resultJson).not.toHaveProperty(ENGINE_STOP_UNPROVEN_KEY);
    expect(await unprovenLinesOf(f)).toEqual([]);
    // The resume of the role: its Retry goes on in the conversation and the folder of the cut run.
    const next = await nextExecution(f, () => resumeRetry(f, cancelled.id));
    expect(next.run.contextSnapshot).toMatchObject({ previousRunId: cancelled.id });
    expect(next.run.contextSnapshot).not.toHaveProperty("forceFreshSession");
    expect(next.run.contextSnapshot).not.toHaveProperty("engineStopUnprovenRunId");
    expect({ sessionId: next.sessionId, sessionParams: next.sessionParams }).toMatchObject({ sessionId: cut, sessionParams: paramsOf(cut) });
    expect(await workspaceChoiceOf(f, next.run.id)).toEqual([["issue.retry_workspace_reused", "pause_resume_task_workspace", null]]);
    expect(folderOf(next.run)).toBe(folderOf(cancelled));
    expect(await eventsOf(next.run.id, PROVIDER_STOP_UNPROVEN_CONTINUATION)).toEqual([]);
  });

  it("the machine observed, nothing left: a person's message after the pause goes on in the same conversation too", async () => {
    const f = await seed(true);
    const cancelled = await pauseCutRun(f);
    looks.set(cancelled.id, input => observed(input.runId, "absent"));
    await heldLease(f, cancelled.id, "ssh");
    expect(await pauseConcludes(f, 1)).toBe("complete");
    const next = await nextExecution(f, () => personMessage(f));
    expect(next).toMatchObject({ sessionId: cut });
    expect(next.run.contextSnapshot).not.toHaveProperty("engineStopUnprovenRunId");
    expect(await workspaceChoiceOf(f, next.run.id)).toEqual([]);
    expect(folderOf(next.run)).toBe(folderOf(cancelled));
  });

  it("the machine does not answer: the pause concludes ten minutes later as before, the run is marked and said once on its task, and the resume starts in a new conversation and a new folder", async () => {
    const f = await seed(true);
    const cancelled = await pauseCutRun(f);
    await heldLease(f, cancelled.id, "ssh");
    // The run has just ended: the link's absence is not accepted yet, and the machine proves nothing.
    expect(await agentExecutionsHaveStopped(db, [f.agentId], { pauseStop: true })).toBe(false);
    expect(await pauseConcludes(f, 1)).toBe("pending");
    expect(await unprovenLinesOf(f)).toEqual([]);
    // A state read again and again asks the machine once, then leaves it the delay before the next question.
    expect(askedFor(cancelled.id)).toHaveLength(1);
    expect(await eventsOf(cancelled.id, PROVIDER_STOP_OBSERVATION_RECORDED)).toMatchObject([{ outcome: "unreadable", reason: "machine_unreachable" }]);
    expect(await hasEngineStopProof(db, f.companyId, cancelled.id)).toBe(false);
    // Ten minutes later the pause concludes on the link's absence, as before this patch.
    forgetProviderStopObservationAttempts();
    await heldLease(f, cancelled.id, "ssh", ELEVEN_MINUTES);
    expect(await pauseCutEngineStopUnproven(db, scopeOf(f, cancelled.id))).toBe(true);
    expect(await pauseConcludes(f, 12)).toBe("complete");
    expect((await reread(cancelled.id)).resultJson?.[ENGINE_STOP_UNPROVEN_KEY]).toMatchObject({ version: 1, reason: "no_engine_stop_proof" });
    const lines = await unprovenLinesOf(f);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ actorType: "system", agentId: f.agentId, entityType: "issue", entityId: f.issueId,
      details: { interruptedRunId: cancelled.id, reason: "no_engine_stop_proof", leaseProviders: ["ssh"] } });
    // Where the engine ran: the environment the run's lease names, by its id, its name and its driver, and the lease.
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, cancelled.id));
    expect(lines[0]!.details).toMatchObject({ environmentIds: [f.machine.id],
      environments: [{ id: f.machine.id, name: f.machine.name, driver: "ssh" }], leaseIds: [lease!.id] });
    // Nothing of the machine's own address is written.
    expect(JSON.stringify(lines[0]!.details)).not.toContain("mac-03");
    // Concluded again (the worker's next tick, another pause later): nothing is said twice.
    expect(await pauseConcludes(f, 12)).toBe("complete");
    expect(await markEngineStopsUnprovenAtPause(db, { id: f.agentId, companyId: f.companyId }, new Date(0))).toBe(0);
    expect(await unprovenLinesOf(f)).toHaveLength(1);
    // The resume of the role: its Retry is admitted, the machine is asked once more, and the run starts in a new
    // conversation and a new isolated workspace.
    forgetProviderStopObservationAttempts();
    const before = askedFor(cancelled.id).length;
    const next = await nextExecution(f, () => resumeRetry(f, cancelled.id));
    expect(askedFor(cancelled.id).length).toBeGreaterThan(before);
    expect(next.sessionId).toBeNull();
    expect(await eventsOf(next.run.id, PROVIDER_STOP_UNPROVEN_CONTINUATION)).toMatchObject([{ cutRunId: cancelled.id,
      leaseIds: [lease!.id], reason: "no_engine_stop_proof", channel: "decision" }]);
    expect(await workspaceChoiceOf(f, next.run.id)).toEqual([["issue.fresh_workspace_selected", "fresh_isolated_workspace", "no_engine_stop_proof"]]);
    expect(folderOf(next.run)).not.toBe(folderOf(cancelled));
    expect(folderOf(next.run)).toContain("isolated-workspace-attempts");
  });

  it("no proof: a person's message after the pause does not go on in the cut run's conversation nor in its folder, and the run after that one stays in the new folder", async () => {
    const f = await seed(true);
    const cancelled = await pauseCutRun(f);
    await heldLease(f, cancelled.id, "ssh", ELEVEN_MINUTES);
    // The cut run is not marked yet: its pause did not go through the agent's lifecycle (a budget stop, for one).
    expect((await reread(cancelled.id)).resultJson).not.toHaveProperty(ENGINE_STOP_UNPROVEN_KEY);
    turns.get(f.companyId)!.push(async () => ({ ...SUCCESS, sessionId: after, sessionDisplayId: after, sessionParams: paramsOf(after) }));
    const next = await nextExecution(f, () => personMessage(f));
    expect(next.sessionId).toBeNull();
    expect(next.run.contextSnapshot).toMatchObject({ engineStopUnprovenRunId: cancelled.id });
    expect(await eventsOf(next.run.id, PROVIDER_STOP_UNPROVEN_CONTINUATION)).toMatchObject([{ cutRunId: cancelled.id, channel: "decision" }]);
    expect(await workspaceChoiceOf(f, next.run.id)).toEqual([["issue.fresh_workspace_selected", "fresh_isolated_workspace", "no_engine_stop_proof"]]);
    expect(folderOf(next.run)).not.toBe(folderOf(cancelled));
    // The mark and its line are written here at the latest, once.
    expect((await reread(cancelled.id)).resultJson?.[ENGINE_STOP_UNPROVEN_KEY]).toMatchObject({ reason: "no_engine_stop_proof" });
    expect(await unprovenLinesOf(f)).toHaveLength(1);
    // The new run's own conversation is the task's from now on.
    expect(await taskSession(f)).toMatchObject({ sessionDisplayId: after, lastRunId: next.run.id });
    // The run after that one is not judged again, nor sent to yet another folder: it works where the new run worked.
    // (Which conversation it opens is the product's own rule after a change of workspace mode, unchanged here.)
    const third = await nextExecution(f, () => personMessage(f));
    expect(await eventsOf(third.run.id, PROVIDER_STOP_UNPROVEN_CONTINUATION)).toEqual([]);
    expect(third.run.contextSnapshot).not.toHaveProperty("engineStopUnprovenRunId");
    expect(await workspaceChoiceOf(f, third.run.id)).toEqual([]);
    expect(folderOf(third.run)).toBe(folderOf(next.run));
    expect(await unprovenLinesOf(f)).toHaveLength(1);
  });

  it("the engine is found alive: left alone during its grace, stopped after it, and what was stopped is said on the task; the pause then concludes and the conversation is kept", async () => {
    const f = await seed(true);
    const cancelled = await pauseCutRun(f);
    looks.set(cancelled.id, input => input.stop
      ? observed(input.runId, "absent", { stopped: [{ ...ENGINE, signal: "SIGTERM" }, { ...CHILD, signal: "SIGKILL" }] })
      : observed(input.runId, "alive", { engine: ENGINE }));
    await heldLease(f, cancelled.id, "ssh");
    // Just ended: the engine is seen alive, nothing is stopped, the pause waits.
    expect(await agentExecutionsHaveStopped(db, [f.agentId], { pauseStop: true })).toBe(false);
    expect(askedFor(cancelled.id).map(call => call.stop)).toEqual([false]);
    expect(await linesOf(f, PAUSE_CUT_ENGINE_STOPPED)).toEqual([]);
    // Read again at once: the machine is not asked before the delay between two questions.
    expect(await agentExecutionsHaveStopped(db, [f.agentId], { pauseStop: true })).toBe(false);
    expect(askedFor(cancelled.id)).toHaveLength(1);
    // Half a minute after the run ended (the grace is twenty seconds): the adapter is asked to stop the announced engine.
    forgetProviderStopObservationAttempts();
    await heldLease(f, cancelled.id, "ssh", 30);
    expect(await agentExecutionsHaveStopped(db, [f.agentId], { pauseStop: true })).toBe(true);
    expect(askedFor(cancelled.id).map(call => call.stop)).toEqual([false, true]);
    const stoppedLines = await linesOf(f, PAUSE_CUT_ENGINE_STOPPED);
    expect(stoppedLines).toHaveLength(1);
    expect(stoppedLines[0]).toMatchObject({ actorType: "system", agentId: f.agentId, entityType: "issue", entityId: f.issueId,
      details: { interruptedRunId: cancelled.id, engineStopProven: true, outcomeAfter: "absent",
        stopped: [{ ...ENGINE, signal: "SIGTERM" }, { ...CHILD, signal: "SIGKILL" }] } });
    expect(await pauseConcludes(f, 1)).toBe("complete");
    expect(await unprovenLinesOf(f)).toEqual([]);
    const next = await nextExecution(f, () => resumeRetry(f, cancelled.id));
    expect(next).toMatchObject({ sessionId: cut });
    expect(folderOf(next.run)).toBe(folderOf(cancelled));
  });

  it("the engine is gone but a process of the account was born since it started: no proof, whatever was stopped", async () => {
    const f = await seed(true);
    const cancelled = await pauseCutRun(f);
    looks.set(cancelled.id, input => observed(input.runId, "alive", { since: [CHILD], sinceCount: 1,
      ...(input.stop ? { stopped: [{ ...ENGINE, signal: "SIGTERM" }] } : {}) }));
    await heldLease(f, cancelled.id, "ssh", 30);
    expect(await agentExecutionsHaveStopped(db, [f.agentId], { pauseStop: true })).toBe(false);
    expect(askedFor(cancelled.id).map(call => call.stop)).toEqual([true]);
    expect(await hasEngineStopProof(db, f.companyId, cancelled.id)).toBe(false);
    expect(await eventsOf(cancelled.id, PROVIDER_STOP_OBSERVATION_RECORDED)).toMatchObject([{ outcome: "alive", engine: null,
      since: [CHILD], sinceCount: 1 }]);
    // What was stopped is said all the same, with what is left.
    expect(await linesOf(f, PAUSE_CUT_ENGINE_STOPPED)).toMatchObject([{ details: { engineStopProven: false, outcomeAfter: "alive" } }]);
    forgetProviderStopObservationAttempts();
    await heldLease(f, cancelled.id, "ssh", ELEVEN_MINUTES);
    expect(await pauseConcludes(f, 12)).toBe("complete");
    expect(await unprovenLinesOf(f)).toHaveLength(1);
    const next = await nextExecution(f, () => personMessage(f));
    expect(next.sessionId).toBeNull();
    expect(folderOf(next.run)).not.toBe(folderOf(cancelled));
  });

  it("what the adapter itself says at the stop proves nothing: it is kept as a trace, and the pause still waits for the observation", async () => {
    const f = await seed(true);
    const cancelled = await pauseCutRun(f, { afterCut: async context => {
      await context.onProviderStopProof?.(agreed(context.runId, protocol));
      // Not the agreed form, or not this run's: refused, nothing kept.
      await context.onProviderStopProof?.(agreed(randomUUID(), protocol));
      await context.onProviderStopProof?.(agreed(context.runId, protocol, { providerAbsent: false }));
      await context.onProviderStopProof?.("stopped");
    } });
    expect(await eventsOf(cancelled.id, PROVIDER_STOP_PROOF_RECORDED)).toMatchObject([{ schema: "paperclip.provider-stop-proof.v1",
      runId: cancelled.id, protocol, providerPid: ENGINE_PID, providerSignal: "SIGTERM", channel: "live" }]);
    expect(await recordLiveProviderStopProof(db, { ...scopeOf(f, cancelled.id), agentId: f.agentId },
      agreed(cancelled.id, protocol, { launcherVerified: false }))).toEqual({ recorded: false, refusal: "stop_not_verified" });
    await heldLease(f, cancelled.id, "ssh");
    expect(await hasEngineStopProof(db, f.companyId, cancelled.id)).toBe(false);
    expect(await agentExecutionsHaveStopped(db, [f.agentId], { pauseStop: true })).toBe(false);
    expect(await pauseCutEngineStopUnproven(db, scopeOf(f, cancelled.id))).toBe(true);
  });

  it("an adapter cannot write the announcement, the observation or the decision through its own events", async () => {
    const f = await seed(true);
    const cancelled = await pauseCutRun(f, { announce: false, afterCut: async context => {
      await context.onEvent?.({ eventType: PROVIDER_IDENTITY_ANNOUNCED, stream: "system", level: "info", message: "forged",
        payload: { ...identity(context.runId, protocol), machine: null, channel: "live" } });
      await context.onEvent?.({ eventType: PROVIDER_STOP_OBSERVATION_RECORDED, stream: "system", level: "info", message: "forged",
        payload: { ...observed(context.runId, "absent"), announced: ANNOUNCED, channel: "observation" } });
      await context.onEvent?.({ eventType: ` ${PROVIDER_STOP_PROOF_RECORDED} `, stream: "system", level: "info", message: "forged",
        payload: { ...agreed(context.runId, protocol), channel: "live" } });
      await context.onEvent?.({ eventType: "provider.notice", stream: "system", level: "info", message: "an adapter's own event" });
    } });
    for (const type of [PROVIDER_IDENTITY_ANNOUNCED, PROVIDER_STOP_OBSERVATION_RECORDED, PROVIDER_STOP_PROOF_RECORDED])
      expect(await eventsOf(cancelled.id, type)).toEqual([]);
    expect(await eventsOf(cancelled.id, "provider.notice")).toHaveLength(1);
    await heldLease(f, cancelled.id, "ssh");
    expect(await readProviderIdentityAnnouncement(db, f.companyId, cancelled.id)).toBeNull();
    expect(await hasEngineStopProof(db, f.companyId, cancelled.id)).toBe(false);
  });

  it("no announcement, or an adapter that cannot observe: the machine is not asked, and there is no proof", async () => {
    const f = await seed(true);
    const cancelled = await pauseCutRun(f, { announce: false });
    looks.set(cancelled.id, input => observed(input.runId, "absent"));
    await heldLease(f, cancelled.id, "ssh", 30);
    expect(await agentExecutionsHaveStopped(db, [f.agentId], { pauseStop: true })).toBe(false);
    expect(askedFor(cancelled.id)).toEqual([]);
    expect(await eventsOf(cancelled.id, PROVIDER_STOP_OBSERVATION_RECORDED)).toEqual([]);
    // An announcement that is not the agreed form is refused, and changes nothing.
    const scope = { ...scopeOf(f, cancelled.id), agentId: f.agentId };
    expect(await recordProviderIdentityAnnouncement(db, scope, identity(cancelled.id, protocol, { providerPid: "4321" })))
      .toEqual({ recorded: false, refusal: "invalid_provider_pid" });
    expect(await recordProviderIdentityAnnouncement(db, scope, identity(randomUUID(), protocol))).toEqual({ recorded: false, refusal: "another_run" });
    expect(await observeProviderStop(db, scopeOf(f, cancelled.id), { force: true })).toBe(false);
    expect(askedFor(cancelled.id)).toEqual([]);
    // Announced, but the adapter in service has no function to look with: as before.
    expect(await recordProviderIdentityAnnouncement(db, scope, identity(cancelled.id, protocol))).toEqual({ recorded: true });
    setObserver(false);
    expect(await observeProviderStop(db, scopeOf(f, cancelled.id), { force: true })).toBe(false);
    expect(askedFor(cancelled.id)).toEqual([]);
    expect(await pauseCutEngineStopUnproven(db, scopeOf(f, cancelled.id))).toBe(true);
    // With the function, the same run is proven.
    setObserver(true);
    expect(await observeProviderStop(db, scopeOf(f, cancelled.id), { force: true })).toBe(true);
  });

  it("an observation proves the stop of the engine it is about, and of that one only", async () => {
    const f = await seed(true);
    const cancelled = await pauseCutRun(f);
    await heldLease(f, cancelled.id, "ssh", 30);
    const scope = scopeOf(f, cancelled.id);
    const ask = () => observeProviderStop(db, scope, { force: true });
    // An answer for another run, an engine that is not the announced one, an answer that throws or never comes.
    looks.set(cancelled.id, () => observed(randomUUID(), "absent"));
    expect(await ask()).toBe(false);
    looks.set(cancelled.id, input => observed(input.runId, "alive", { engine: { ...ENGINE, pid: 999 } }));
    expect(await ask()).toBe(false);
    looks.set(cancelled.id, () => { throw new Error("the adapter failed"); });
    expect(await ask()).toBe(false);
    looks.set(cancelled.id, () => new Promise(() => undefined));
    expect(await observeProviderStop(db, scope, { force: true, timeoutMs: 200 })).toBe(false);
    // An observation dated before the run ended is not of this stop.
    looks.set(cancelled.id, input => observed(input.runId, "absent", { observedAt: new Date(Date.now() - 10 * 60_000).toISOString() }));
    expect(await ask()).toBe(false);
    expect(await eventsOf(cancelled.id, PROVIDER_STOP_OBSERVATION_RECORDED)).toEqual([]);
    // An event of that type that the server's observation did not write (no channel) is not read as one.
    await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: cancelled.id, agentId: f.agentId,
      eventType: PROVIDER_STOP_OBSERVATION_RECORDED, stream: "system", level: "info", message: "written by something else",
      payload: { ...observed(cancelled.id, "absent"), announced: ANNOUNCED } });
    expect(await hasEngineStopProof(db, f.companyId, cancelled.id)).toBe(false);
    looks.set(cancelled.id, input => observed(input.runId, "absent"));
    expect(await ask()).toBe(true);
    expect(await hasEngineStopProof(db, f.companyId, cancelled.id)).toBe(true);
    // The run then announces another engine (a new launch): the earlier observation does not prove ITS stop.
    const agent = { ...scope, agentId: f.agentId };
    expect(await recordProviderIdentityAnnouncement(db, agent, identity(cancelled.id, protocol, { providerPid: 7777 }))).toEqual({ recorded: true });
    expect(await hasEngineStopProof(db, f.companyId, cancelled.id)).toBe(false);
    looks.set(cancelled.id, input => observed(input.runId, "alive", { engine: { ...ENGINE, pid: 7777 } }));
    expect(await ask()).toBe(false);
    expect(askedFor(cancelled.id).at(-1)).toMatchObject({ announcement: { providerPid: 7777 } });
    looks.set(cancelled.id, input => observed(input.runId, "absent"));
    expect(await ask()).toBe(true);
    // A launch the run records after it voids it as well.
    await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: cancelled.id, agentId: f.agentId,
      eventType: PROCESS_IDENTITY_RECORDED, stream: "system", level: "info", message: "a new launch", payload: {} });
    expect(await hasEngineStopProof(db, f.companyId, cancelled.id)).toBe(false);
  });

  it("a run the worker router dispatched (steered, a local lease): nothing changes, and the machine is never asked", async () => {
    const f = await seed(true);
    const cancelled = await pauseCutRun(f);
    expect(await steeredOf(cancelled.id)).toBe("adapter_interactive_v1");
    looks.set(cancelled.id, input => observed(input.runId, "alive", { engine: ENGINE }));
    await heldLease(f, cancelled.id, "local", 30);
    expect(await pauseCutEngineStopUnproven(db, scopeOf(f, cancelled.id))).toBe(false);
    expect(await agentExecutionsHaveStopped(db, [f.agentId], { pauseStop: true })).toBe(true);
    expect(await observeProviderStop(db, scopeOf(f, cancelled.id), { force: true })).toBe(false);
    expect(await pauseConcludes(f, 1)).toBe("complete");
    expect((await reread(cancelled.id)).resultJson).not.toHaveProperty(ENGINE_STOP_UNPROVEN_KEY);
    expect(await unprovenLinesOf(f)).toEqual([]);
    const next = await nextExecution(f, () => resumeRetry(f, cancelled.id));
    expect(next.run.contextSnapshot).not.toHaveProperty("forceFreshSession");
    expect({ sessionId: next.sessionId, sessionParams: next.sessionParams }).toMatchObject({ sessionId: cut, sessionParams: paramsOf(cut) });
    expect(await workspaceChoiceOf(f, next.run.id)).toEqual([["issue.retry_workspace_reused", "pause_resume_task_workspace", null]]);
    expect(folderOf(next.run)).toBe(folderOf(cancelled));
    expect(askedFor(cancelled.id)).toEqual([]);
  });

  it("a run that is not steered (an ssh lease, no live steering): nothing changes, the resume keeps the conversation and the folder", async () => {
    const f = await seed(false);
    const cancelled = await pauseCutRun(f, { announce: false });
    expect(await steeredOf(cancelled.id)).toBeNull();
    await heldLease(f, cancelled.id, "ssh", ELEVEN_MINUTES);
    expect(await pauseCutEngineStopUnproven(db, scopeOf(f, cancelled.id))).toBe(false);
    expect(await pauseConcludes(f, 12)).toBe("complete");
    expect((await reread(cancelled.id)).resultJson).not.toHaveProperty(ENGINE_STOP_UNPROVEN_KEY);
    expect(await unprovenLinesOf(f)).toEqual([]);
    const next = await nextExecution(f, () => resumeRetry(f, cancelled.id));
    expect(next.run.contextSnapshot).not.toHaveProperty("forceFreshSession");
    expect({ sessionId: next.sessionId, sessionParams: next.sessionParams }).toMatchObject({ sessionId: cut, sessionParams: paramsOf(cut) });
    expect(await workspaceChoiceOf(f, next.run.id)).toEqual([["issue.retry_workspace_reused", "pause_resume_task_workspace", null]]);
    expect(askedFor(cancelled.id)).toEqual([]);
  });

  it("only a run this pause cut is marked: not one cut before the pause, not one a person stopped", async () => {
    const f = await seed(true);
    const cancelled = await pauseCutRun(f);
    await heldLease(f, cancelled.id, "ssh", ELEVEN_MINUTES);
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
    // A steered run a person stopped is not a pause's cut: its own rules apply, unchanged, and the machine is not asked.
    const stopped = await seed(true);
    turns.get(stopped.companyId)!.push(async context => {
      await context.onSpawn?.({ pid: LINK_PID, processGroupId: null, startedAt: new Date().toISOString() });
      await context.onProviderIdentity?.(identity(context.runId, protocol));
      await heartbeat.cancelRun(context.runId, "Cancelled by the board",
        { resultJson: { cancelledByActorType: "user", cancelledByUserId: "responsible-user" } });
      return cancelledResult();
    });
    await assignmentWake(stopped);
    const run = (await execution(stopped, 1)).run;
    expect(run).toMatchObject({ status: "cancelled" });
    await heldLease(stopped, run.id, "ssh", ELEVEN_MINUTES);
    expect(await pauseCutEngineStopUnproven(db, scopeOf(stopped, run.id))).toBe(false);
    expect(await observeProviderStop(db, scopeOf(stopped, run.id), { force: true })).toBe(false);
    expect(askedFor(run.id)).toEqual([]);
    expect(await markEngineStopsUnprovenAtPause(db, { id: stopped.agentId, companyId: stopped.companyId }, new Date(0))).toBe(0);
  });
});
