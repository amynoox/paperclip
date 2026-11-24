import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  agents, agentTaskSessions, environmentLeases, environments, heartbeatRunEvents, heartbeatRuns, type Db,
} from "@paperclipai/db";
import { getServerAdapter } from "../adapters/index.js";
import { logger } from "../middleware/logger.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { adapterExecutionControls } from "./adapter-execution-control.js";
import { isGovernancePauseStop } from "./governance-pause-stop.js";
import { resolveEnvironmentExecutionTarget } from "./environment-execution-target.js";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "./native-local-process-stop.js";
import { isPreDispatchCancellation } from "./pre-dispatch-cancellation.js";

/**
 * STUDIO-0097: the proof that the ENGINE of a steered run stopped, and what is done without it.
 *
 * A steered run (live steering, `adapter_interactive_v1`) is driven through a link: the process the server records
 * for it (`onSpawn`) is that link, an ssh client on the server, not the engine on the machine. When a pause cuts such
 * a run the link ends; the engine ends only when its input closes. Production, 23 Nov 2026: the server took the
 * link's absence for the engine's stop (ten minutes after the run ended, STUDIO-0043), and the run that continued the
 * work kept the conversation and the folder (STUDIO-0075) while the engine, or something it started, could still
 * write there.
 *
 * Decided by the studio on 23 Nov 2026. What concludes is the server's own OBSERVATION of the machine:
 *
 * 1. While the run lives, the adapter that drives the engine ANNOUNCES it (`onProviderStarted`): its process number
 *    and its start time, read on the machine by the engine's launcher. The server keeps the announcement.
 * 2. After the run ended, the server asks that adapter to look (`readProviderStop`, a function of the adapter
 *    module), through the server's own connection to the role's environment, at the processes of the session's
 *    account: by number, start time and program name, never their arguments. It hands the announcement back.
 * 3. Proven: the announced engine is absent AND no process of the account was born since the engine started
 *    (what the engine may have started, attached to it or not). Anything else is no proof.
 * 4. The adapter may be asked to stop the announced engine when it still lives after the grace the agent is given.
 *    What it stopped is said on the task.
 *
 * What the adapter hands with the stop callback of its own execution (`paperclip.provider-stop-proof.v1`) is kept as
 * an event of the run and proves nothing by itself.
 *
 * With the proof, a pause concludes at once and the work continues in the same conversation and the same folder.
 * Without it, the pause concludes as before (the ssh client rule), the run is marked and its task is told once, and
 * the next run of the task, WHATEVER started it, opens a new conversation in a new folder.
 *
 * All of this is kept as events of the run, not as keys of its result: the result is replaced when a run completes,
 * and the order of events is what binds a proof to the launch it belongs to. The event types are reserved to the
 * server (heartbeat/run-output.ts refuses them from an adapter's own events).
 */
export const SERVER_RESERVED_PROVIDER_EVENT_PREFIXES: readonly string[] = ["provider.identity_", "provider.stop_"];
export const PROVIDER_IDENTITY_ANNOUNCED = "provider.identity_announced";
export const PROVIDER_STOP_PROOF_RECORDED = "provider.stop_proof_recorded";
export const PROVIDER_STOP_OBSERVATION_RECORDED = "provider.stop_observation_recorded";
/** Kept on the run that starts after a cut run whose engine stop is not proven: it opens a new conversation and folder. */
export const PROVIDER_STOP_UNPROVEN_CONTINUATION = "provider.stop_unproven_continuation";
export const PROVIDER_IDENTITY_SCHEMA_V1 = "paperclip.provider-identity.v1";
export const PROVIDER_STOP_PROOF_SCHEMA_V1 = "paperclip.provider-stop-proof.v1";
export const PROVIDER_STOP_OBSERVATION_SCHEMA_V1 = "paperclip.provider-stop-observation.v1";
/** The mark on a run a pause cut and whose engine stop is not proven (result_json), written once. */
export const ENGINE_STOP_UNPROVEN_KEY = "engineStopUnproven";
/** The task's activity line of that mark: the watch reads it, and a person goes to see whether an engine still lives. */
export const PAUSE_CUT_ENGINE_STOP_UNPROVEN = "agent.pause_cut_engine_stop_unproven";
export const ENGINE_STOP_UNPROVEN_REASON = "no_engine_stop_proof";
/** The task's activity line written when the observation stopped an engine that was still alive. */
export const PAUSE_CUT_ENGINE_STOPPED = "agent.pause_cut_engine_stopped";

const STEERED_PROTOCOL = "adapter_interactive_v1";
const OWNED_PROTOCOLS: readonly string[] = ["codex_owned_v1", "claude_owned_v1"];
/** Both clocks compared here are the server's; this only absorbs two readings taken apart. */
const CLOCK_TOLERANCE_MS = 2 * 60_000;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
/** The server's own bound around one observation; the adapter bounds its reading itself. */
export const OBSERVATION_TIMEOUT_MS = 40_000;
/** An observation that proved nothing is not asked again before this delay. */
export const OBSERVATION_RETRY_AFTER_MS = 10_000;
const DEFAULT_GRACE_SEC = 20;
const MAX_LISTED = 32;

