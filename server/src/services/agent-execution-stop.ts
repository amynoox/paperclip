import { readProcessStartedAt } from "./hot-restart.js";
import { runUsedConversationAdapter } from "./conversation-continuation.js";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { hasNativeLocalProcessStop } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { isCancelledNativeStartup } from "./cancelled-native-startup.js";
import { isPreDispatchCancellation } from "./pre-dispatch-cancellation.js";

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

/** Cancellation changes admission. Process and lease evidence controls cleanup. */
export async function agentExecutionsHaveStopped(db: Db, agentIds: string[], options: AgentExecutionStopOptions = {}) {
  if (!agentIds.length) return true;
  const runs = await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, agentIds));
  const runIds = db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, agentIds));
  const leases = await db.select().from(environmentLeases).where(or(
    inArray(environmentLeases.heartbeatRunId, runIds),
    inArray(sql`${environmentLeases.metadata}->>'agentId'`, agentIds),
  ));
  if (leases.some(lease => (!lease.releasedAt && !(lease.status === "retained" && lease.cleanupStatus === "success")) || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed")) return false;
  const coordinators = await db.select().from(nativeRunFinalizations)
    .where(inArray(nativeRunFinalizations.runId, runIds));
  const now = options.now ?? new Date();
  const abandoned = coordinators.filter(row => row.leaseOwner);
  if (abandoned.some(row => !row.leaseExpiresAt || row.leaseExpiresAt > now || row.resultId ||
      runs.find(run => run.id === row.runId)?.status !== "cancelled")) return false;
  const absent = (pid: number) => {
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  };
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
      if (run.status === "cancelled" && !cancelledBeforeDispatch && !runLeases.every(hasRemoteTerminationReceipt) &&
          !(options.pauseStop && await sshClientStopProvesPause(run, runLeases, now))) return false;
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
        !await hasNativeLocalProcessStop(db, run.companyId, run.id) &&
        !await isCancelledNativeStartup(db, run, coordinators.find(row => row.runId === run.id))) return false;
    if (run.runtimeMode === "legacy" && !run.processPid && !run.processGroupId && !cancelledBeforeDispatch &&
        (run.resultJson?.executionCancellation as Record<string, unknown> | undefined)?.state !== "acknowledged" &&
        !(run.executionStage === "settled" && !await runUsedConversationAdapter(db, run)) &&
        !await isCancelledNativeStartup(db, run, coordinators.find(row => row.runId === run.id))) return false;
  }
  async function sshClientStopProvesPause(
    run: typeof heartbeatRuns.$inferSelect, runLeases: (typeof environmentLeases.$inferSelect)[], at: Date,
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
