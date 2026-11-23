import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { agents, environmentLeases, environments, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { isGovernancePauseStop } from "./governance-pause-stop.js";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "./native-local-process-stop.js";
import { isPreDispatchCancellation } from "./pre-dispatch-cancellation.js";

/**
 * STUDIO-0097: the proof that the ENGINE of a steered run stopped.
 *
 * A steered run (live steering, `adapter_interactive_v1`) is driven through a link: the process the server records
 * for it (`onSpawn`) is that link, an ssh client on the server, not the engine on the machine. When a pause cuts such
 * a run, the link ends; the engine ends only when its input closes. Production, 23 Nov 2026 (read by the worker
 * router's chat): the server took the link's absence for the engine's stop, and the run that continued the work kept
 * the conversation and the folder (STUDIO-0075) while the engine could still write.
 *
 * The adapter that drives the engine hands its verified stop to the host with the invocation's stop callback
 * (`onProcessStopped(proof)`, the form agreed with the worker router on 15 Nov 2026 and sent by it since its
 * 0.30.13: `paperclip.provider-stop-proof.v1`). The host checks it and keeps it as an event of the run. An event,
 * not a key of the run's result: the result is replaced when a run completes, and the order of events is what binds
 * a proof to the launch it belongs to, as for the product's own local stop record (native-local-process-stop.ts):
 * a process identity recorded after the proof means a new launch, and the earlier proof no longer applies.
 *
 * What the proof says: the engine, a direct child of its launcher, is gone, and the launcher ended. Not that nothing
 * the engine started still runs: a tool command or a detached child may outlive it.
 */
export const PROVIDER_STOP_PROOF_RECORDED = "provider.stop_proof_recorded";
export const PROVIDER_STOP_PROOF_SCHEMA_V1 = "paperclip.provider-stop-proof.v1";
/** The mark on a run a pause cut and whose engine stop is not proven (result_json), written once. */
export const ENGINE_STOP_UNPROVEN_KEY = "engineStopUnproven";
/** The task's activity line of that mark: the watch reads it, and a person goes to see whether an engine still lives. */
export const PAUSE_CUT_ENGINE_STOP_UNPROVEN = "agent.pause_cut_engine_stop_unproven";
export const ENGINE_STOP_UNPROVEN_REASON = "no_engine_stop_proof";

const STEERED_PROTOCOL = "adapter_interactive_v1";
const OWNED_PROTOCOLS: readonly string[] = ["codex_owned_v1", "claude_owned_v1"];
/** The proof is built in the server's own process; this only absorbs the granularity of two clocks read apart. */
const CLOCK_TOLERANCE_MS = 2 * 60_000;

export type LiveProviderStopProof = {
  schema: typeof PROVIDER_STOP_PROOF_SCHEMA_V1; scope: "provider_and_launcher"; runId: string; protocol: string;
  providerPid: number; providerExitCode: number | null; providerSignal: string | null;
  providerAbsent: true; launcherVerified: true; verifiedAt: string;
};

/**
 * The form agreed on 15 Nov 2026, field for field. Anything else is refused with the name of what is wrong. Only the
 * known fields are returned: nothing a caller adds is kept. `now` null reads again a proof whose time was judged when
 * it was kept.
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
  if (typeof raw.providerPid !== "number" || !Number.isSafeInteger(raw.providerPid) || raw.providerPid <= 0)
    return { refusal: "invalid_provider_pid" };
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
 * The live way: called by the host callback of ONE run's own adapter execution, which exists only while that
 * execution lives. Never throws: a proof that cannot be kept changes nothing of the run, and its refusal is logged.
 */
export async function recordLiveProviderStopProof(db: Db, input: { companyId: string; runId: string; agentId: string },
  value: unknown, now: Date = new Date()): Promise<{ recorded: true } | { recorded: false; refusal: string }> {
  try {
    const checked = verifyLiveProviderStopProof(input.runId, value, now);
    let refusal = "refusal" in checked ? checked.refusal : null;
    if ("proof" in checked) {
      const [run] = await db.select({ startedAt: heartbeatRuns.startedAt, processStartedAt: heartbeatRuns.processStartedAt })
        .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId),
          eq(heartbeatRuns.agentId, input.agentId)));
      const launchedAt = run?.processStartedAt ?? run?.startedAt ?? null;
      // A stop verified before the launch the run now records is not that launch's.
      if (!run) refusal = "run_not_found";
      else if (launchedAt && new Date(checked.proof.verifiedAt).getTime() < launchedAt.getTime() - CLOCK_TOLERANCE_MS)
        refusal = "older_than_the_launch";
      else {
        await appendHeartbeatRunEvent(db, { companyId: input.companyId, runId: input.runId, agentId: input.agentId,
          eventType: PROVIDER_STOP_PROOF_RECORDED, stream: "system", level: "info",
          message: "The engine's verified stop was handed by its adapter and is kept for this launch.",
          payload: { ...checked.proof, channel: "live", receivedAt: now.toISOString() } });
        return { recorded: true };
      }
    }
    logger.warn({ companyId: input.companyId, runId: input.runId, refusal },
      "An engine stop proof handed with the stop callback was refused; nothing of the run changes");
    return { recorded: false, refusal: refusal ?? "refused" };
  } catch (error) {
    logger.error({ err: error, companyId: input.companyId, runId: input.runId },
      "An engine stop proof handed with the stop callback could not be kept; nothing of the run changes");
    return { recorded: false, refusal: "not_kept" };
  }
}