export function isServerReservedProviderEvent(eventType: string) {
  return SERVER_RESERVED_PROVIDER_EVENT_PREFIXES.some(prefix => eventType.startsWith(prefix));
}

const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isoUtc = (value: unknown): value is string => typeof value === "string" && ISO_UTC.test(value) && Number.isFinite(Date.parse(value));

// ------------------------------------------------------------------------------------------------ the announcement

export type ProviderIdentityAnnouncement = {
  schema: typeof PROVIDER_IDENTITY_SCHEMA_V1; runId: string; protocol: string; route: "direct" | "router";
  machine: string | null; providerPid: number; providerStartedAt: string;
};

/** The announcement, field for field. `providerStartedAt` is kept in the very text given: it is an identity. */
export function verifyProviderIdentityAnnouncement(runId: string, value: unknown):
  { announcement: ProviderIdentityAnnouncement } | { refusal: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { refusal: "not_an_object" };
  const raw = value as Record<string, unknown>;
  if (raw.schema !== PROVIDER_IDENTITY_SCHEMA_V1) return { refusal: "unknown_schema" };
  if (raw.runId !== runId) return { refusal: "another_run" };
  if (typeof raw.protocol !== "string" || !OWNED_PROTOCOLS.includes(raw.protocol)) return { refusal: "unknown_protocol" };
  if (raw.route !== "direct" && raw.route !== "router") return { refusal: "unknown_route" };
  if (!positiveInteger(raw.providerPid)) return { refusal: "invalid_provider_pid" };
  if (!isoUtc(raw.providerStartedAt)) return { refusal: "invalid_start_time" };
  const machine = typeof raw.machine === "string" && /^[\w.-]{1,128}$/.test(raw.machine) ? raw.machine : null;
  if (raw.machine != null && machine === null) return { refusal: "invalid_machine" };
  return { announcement: { schema: PROVIDER_IDENTITY_SCHEMA_V1, runId, protocol: raw.protocol, route: raw.route, machine,
    providerPid: raw.providerPid, providerStartedAt: raw.providerStartedAt } };
}

/** Called by the host callback of ONE run's own adapter execution, when its engine started. Never throws. */
export async function recordProviderIdentityAnnouncement(db: Db, input: { companyId: string; runId: string; agentId: string },
  value: unknown, now: Date = new Date()): Promise<{ recorded: true } | { recorded: false; refusal: string }> {
  try {
    const checked = verifyProviderIdentityAnnouncement(input.runId, value);
    if ("announcement" in checked) {
      await appendHeartbeatRunEvent(db, { companyId: input.companyId, runId: input.runId, agentId: input.agentId,
        eventType: PROVIDER_IDENTITY_ANNOUNCED, stream: "system", level: "info",
        message: "The adapter that drives the engine announced it: its process number and its start time on the machine.",
        payload: { ...checked.announcement, channel: "live", receivedAt: now.toISOString() } });
      return { recorded: true };
    }
    logger.warn({ companyId: input.companyId, runId: input.runId, refusal: checked.refusal },
      "An engine's announcement was refused; without it the stop of that engine cannot be observed");
    return { recorded: false, refusal: checked.refusal };
  } catch (error) {
    logger.error({ err: error, companyId: input.companyId, runId: input.runId }, "An engine's announcement could not be kept");
    return { recorded: false, refusal: "not_kept" };
  }
}

/** The run's latest announcement, as the server kept it, or null. */
export async function readProviderIdentityAnnouncement(db: Db, companyId: string, runId: string) {
  const [latest] = await db.select({ payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, companyId), eq(heartbeatRunEvents.runId, runId),
    eq(heartbeatRunEvents.eventType, PROVIDER_IDENTITY_ANNOUNCED), isNull(heartbeatRunEvents.sourceEventId)))
    .orderBy(desc(heartbeatRunEvents.seq)).limit(1);
  if (latest?.payload?.channel !== "live") return null;
  const checked = verifyProviderIdentityAnnouncement(runId, latest.payload);
  return "announcement" in checked ? checked.announcement : null;
}

// ------------------------------------------------------------------------------- what the adapter says at the stop

export type LiveProviderStopProof = {
  schema: typeof PROVIDER_STOP_PROOF_SCHEMA_V1; scope: "provider_and_launcher"; runId: string; protocol: string;
  providerPid: number; providerExitCode: number | null; providerSignal: string | null;
  providerAbsent: true; launcherVerified: true; verifiedAt: string;
};

/**
 * The form the adapter hands with its stop callback, field for field. Anything else is refused with the name of
 * what is wrong. Only the known fields are returned. It is kept as a trace: it proves nothing by itself.
 */
