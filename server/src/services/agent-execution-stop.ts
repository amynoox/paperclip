import { readProcessStartedAt } from "./hot-restart.js";
import { runUsedConversationAdapter } from "./conversation-continuation.js";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { agents, environmentLeases, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { hasNativeLocalProcessStop } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { isCancelledNativeStartup } from "./cancelled-native-startup.js";
import { isPreDispatchCancellation, markSettledStopsBeforeProcessLaunch, PRE_DISPATCH_CANCELLATION_KEY } from "./pre-dispatch-cancellation.js";
import { engineStopProvenNowOrSoon } from "./provider-stop-proof.js";

// STUDIO-0068: the stop proof reads every run the agents ever had. Production, 18 Nov 2026: with whole rows
// (result_json, usage_json, context_snapshot...) the runs of one long-lived role were 864 MB compressed in the
// database; four pausing roles were read at once, twice each, every 2 s, and the server died of heap exhaustion at
// every start. Only the columns the proof reads are selected. Of result_json, two short fragments are extracted
// in SQL: the pre-dispatch marker (isPreDispatchCancellation reads `version` and `providerWorkStarted`) and
// `executionCancellation.state`. Every run is still read, whatever its status: the proof is about finished runs.
// The whole row of ONE run is read only where a helper needs it (readWholeRun below).
const stopProofRunColumns = {
  id: heartbeatRuns.id,
  companyId: heartbeatRuns.companyId,
  agentId: heartbeatRuns.agentId,
  updatedAt: heartbeatRuns.updatedAt,
  status: heartbeatRuns.status,
  runtimeMode: heartbeatRuns.runtimeMode,
  executionStage: heartbeatRuns.executionStage,
  startedAt: heartbeatRuns.startedAt,
  finishedAt: heartbeatRuns.finishedAt,
  processPid: heartbeatRuns.processPid,
  processGroupId: heartbeatRuns.processGroupId,
  processStartedAt: heartbeatRuns.processStartedAt,
  controllerLeaseExpiresAt: heartbeatRuns.controllerLeaseExpiresAt,
  resultJson: sql<Record<string, unknown> | null>`case when ${heartbeatRuns.resultJson} is null then null else jsonb_build_object(
    ${PRE_DISPATCH_CANCELLATION_KEY}::text, jsonb_build_object(
      'version', ${heartbeatRuns.resultJson}->${PRE_DISPATCH_CANCELLATION_KEY}::text->'version',
      'providerWorkStarted', ${heartbeatRuns.resultJson}->${PRE_DISPATCH_CANCELLATION_KEY}::text->'providerWorkStarted'),
    'executionCancellation', jsonb_build_object(
      'state', ${heartbeatRuns.resultJson}->'executionCancellation'->'state')) end`,
};
type StopProofRun = Pick<typeof heartbeatRuns.$inferSelect, Exclude<keyof typeof stopProofRunColumns, "resultJson">>
  & { resultJson: Record<string, unknown> | null };

// STUDIO-0043, pause only: a cancelled run that executed over the built-in
// `ssh` environment driver gets no remote termination receipt (the driver has
// none; the remote command stops only when its local ssh client dies). For the
// stop proof of a PAUSE, such a run counts as stopped once its local ssh client
// is proven gone, its leases are released, and this delay has passed since the
// run finished. 10 min: the adapters keep the callback bridge of an unproven
// stop for at most 10 min (ORPHANED_BRIDGE_STOP_MAX_DELAY_MS), and close it at
// once on cancellation, so a remote command that outlived its client has no
// route back to the server by then; it also leaves time for the command to die
// on its closed stdin and output. Residual risk: a remote command that ignores
// both and keeps running on the worker. Termination and cleanup keep the
// receipt requirement.
export const SSH_CLIENT_STOP_PAUSE_PROOF_DELAY_MS = 10 * 60_000;

export type AgentExecutionStopOptions = {
  /** The stop proof of a pause (lifecycle `pausing`), which accepts the bounded ssh client rule. */
  pauseStop?: boolean;
  now?: Date;
};

function absent(pid: number) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

/**
 * STUDIO-0043: the stop proof a PAUSE accepts for a cancelled legacy run that executed over the built-in `ssh`
 * environment driver, which gives no remote termination receipt: the run finished more than
 * SSH_CLIENT_STOP_PAUSE_PROOF_DELAY_MS ago, every lease is an ssh lease released without a failed cleanup, and the
 * local ssh client is recorded and proven gone. STUDIO-0073: exported, because a person's continuation of a run
 * that a pause cut accepts the same proof (explicit-native-continuation.ts).
 */
export async function sshClientStopProvesPause(
  run: Pick<typeof heartbeatRuns.$inferSelect, "runtimeMode" | "finishedAt" | "processPid" | "processStartedAt" | "processGroupId">,
  runLeases: Pick<typeof environmentLeases.$inferSelect, "provider" | "releasedAt" | "status" | "cleanupStatus">[], at: Date,
) {
  if (run.runtimeMode !== "legacy" || !run.finishedAt ||
      at.getTime() - run.finishedAt.getTime() < SSH_CLIENT_STOP_PAUSE_PROOF_DELAY_MS) return false;
  if (!runLeases.every(lease => lease.provider === "ssh" && lease.releasedAt &&
      ["released", "expired"].includes(lease.status) && lease.cleanupStatus !== "failed")) return false;
  // The local ssh client must be recorded and proven gone (absent, or its pid
  // now belongs to another program).
  if (!run.processPid) return false;
  let clientAlive = !absent(run.processPid);
  if (clientAlive && run.processStartedAt) {
    const observed = await readProcessStartedAt(run.processPid).catch(() => null);
    if (observed && new Date(observed).getTime() !== run.processStartedAt.getTime()) clientAlive = false;
  }
  if (clientAlive) return false;
  if (run.processGroupId && run.processGroupId !== run.processPid && !absent(-run.processGroupId)) return false;
  return true;
}

/** Cancellation changes admission. Process and lease evidence controls cleanup. */
export async function agentExecutionsHaveStopped(db: Db, agentIds: string[], options: AgentExecutionStopOptions = {}) {
  if (!agentIds.length) return true;
  // STUDIO-0053: a pause also records the stop of runs that settled without any process after the stop wait
  // timed out, or across a server restart.
  if (options.pauseStop) await markSettledStopsBeforeProcessLaunch(db, agentIds, options.now ?? new Date());
  const runs: StopProofRun[] = await db.select(stopProofRunColumns).from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, agentIds));
  // One whole row at a time, for the helpers that read more of a run than the proof itself does.
  const readWholeRun = async (runId: string) =>
    (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0] ?? null;
  const runIds = db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, agentIds));
  const leases = await db.select().from(environmentLeases).where(or(
    inArray(environmentLeases.heartbeatRunId, runIds),
    inArray(sql`${environmentLeases.metadata}->>'agentId'`, agentIds),
  ));
  if (leases.some(lease => (!lease.releasedAt && !(lease.status === "retained" && lease.cleanupStatus === "success")) || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed")) return false;
  const coordinators = await db.select().from(nativeRunFinalizations)
    .where(inArray(nativeRunFinalizations.runId, runIds));
  const now = options.now ?? new Date();
  // STUDIO-0097: when each agent's current pause began (the bound markEngineStopsUnprovenAtPause reads too).
  const pausedAtOf = new Map(options.pauseStop
    ? (await db.select({ id: agents.id, pausedAt: agents.pausedAt }).from(agents).where(inArray(agents.id, agentIds)))
      .map(row => [row.id, row.pausedAt] as const)
    : []);
  const cutByThisPause = (run: StopProofRun) => {
    const pausedAt = pausedAtOf.get(run.agentId);
    const ended = run.finishedAt ?? run.updatedAt;
    return Boolean(pausedAt && ended && ended.getTime() >= pausedAt.getTime());
  };
  const abandoned = coordinators.filter(row => row.leaseOwner);
  if (abandoned.some(row => !row.leaseExpiresAt || row.leaseExpiresAt > now || row.resultId ||
      runs.find(run => run.id === row.runId)?.status !== "cancelled")) return false;
  for (const coordinator of abandoned) {
    if (!coordinator.controllerPid || absent(coordinator.controllerPid)) continue;
    const observed = await readProcessStartedAt(coordinator.controllerPid).catch(() => null);
    if (!observed || !coordinator.controllerProcessStartedAt ||
        new Date(observed).getTime() === coordinator.controllerProcessStartedAt.getTime()) return false;
  }
  for (const run of runs) {
    if (!["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(run.status)) return false;
    if (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()) return false;
    const runLeases = leases.filter(lease => lease.heartbeatRunId === run.id);
    // STUDIO-0043: cancelled by the server before its adapter was entered, so
    // no process ran and no remote command was sent on its lease.
    const cancelledBeforeDispatch = isPreDispatchCancellation(run);
    if (runLeases.some(lease => lease.provider && lease.provider !== "local")) {
      // STUDIO-0097: a pause also concludes on the proof of the engine's stop: the server's own observation of the
      // machine (provider-stop-proof.ts), asked here for a steered run the pause cut, without the delay of the ssh
      // client rule: every lease is released (above). The observation goes on in the background when it does not
      // answer at once; the next reading of this state finds what it proved.
      // Without that proof the ssh client rule still concludes the pause, as before: the link's absence then proves
      // nothing of the engine, and the run is marked when the pause concludes (agent-lifecycle-driver.ts).
      // The ssh client rule is read first: it asks the machine nothing. And the machine is asked only of a run THIS
      // pause cut: a run an earlier pause cut is never observed again here (each observation is an ssh connection to
      // the role's account; the account's service manager it starts would be seen, born since the engine, by the
      // observation of this pause's run that follows it).
      if (run.status === "cancelled" && !cancelledBeforeDispatch && !runLeases.every(hasRemoteTerminationReceipt) &&
          !(options.pauseStop && (await sshClientStopProvesPause(run, runLeases, now)
            || (cutByThisPause(run) && await engineStopProvenNowOrSoon(db, { companyId: run.companyId, runId: run.id }))))) return false;
      continue;
    }
    let processAlive = Boolean(run.processPid && !absent(run.processPid));
    let groupAlive = Boolean(run.processGroupId && !absent(-run.processGroupId));
    if (processAlive && run.processStartedAt) {
      const observed = await readProcessStartedAt(run.processPid!).catch(() => null);
      if (observed && new Date(observed).getTime() !== run.processStartedAt.getTime()) {
        processAlive = false;
        if (run.processGroupId === run.processPid) groupAlive = false;
      }
    }
    if (processAlive || groupAlive) return false;
    if (run.status !== "cancelled" || !run.startedAt) continue;
    if (run.runtimeMode === "native" && !run.processPid && !run.processGroupId &&
        !await hasNativeLocalProcessStop(db, run.companyId, run.id)) {
      const whole = await readWholeRun(run.id);
      // A run that is gone cannot be proven stopped here: the proof is asked again.
      if (!whole || !await isCancelledNativeStartup(db, whole, coordinators.find(row => row.runId === run.id))) return false;
    }
    if (run.runtimeMode === "legacy" && !run.processPid && !run.processGroupId && !cancelledBeforeDispatch &&
        (run.resultJson?.executionCancellation as Record<string, unknown> | undefined)?.state !== "acknowledged") {
      const whole = await readWholeRun(run.id);
      if (!whole) return false;
      if (!(run.executionStage === "settled" && !await runUsedConversationAdapter(db, whole)) &&
          !await isCancelledNativeStartup(db, whole, coordinators.find(row => row.runId === run.id))) return false;
    }
  }
  // Release an expired owner only after its cancelled execution has stop proof.
  for (const coordinator of abandoned) {
    const [cleared] = await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
      .where(and(eq(nativeRunFinalizations.runId, coordinator.runId),
        eq(nativeRunFinalizations.leaseOwner, coordinator.leaseOwner!),
        sql`date_trunc('milliseconds', ${nativeRunFinalizations.leaseExpiresAt}) = ${coordinator.leaseExpiresAt!.toISOString()}::timestamptz`,
        eq(nativeRunFinalizations.controllerGeneration, coordinator.controllerGeneration),
        eq(nativeRunFinalizations.phase, coordinator.phase), isNull(nativeRunFinalizations.resultId)))
      .returning({ runId: nativeRunFinalizations.runId });
    if (!cleared) return false;
  }
  return true;
}