/**
 * The proof that applies to the run's latest launch, or null. It applies when it is the latest of the run's launch
 * and proof events: a process identity recorded after it is a new launch, whose stop it does not prove.
 */
export async function readEngineStopProof(db: Db, companyId: string, runId: string): Promise<LiveProviderStopProof | null> {
  const [latest] = await db.select({ eventType: heartbeatRunEvents.eventType, payload: heartbeatRunEvents.payload })
    .from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.companyId, companyId), eq(heartbeatRunEvents.runId, runId),
      inArray(heartbeatRunEvents.eventType, [PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED, PROVIDER_STOP_PROOF_RECORDED]),
      isNull(heartbeatRunEvents.sourceEventId))).orderBy(desc(heartbeatRunEvents.seq)).limit(1);
  if (latest?.eventType !== PROVIDER_STOP_PROOF_RECORDED) return null;
  const checked = verifyLiveProviderStopProof(runId, latest.payload, null);
  return "proof" in checked ? checked.proof : null;
}

export async function hasEngineStopProof(db: Db, companyId: string, runId: string) {
  return await readEngineStopProof(db, companyId, runId) !== null;
}

/**
 * True for a run that a pause cut, that was steered through a link of its own, and whose engine stop is not proven.
 *
 * - Steered: the choice the dispatch persisted on the run, never the agent's present setting.
 * - A link of its own: the run holds an environment lease that is not `local` (the role's own ssh environment). A run
 *   the worker router dispatched to a machine holds a `local` lease: the router's reservation guards its folder, and
 *   nothing of it changes here.
 * - A run that never started, or that the server cancelled before its adapter was entered, launched no engine.
 */
export async function pauseCutEngineStopUnproven(db: Db, input: { companyId: string; runId: string }): Promise<boolean> {
  const [run] = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, runtimeMode: heartbeatRuns.runtimeMode,
    startedAt: heartbeatRuns.startedAt, processPid: heartbeatRuns.processPid, processGroupId: heartbeatRuns.processGroupId,
    resultJson: heartbeatRuns.resultJson,
    steered: sql<string | null>`${heartbeatRuns.runnerProfileJson}->>'adapterInteractiveProtocol'` })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
  if (!run || run.runtimeMode !== "legacy" || run.steered !== STEERED_PROTOCOL || !run.startedAt
      || !isGovernancePauseStop(run) || isPreDispatchCancellation(run)) return false;
  const leases = await db.select({ provider: environmentLeases.provider }).from(environmentLeases).where(and(
    eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.heartbeatRunId, run.id)));
  if (!leases.some(lease => lease.provider && lease.provider !== "local")) return false;
  return !await hasEngineStopProof(db, input.companyId, run.id);
}