export function verifyLiveProviderStopProof(runId: string, value: unknown, now: Date | null = new Date()):
  { proof: LiveProviderStopProof } | { refusal: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { refusal: "not_an_object" };
  const raw = value as Record<string, unknown>;
  if (raw.schema !== PROVIDER_STOP_PROOF_SCHEMA_V1) return { refusal: "unknown_schema" };
  if (raw.scope !== "provider_and_launcher") return { refusal: "unknown_scope" };
  if (raw.runId !== runId) return { refusal: "another_run" };
  if (typeof raw.protocol !== "string" || !OWNED_PROTOCOLS.includes(raw.protocol)) return { refusal: "unknown_protocol" };
  if (raw.providerAbsent !== true || raw.launcherVerified !== true) return { refusal: "stop_not_verified" };
  if (!positiveInteger(raw.providerPid)) return { refusal: "invalid_provider_pid" };
  const exitCode = typeof raw.providerExitCode === "number" && Number.isInteger(raw.providerExitCode) ? raw.providerExitCode : null;
  const signal = typeof raw.providerSignal === "string" && /^SIG[A-Z0-9]{1,16}$/.test(raw.providerSignal) ? raw.providerSignal : null;
  // Exactly one of the two says how the engine ended.
  if ((exitCode === null) === (signal === null) || (raw.providerExitCode != null && exitCode === null)
      || (raw.providerSignal != null && signal === null)) return { refusal: "invalid_exit" };
  const verifiedAt = typeof raw.verifiedAt === "string" ? new Date(raw.verifiedAt) : null;
  if (!verifiedAt || !Number.isFinite(verifiedAt.getTime())) return { refusal: "invalid_time" };
  if (now && verifiedAt.getTime() > now.getTime() + CLOCK_TOLERANCE_MS) return { refusal: "time_in_the_future" };
  return { proof: { schema: PROVIDER_STOP_PROOF_SCHEMA_V1, scope: "provider_and_launcher", runId, protocol: raw.protocol,
    providerPid: raw.providerPid, providerExitCode: exitCode, providerSignal: signal, providerAbsent: true,
    launcherVerified: true, verifiedAt: verifiedAt.toISOString() } };
}

/**
 * Called by the host callback of ONE run's own adapter execution. Never throws. What it keeps is a trace of what the
 * adapter said; nothing is decided on it.
 */
export async function recordLiveProviderStopProof(db: Db, input: { companyId: string; runId: string; agentId: string },
  value: unknown, now: Date = new Date()): Promise<{ recorded: true } | { recorded: false; refusal: string }> {
  try {
    const checked = verifyLiveProviderStopProof(input.runId, value, now);
    if ("proof" in checked) {
      await appendHeartbeatRunEvent(db, { companyId: input.companyId, runId: input.runId, agentId: input.agentId,
        eventType: PROVIDER_STOP_PROOF_RECORDED, stream: "system", level: "info",
        message: "The adapter that drives the engine reported its stop. It is kept as a trace; the server's own observation of the machine is what proves it.",
        payload: { ...checked.proof, channel: "live", receivedAt: now.toISOString() } });
      return { recorded: true };
    }
    logger.warn({ companyId: input.companyId, runId: input.runId, refusal: checked.refusal },
      "What an adapter handed with its stop callback was refused; nothing of the run changes");
    return { recorded: false, refusal: checked.refusal };
  } catch (error) {
    logger.error({ err: error, companyId: input.companyId, runId: input.runId },
      "What an adapter handed with its stop callback could not be kept; nothing of the run changes");
    return { recorded: false, refusal: "not_kept" };
  }
}

// ------------------------------------------------------------------------------------------------- the observation

export type ObservedProcess = { pid: number; startedAt: string; name: string };
export type ProviderStopObservation = {
  schema: typeof PROVIDER_STOP_OBSERVATION_SCHEMA_V1; runId: string; observedAt: string;
  outcome: "absent" | "alive" | "unreadable"; reason: string | null;
  /** The announced engine, when it still exists. */
  engine: ObservedProcess | null;
  /** The other processes of the account born since the engine started, and their whole number. */
  since: ObservedProcess[]; sinceCount: number;
  /** What the adapter stopped, when it was asked to. */
  stopped: Array<ObservedProcess & { signal: string }>;
  /** The engine this observation is about: the announcement the server handed. */
  announced: { providerPid: number; providerStartedAt: string };
};

/** A program's name, never a command line: the last segment of a path, bounded, without control characters. */
function observedProcess(value: unknown): ObservedProcess | null {
  const one = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const name = typeof one?.name === "string" ? one.name.split(/[\\/]/).pop()!.trim() : "";
  if (!one || !positiveInteger(one.pid) || !isoUtc(one.startedAt) || !name || name.length > 128 || /[\0-\x1f\x7f]/.test(name)) return null;
  return { pid: one.pid, startedAt: one.startedAt, name };
}

/**
 * What the adapter's observation must be, for the announcement the server handed. Anything else is refused. Only
 * numbers, start times, program names and a signal are kept of a process, and nothing a caller adds.
 */
export function verifyProviderStopObservation(runId: string, value: unknown,
  announced: { providerPid: number; providerStartedAt: string }, now: Date | null = new Date()):
  { observation: ProviderStopObservation } | { refusal: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { refusal: "not_an_object" };
  const raw = value as Record<string, unknown>;
  if (raw.schema !== PROVIDER_STOP_OBSERVATION_SCHEMA_V1) return { refusal: "unknown_schema" };
  if (raw.runId !== runId) return { refusal: "another_run" };
  if (raw.outcome !== "absent" && raw.outcome !== "alive" && raw.outcome !== "unreadable") return { refusal: "unknown_outcome" };
  const observedAt = typeof raw.observedAt === "string" ? new Date(raw.observedAt) : null;
  if (!observedAt || !Number.isFinite(observedAt.getTime())) return { refusal: "invalid_time" };
  if (now && observedAt.getTime() > now.getTime() + CLOCK_TOLERANCE_MS) return { refusal: "time_in_the_future" };
  const engine = raw.engine == null ? null : observedProcess(raw.engine);
  if (raw.engine != null && !engine) return { refusal: "invalid_engine" };
  // The engine the adapter shows alive is the announced one, by number AND start time, or it is another process.
  if (engine && (engine.pid !== announced.providerPid || engine.startedAt !== announced.providerStartedAt))
    return { refusal: "engine_is_not_the_announced_one" };
  const listed = (list: unknown) => list == null ? [] : Array.isArray(list) && list.length <= MAX_LISTED ? list.map(observedProcess) : null;
  const since = listed(raw.since), stoppedList = listed(raw.stopped);
  if (!since || since.some(process => !process)) return { refusal: "invalid_since" };
  if (!stoppedList || stoppedList.some(process => !process)) return { refusal: "invalid_stopped" };
  const stopped: ProviderStopObservation["stopped"] = [];
  for (const [index, process] of stoppedList.entries()) {
    const signal = (raw.stopped as Array<Record<string, unknown>>)[index]?.signal;
    if (typeof signal !== "string" || !/^SIG[A-Z0-9]{1,16}$/.test(signal)) return { refusal: "invalid_stopped" };
    stopped.push({ ...process!, signal });
  }
  const sinceCount = raw.sinceCount == null ? since.length : raw.sinceCount;
  if (typeof sinceCount !== "number" || !Number.isSafeInteger(sinceCount) || sinceCount < since.length
      || (sinceCount > since.length && since.length < MAX_LISTED)) return { refusal: "invalid_since_count" };
  // The outcome must be what the lists say: "absent" with something in them is no proof.
  if (raw.outcome === "absent" ? Boolean(engine) || sinceCount > 0 : raw.outcome === "alive" && !engine && sinceCount === 0)
    return { refusal: "outcome_and_lists_disagree" };
  const reason = typeof raw.reason === "string" && /^[a-z0-9_]{1,64}$/.test(raw.reason) ? raw.reason : null;
  return { observation: { schema: PROVIDER_STOP_OBSERVATION_SCHEMA_V1, runId, observedAt: observedAt.toISOString(),
    outcome: raw.outcome, reason, engine, since: since as ObservedProcess[], sinceCount, stopped,
    announced: { providerPid: announced.providerPid, providerStartedAt: announced.providerStartedAt } } };
}

/** The one outcome that proves: the announced engine absent and nothing of the account born since it started. */
const proves = (observation: ProviderStopObservation) =>
  observation.outcome === "absent" && observation.engine === null && observation.sinceCount === 0 && observation.since.length === 0;

/**
 * The proof that applies to the run, or null: the server's own observation that nothing is left, when it is the
 * latest of the run's launch, announcement and observation events (a launch or an announcement recorded after it is
 * a new engine, whose stop it does not prove), and when it is about the engine the run last announced.
 */
export async function readEngineStopProof(db: Db, companyId: string, runId: string): Promise<ProviderStopObservation | null> {
  const [latest] = await db.select({ eventType: heartbeatRunEvents.eventType, payload: heartbeatRunEvents.payload })
    .from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.companyId, companyId), eq(heartbeatRunEvents.runId, runId),
      inArray(heartbeatRunEvents.eventType, [PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED, PROVIDER_IDENTITY_ANNOUNCED,
        PROVIDER_STOP_OBSERVATION_RECORDED]),
      isNull(heartbeatRunEvents.sourceEventId))).orderBy(desc(heartbeatRunEvents.seq)).limit(1);
  if (latest?.eventType !== PROVIDER_STOP_OBSERVATION_RECORDED || latest.payload?.channel !== "observation") return null;
  const announcement = await readProviderIdentityAnnouncement(db, companyId, runId);
  const about = latest.payload.announced as { providerPid?: unknown; providerStartedAt?: unknown } | null | undefined;
  if (!announcement || about?.providerPid !== announcement.providerPid || about?.providerStartedAt !== announcement.providerStartedAt) return null;
  const checked = verifyProviderStopObservation(runId, latest.payload, announcement, null);
  return "observation" in checked && proves(checked.observation) ? checked.observation : null;
}