const runIssueId = sql<string | null>`coalesce(${heartbeatRuns.issueId}::text, ${heartbeatRuns.nativeIssueId}::text,
  ${heartbeatRuns.contextSnapshot}->>'issueId')`;

/**
 * When a pause concludes: each run this pause cut whose engine stop is not proven is marked once, and the mark is
 * said once on its task (on the agent when the run has no task). The pause concludes all the same; the run that
 * continues the work then starts in a new conversation and a new folder (fresh-workspace-continuation.ts,
 * heartbeat/queue.ts). Never throws: the mark decides nothing, and a pause must conclude.
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
    const cut = await db.select({ id: heartbeatRuns.id, issueId: runIssueId }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id), eq(heartbeatRuns.status, "cancelled"),
      sql`${heartbeatRuns.runnerProfileJson}->>'adapterInteractiveProtocol' = ${STEERED_PROTOCOL}`,
      sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.updatedAt}) >= ${pausedAt.toISOString()}::timestamptz`,
      sql`not (coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ? ${ENGINE_STOP_UNPROVEN_KEY})`));
    for (const run of cut) {
      if (!await pauseCutEngineStopUnproven(db, { companyId: agent.companyId, runId: run.id })) continue;
      // Where the engine ran: the environment of each lease the run held (for a run steered through a link of its own,
      // the role's own environment), by its id, its name and its driver. Never an address: the environment's own
      // settings hold it, for who may read them.
      const leases = await db.select({ id: environmentLeases.id, provider: environmentLeases.provider,
        environmentId: environmentLeases.environmentId, environmentName: environments.name, environmentDriver: environments.driver })
        .from(environmentLeases).leftJoin(environments, eq(environments.id, environmentLeases.environmentId))
        .where(and(eq(environmentLeases.companyId, agent.companyId), eq(environmentLeases.heartbeatRunId, run.id)));
      const ran = new Map(leases.filter(lease => lease.environmentId).map(lease => [lease.environmentId!,
        { id: lease.environmentId!, name: lease.environmentName ?? null, driver: lease.environmentDriver ?? null }]));
      const markedAt = new Date().toISOString();
      const [first] = await db.update(heartbeatRuns).set({
        resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({
          [ENGINE_STOP_UNPROVEN_KEY]: { version: 1, reason: ENGINE_STOP_UNPROVEN_REASON, markedAt } })}::jsonb`,
      }).where(and(eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.id, run.id),
        sql`not (coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ? ${ENGINE_STOP_UNPROVEN_KEY})`))
        .returning({ id: heartbeatRuns.id });
      if (!first) continue;
      marked += 1;
      await logActivity(db, { companyId: agent.companyId, actorType: "system", actorId: "agent-lifecycle", agentId: agent.id,
        action: PAUSE_CUT_ENGINE_STOP_UNPROVEN, entityType: run.issueId ? "issue" : "agent", entityId: run.issueId ?? agent.id,
        details: { interruptedRunId: run.id, reason: ENGINE_STOP_UNPROVEN_REASON,
          leaseProviders: [...new Set(leases.map(lease => lease.provider).filter(Boolean))],
          environmentIds: [...ran.keys()], environments: [...ran.values()], leaseIds: leases.map(lease => lease.id) } });
      logger.warn({ companyId: agent.companyId, agentId: agent.id, runId: run.id, issueId: run.issueId },
        "A pause cut a steered run and no proof of its engine's stop was handed: the run is marked, and the run that continues its work starts in a new conversation and a new folder");
    }
  } catch (error) {
    logger.error({ err: error, companyId: agent.companyId, agentId: agent.id },
      "The runs a pause cut without a proof of their engine's stop could not all be marked");
  }
  return marked;
}