export async function hasEngineStopProof(db: Db, companyId: string, runId: string) {
  return await readEngineStopProof(db, companyId, runId) !== null;
}

type CutRun = { id: string; companyId: string; agentId: string; status: string; finishedAt: Date | null; issueId: string | null };
const runIssueId = sql<string | null>`coalesce(${heartbeatRuns.issueId}::text, ${heartbeatRuns.nativeIssueId}::text,
  ${heartbeatRuns.contextSnapshot}->>'issueId')`;

/**
 * The run when it is one this rule is about: cut by a pause, steered through a link of its own, started.
 *
 * - Steered: the choice the dispatch persisted on the run, never the agent's present setting.
 * - A link of its own: the run holds an environment lease that is not `local` (the role's own ssh environment). A run
 *   the worker router dispatched to a machine holds a `local` lease: the router's reservation guards its folder, and
 *   nothing of it changes here.
 * - A run that never started, or that the server cancelled before its adapter was entered, launched no engine.
 */
async function steeredRunCutByPause(db: Db, input: { companyId: string; runId: string }): Promise<CutRun | null> {
  const [run] = await db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
    status: heartbeatRuns.status, runtimeMode: heartbeatRuns.runtimeMode, startedAt: heartbeatRuns.startedAt,
    finishedAt: heartbeatRuns.finishedAt, processPid: heartbeatRuns.processPid, processGroupId: heartbeatRuns.processGroupId,
    resultJson: heartbeatRuns.resultJson, issueId: runIssueId,
    steered: sql<string | null>`${heartbeatRuns.runnerProfileJson}->>'adapterInteractiveProtocol'` })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
  if (!run || run.runtimeMode !== "legacy" || run.steered !== STEERED_PROTOCOL || !run.startedAt
      || !isGovernancePauseStop(run) || isPreDispatchCancellation(run)) return null;
  const leases = await db.select({ provider: environmentLeases.provider }).from(environmentLeases).where(and(
    eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.heartbeatRunId, run.id)));
  if (!leases.some(lease => lease.provider && lease.provider !== "local")) return null;
  return { id: run.id, companyId: run.companyId, agentId: run.agentId, status: run.status, finishedAt: run.finishedAt, issueId: run.issueId };
}

/** True for a steered run that a pause cut through a link of its own, and whose engine stop is not proven. */
export async function pauseCutEngineStopUnproven(db: Db, input: { companyId: string; runId: string }): Promise<boolean> {
  const run = await steeredRunCutByPause(db, input);
  return run !== null && !await hasEngineStopProof(db, input.companyId, run.id);
}

type Attempt = { inFlight: Promise<boolean> | null; lastAt: number; lastSaid: string | null };
const attempts = new Map<string, Attempt>();
/** Tests only: forget what was asked, so that a case does not wait for another's delay. */
export function forgetProviderStopObservationAttempts() { attempts.clear(); }

/**
 * Asks the adapter to look at what is left of the run on its machine, and keeps the answer. True when the engine's
 * stop is proven (already, or by this observation). Never throws.
 *
 * Only for a run this rule is about, once it ended and its adapter execution returned: nothing the server started
 * for that run is left on the machine then. One observation at a time for a run; one that proved nothing is not
 * asked again before OBSERVATION_RETRY_AFTER_MS (unless `force`). The adapter is asked to stop the announced engine
 * only when the run ended longer ago than the grace the agent is given.
 */
export async function observeProviderStop(db: Db, input: { companyId: string; runId: string },
  options: { force?: boolean; timeoutMs?: number; now?: () => Date } = {}): Promise<boolean> {
  const clock = options.now ?? (() => new Date());
  // What is remembered of a run is forgotten an hour after it was last asked about: a run without a proof by then
  // is asked about again only when a run of its task starts.
  if (attempts.size > 64) for (const [runId, attempt] of attempts)
    if (!attempt.inFlight && clock().getTime() - attempt.lastAt > 60 * 60_000) attempts.delete(runId);
  const state = attempts.get(input.runId) ?? { inFlight: null, lastAt: 0, lastSaid: null };
  if (state.inFlight) return state.inFlight;
  attempts.set(input.runId, state);
  state.inFlight = (async () => {
    try {
      if (await hasEngineStopProof(db, input.companyId, input.runId)) { attempts.delete(input.runId); return true; }
      if (!options.force && state.lastAt && clock().getTime() - state.lastAt < OBSERVATION_RETRY_AFTER_MS) return false;
      const run = await steeredRunCutByPause(db, input);
      if (!run || !run.finishedAt || adapterExecutionControls.has(run.id)
          || !["cancelled", "failed", "timed_out", "interrupted", "succeeded"].includes(run.status)) return false;
      state.lastAt = clock().getTime();
      // Without the announcement there is no engine to look for: no observation, and so no proof.
      const announcement = await readProviderIdentityAnnouncement(db, run.companyId, run.id);
      const answer = announcement ? await askAdapter(db, run, announcement, clock(), options.timeoutMs ?? OBSERVATION_TIMEOUT_MS)
        : { refusal: "no_announcement" };
      let checked = "refusal" in answer ? answer : verifyProviderStopObservation(run.id, answer.value, announcement!, clock());
      // Requested after the run ended: an observation dated before that end is not of this stop.
      if ("observation" in checked && new Date(checked.observation.observedAt).getTime() < run.finishedAt.getTime())
        checked = { refusal: "older_than_the_run_end" };
      const proven = "observation" in checked && proves(checked.observation);
      const said = "observation" in checked ? JSON.stringify([checked.observation.outcome, checked.observation.reason,
        checked.observation.engine?.pid ?? null, checked.observation.sinceCount, checked.observation.stopped.length]) : `refused:${checked.refusal}`;
      // Every proof and everything stopped is kept; an observation that proved nothing is kept when it says something new.
      if ("observation" in checked && (proven || checked.observation.stopped.length > 0 || state.lastSaid !== said)) {
        const observation = checked.observation;
        const publications: ActivityPublication[] = [];
        await db.transaction(async tx => {
          await appendHeartbeatRunEvent(tx as unknown as Db, { companyId: run.companyId, runId: run.id, agentId: run.agentId,
            eventType: PROVIDER_STOP_OBSERVATION_RECORDED, stream: "system", level: proven ? "info" : "warn",
            message: proven ? "The server observed the machine: the announced engine is absent and nothing of its account was born since it started."
              : "The server observed the machine and could not establish that nothing of this run is left there.",
            payload: { ...observation, channel: "observation", recordedAt: clock().toISOString() } });
          // What was stopped is said on the task, with what it was: numbers, start times and program names only.
          if (observation.stopped.length > 0) await logActivity(tx as unknown as Db, { companyId: run.companyId,
            actorType: "system", actorId: "agent-lifecycle", agentId: run.agentId, action: PAUSE_CUT_ENGINE_STOPPED,
            entityType: run.issueId ? "issue" : "agent", entityId: run.issueId ?? run.agentId,
            details: { interruptedRunId: run.id, observedAt: observation.observedAt, stopped: observation.stopped,
              outcomeAfter: observation.outcome, engineStopProven: proven } }, publications);
        });
        for (const publication of publications) publishActivity(publication);
      }
      if (!proven && state.lastSaid !== said) logger.warn({ companyId: run.companyId, runId: run.id, observed: said },
        "The stop of a steered run's engine is not proven by the observation of its machine");
      state.lastSaid = said;
      if (proven) attempts.delete(run.id);
      return proven;
    } catch (error) {
      logger.error({ err: error, companyId: input.companyId, runId: input.runId }, "The observation of a steered run's engine stop failed");
      return false;
    } finally {
      state.inFlight = null;
      // A run this rule is not about, or not yet: nothing was asked, nothing is remembered.
      if (!state.lastAt && attempts.get(input.runId) === state) attempts.delete(input.runId);
    }
  })();
  return state.inFlight;
}

/** How long the reading of a pause's state waits for an observation it started, before leaving it to go on alone. */
export const OBSERVATION_POLL_WAIT_MS = 3_000;

/**
 * For the reading of a pause's state, which is taken again and again while the pause is not concluded: proven
 * already, or by an observation that answers within `waitMs`. An observation that takes longer goes on by itself
 * and the next reading finds what it proved. Never throws.
 */
export async function engineStopProvenNowOrSoon(db: Db, input: { companyId: string; runId: string }, waitMs = OBSERVATION_POLL_WAIT_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([observeProviderStop(db, input),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), waitMs); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** The adapter's own look at the machine, through the server's connection to the environment the run used. */
async function askAdapter(db: Db, run: CutRun, announcement: ProviderIdentityAnnouncement, now: Date, timeoutMs: number):
  Promise<{ value: unknown } | { refusal: string }> {
  const [agent] = await db.select({ adapterType: agents.adapterType, adapterConfig: agents.adapterConfig }).from(agents)
    .where(and(eq(agents.companyId, run.companyId), eq(agents.id, run.agentId)));
  if (!agent) return { refusal: "agent_not_found" };
  const adapter = getServerAdapter(agent.adapterType);
  if (typeof adapter?.readProviderStop !== "function") return { refusal: "adapter_cannot_observe" };
  const [lease] = await db.select({ id: environmentLeases.id, metadata: environmentLeases.metadata,
    environmentId: environments.id, driver: environments.driver, config: environments.config })
    .from(environmentLeases).innerJoin(environments, eq(environments.id, environmentLeases.environmentId))
    .where(and(eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
      ne(environmentLeases.provider, "local"))).orderBy(desc(environmentLeases.acquiredAt)).limit(1);
  if (!lease) return { refusal: "environment_not_found" };
  const target = await resolveEnvironmentExecutionTarget({ db, companyId: run.companyId, adapterType: agent.adapterType,
    environment: { id: lease.environmentId, driver: lease.driver, config: lease.config }, leaseId: lease.id, leaseMetadata: lease.metadata });
  if (!target || target.kind !== "remote" || target.transport !== "ssh") return { refusal: "environment_not_ssh" };
  const graceSec = Number((agent.adapterConfig as Record<string, unknown> | null)?.graceSec);
  const graceMs = (Number.isFinite(graceSec) && graceSec > 0 ? graceSec : DEFAULT_GRACE_SEC) * 1000;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      adapter.readProviderStop({ runId: run.id, announcement, target,
        stop: now.getTime() - run.finishedAt!.getTime() >= graceMs, signal: controller.signal }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("observation timed out")), timeoutMs); }),
    ]);
    return { value };
  } catch (error) {
    controller.abort();
    logger.warn({ err: error, companyId: run.companyId, runId: run.id }, "The adapter did not answer the observation of a run's engine stop");
    return { refusal: "adapter_did_not_answer" };
  } finally {
    clearTimeout(timer);
  }
}

// ----------------------------------------------------------------------------------------------- without the proof

/**
 * The mark of a run whose engine stop is not proven, and its line on the task, written together and once: either
 * both are there or neither. True when this call wrote them.
 */
export async function markEngineStopUnproven(db: Db, run: { id: string; companyId: string; agentId: string; issueId: string | null }) {
  const publications: ActivityPublication[] = [];
  const first = await db.transaction(async tx => {
    const markedAt = new Date().toISOString();
    const [marked] = await tx.update(heartbeatRuns).set({
      resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({
        [ENGINE_STOP_UNPROVEN_KEY]: { version: 1, reason: ENGINE_STOP_UNPROVEN_REASON, markedAt } })}::jsonb`,
    }).where(and(eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id),
      sql`not (coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ? ${ENGINE_STOP_UNPROVEN_KEY})`))
      .returning({ id: heartbeatRuns.id });
    if (!marked) return false;
    // Where the engine ran: the environment of each lease the run held (the role's own environment), by its id, its
    // name and its driver. Never an address: the environment's own settings hold it, for who may read them.
    const leases = await tx.select({ id: environmentLeases.id, provider: environmentLeases.provider,
      environmentId: environmentLeases.environmentId, environmentName: environments.name, environmentDriver: environments.driver })
      .from(environmentLeases).leftJoin(environments, eq(environments.id, environmentLeases.environmentId))
      .where(and(eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id)));
    const ran = new Map(leases.filter(lease => lease.environmentId).map(lease => [lease.environmentId!,
      { id: lease.environmentId!, name: lease.environmentName ?? null, driver: lease.environmentDriver ?? null }]));
    await logActivity(tx as unknown as Db, { companyId: run.companyId, actorType: "system", actorId: "agent-lifecycle", agentId: run.agentId,
      action: PAUSE_CUT_ENGINE_STOP_UNPROVEN, entityType: run.issueId ? "issue" : "agent", entityId: run.issueId ?? run.agentId,
      details: { interruptedRunId: run.id, reason: ENGINE_STOP_UNPROVEN_REASON,
        leaseProviders: [...new Set(leases.map(lease => lease.provider).filter(Boolean))],
        environmentIds: [...ran.keys()], environments: [...ran.values()], leaseIds: leases.map(lease => lease.id) } }, publications);
    return true;
  });
  for (const publication of publications) publishActivity(publication);
  if (first) logger.warn({ companyId: run.companyId, agentId: run.agentId, runId: run.id, issueId: run.issueId },
    "A pause cut a steered run and the stop of its engine is not proven: the run is marked, and the next run of its task opens a new conversation in a new folder");
  return first;
}

/**
 * When a pause concludes: each run this pause cut whose engine stop is not proven is marked, and its task told.
 * The pause concludes all the same. Never throws: the mark decides nothing, and a pause must conclude.
 *
 * "This pause": the runs that ended since the agent was paused (`paused_at`, written when the agent enters
 * `pausing`), the rule the resume uses for the runs it continues (pause-resume-continuation.ts). It is read from the
 * agent's own row: the lifecycle worker's agent does not carry it. `since` replaces it (tests).
 */
export async function markEngineStopsUnprovenAtPause(db: Db, agent: { id: string; companyId: string }, since?: Date | null) {
  let marked = 0;
  try {
    const pausedAt = since !== undefined ? since : (await db.select({ pausedAt: agents.pausedAt }).from(agents).where(and(
      eq(agents.companyId, agent.companyId), eq(agents.id, agent.id))))[0]?.pausedAt ?? null;
    if (!pausedAt) return marked;
    const cut = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id), eq(heartbeatRuns.status, "cancelled"),
      sql`${heartbeatRuns.runnerProfileJson}->>'adapterInteractiveProtocol' = ${STEERED_PROTOCOL}`,
      sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.updatedAt}) >= ${pausedAt.toISOString()}::timestamptz`,
      sql`not (coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ? ${ENGINE_STOP_UNPROVEN_KEY})`));
    for (const { id } of cut) {
      const run = await steeredRunCutByPause(db, { companyId: agent.companyId, runId: id });
      if (run && !await hasEngineStopProof(db, agent.companyId, id) && await markEngineStopUnproven(db, run)) marked += 1;
    }
  } catch (error) {
    logger.error({ err: error, companyId: agent.companyId, agentId: agent.id },
      "The runs a pause cut without a proof of their engine's stop could not all be marked");
  }
  return marked;
}

export type UnprovenContinuation = { cutRunId: string; leaseIds: string[] };

/** What was decided for this run when it started (below), or null. Read wherever the run's folder is chosen. */
export async function readUnprovenContinuation(db: Db, run: { id: string; companyId: string }): Promise<UnprovenContinuation | null> {
  const [decided] = await db.select({ payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    eq(heartbeatRunEvents.eventType, PROVIDER_STOP_UNPROVEN_CONTINUATION), isNull(heartbeatRunEvents.sourceEventId)))
    .orderBy(heartbeatRunEvents.seq).limit(1);
  const cutRunId = decided?.payload?.cutRunId;
  if (decided?.payload?.channel !== "decision" || typeof cutRunId !== "string") return null;
  const leaseIds = Array.isArray(decided.payload.leaseIds) ? decided.payload.leaseIds.filter((id): id is string => typeof id === "string") : [];
  return { cutRunId, leaseIds };
}

/**
 * At the start of EVERY run of a task, whatever started it (the resume's Retry, a person's message, an assignment, a
 * timer, a replayed or promoted wake): is the run that worked on the task before it a run a pause cut, whose engine
 * stop is still not proven? Then this run must not continue in its conversation nor in its folder.
 *
 * Looked at: the run that wrote the conversation this agent keeps for the task, and the latest earlier run that
 * started on the task, of this agent or of another (a task handed over is worked on in the task's folder).
 * The observation is asked once more first (the machine may answer now). When it still proves nothing, the cut run
 * is marked (a pause that did not go through the agent's lifecycle, a budget stop for one, is marked here at the
 * latest), and the decision is kept on THIS run as an event: it is read again each time the run's folder is chosen,
 * and must not change while the run is prepared. Decided once: a run that carries the decision keeps it.
 */
export async function decideUnprovenContinuation(db: Db, input: { run: { id: string; companyId: string; agentId: string }; issueId: string },
  options: { observeTimeoutMs?: number } = {}): Promise<UnprovenContinuation | null> {
  const { run, issueId } = input;
  const decided = await readUnprovenContinuation(db, run);
  if (decided) return decided;
  const kept = await db.select({ lastRunId: agentTaskSessions.lastRunId }).from(agentTaskSessions).where(and(
    eq(agentTaskSessions.companyId, run.companyId), eq(agentTaskSessions.agentId, run.agentId), eq(agentTaskSessions.taskKey, issueId)));
  const [earlier] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, run.companyId), ne(heartbeatRuns.id, run.id),
    or(eq(heartbeatRuns.issueId, issueId), eq(heartbeatRuns.nativeIssueId, issueId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`),
    // A run that started: one that was only queued, or cancelled before its adapter was entered, wrote nothing.
    sql`${heartbeatRuns.startedAt} is not null`,
    sql`${heartbeatRuns.createdAt} <= (select successor.created_at from heartbeat_runs successor where successor.id = ${run.id})`))
    .orderBy(desc(heartbeatRuns.startedAt), desc(heartbeatRuns.id)).limit(1);
  const candidates = [...new Set([...kept.map(row => row.lastRunId), earlier?.id].filter((id): id is string => Boolean(id) && id !== run.id))];
  for (const cutRunId of candidates) {
    const cut = await steeredRunCutByPause(db, { companyId: run.companyId, runId: cutRunId });
    if (!cut || await hasEngineStopProof(db, run.companyId, cutRunId)) continue;
    if (await observeProviderStop(db, { companyId: run.companyId, runId: cutRunId }, { force: true, timeoutMs: options.observeTimeoutMs })) continue;
    await markEngineStopUnproven(db, cut);
    const leases = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
      eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, cutRunId)));
    const decision = { cutRunId, leaseIds: leases.map(lease => lease.id) };
    await appendHeartbeatRunEvent(db, { companyId: run.companyId, runId: run.id, agentId: run.agentId,
      eventType: PROVIDER_STOP_UNPROVEN_CONTINUATION, stream: "system", level: "warn",
      message: `This run opens a new conversation in a new folder: the stop of the engine of the run a pause cut before it (${cutRunId}) is not proven.`,
      payload: { ...decision, reason: ENGINE_STOP_UNPROVEN_REASON, channel: "decision" } });
    return await readUnprovenContinuation(db, run) ?? decision;
  }
  return null;
}
