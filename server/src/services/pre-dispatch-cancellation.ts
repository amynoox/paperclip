// STUDIO-0043: a run cancelled by the server before its adapter was entered
// (stale queued-run gate, stale execution continuation) never started provider
// work: no local process, and no remote command on its environment lease. The
// cancellation records that fact so the agent stop proof does not wait for a
// process acknowledgement or a remote termination receipt that can never come.
// Kept apart from `executionCancellation`: an acknowledged cancellation means
// an operator stop at release (held wakes are not promoted), which a stale
// pre-dispatch cancellation is not.
// STUDIO-0053: the same proof for a legacy run that was stopped (by the Board, a pause, a reassignment...) with an
// owned adapter control while it was still preparing (lease, workspace), before any process was launched: once
// the adapter has settled, the run recorded no process identity (pid, process group), no session, and no
// execution-start event (executionStartedEventPredicate: adapter invocation, process start, harness, session,
// turn, provider or tool event). adapter.invoke alone proves nothing: ACP adapters write it after launching
// their engine; the proof rests on the absence of a recorded process.
import { and, eq, inArray, isNull, lt, notExists, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { executionStartedEventPredicate } from "./pre-dispatch-execution-evidence.js";

export const PRE_DISPATCH_CANCELLATION_KEY = "preDispatchCancellation";

export type PreDispatchCancellationSource = "stale_queued_run_gate" | "stale_execution_continuation" | "stopped_before_process_launch";

// STUDIO-0061: a pause also accepts a settled legacy run cancelled WITHOUT a stop request (another cancellation path:
// disposition repair, conversation continuation), on the same evidence: no process identity, no session, no
// execution-start event, its adapter control has settled, and no remote lease was taken for it (a remote run keeps the
// receipt or ssh-client rule of agent-execution-stop.ts). Production 15 Nov 2026: run 998a6dc0 (* Game Tester,
// cancelled 07:25:29, no executionCancellation, conversationContinuation set, local lease) kept the pause in `pausing`.
// STUDIO-0088: the same run with an `ssh` lease is accepted too, when that lease was released without a failed cleanup
// (the lease rule of sshClientStopProvesPause, agent-execution-stop.ts). The ssh-client rule can never be met by a run
// that recorded no ssh client, and the evidence above already says none was started: no process identity, no session,
// no execution-start event. Any other remote lease keeps the refusal. Production 22 Nov 2026: the Infra Manager stayed
// `pausing` on such a run until a Board gesture (tools/stop-proof-before-launch.py, the same conditions). Such a run must
// have finished for as long as the ssh-client rule asks (SSH_CLIENT_STOP_PAUSE_PROOF_DELAY_MS, agent-execution-stop.ts).
export const SETTLED_SSH_LEASE_STOP_MARK_DELAY_MS = 10 * 60_000;
function stoppedBeforeProcessLaunchCondition(db: Db, options: { settledWithoutStopRequest?: boolean; at?: Date } = {}) {
  const sshLeaseSettledBefore = new Date((options.at ?? new Date()).getTime() - SETTLED_SSH_LEASE_STOP_MARK_DELAY_MS).toISOString();
  const cancellation = sql`${heartbeatRuns.resultJson}->'executionCancellation'->>'state'`;
  return and(
    eq(heartbeatRuns.status, "cancelled"),
    eq(heartbeatRuns.runtimeMode, "legacy"),
    isNull(heartbeatRuns.processPid),
    isNull(heartbeatRuns.processGroupId),
    isNull(heartbeatRuns.processStartedAt),
    isNull(heartbeatRuns.sessionIdAfter),
    options.settledWithoutStopRequest
      ? sql`(${cancellation} = 'requested' or (${cancellation} is null and ${heartbeatRuns.executionStage} = 'settled'
          and not exists (select 1 from ${environmentLeases} where ${environmentLeases.companyId} = ${heartbeatRuns.companyId}
            and ${environmentLeases.heartbeatRunId} = ${heartbeatRuns.id} and coalesce(${environmentLeases.provider}, 'local') <> 'local'
            and not (${environmentLeases.provider} = 'ssh' and ${environmentLeases.releasedAt} is not null
              and ${environmentLeases.status} in ('released', 'expired')
              and coalesce(${environmentLeases.cleanupStatus}, '') <> 'failed'
              and ${heartbeatRuns.finishedAt} < ${sshLeaseSettledBefore}::timestamptz))))`
      : sql`${cancellation} = 'requested'`,
    sql`not (coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ? ${PRE_DISPATCH_CANCELLATION_KEY}::text)`,
    notExists(db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.companyId, heartbeatRuns.companyId), eq(heartbeatRunEvents.runId, heartbeatRuns.id),
      executionStartedEventPredicate()))),
  );
}

function markerSql(at: Date) {
  const marker = preDispatchCancellationResult("stopped_before_process_launch", at)[PRE_DISPATCH_CANCELLATION_KEY];
  return sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || jsonb_build_object(${PRE_DISPATCH_CANCELLATION_KEY}::text, ${JSON.stringify(marker)}::jsonb)`;
}

/**
 * STUDIO-0053: record that a stopped legacy run launched no process. Call only after the run's adapter control has
 * settled (its event writes are done). Conditional update, once. Returns whether the marker was written.
 */
export async function markCancelledBeforeProcessLaunch(db: Db, runId: string, at = new Date()): Promise<boolean> {
  const rows = await db.update(heartbeatRuns).set({ resultJson: markerSql(at), updatedAt: at })
    .where(and(eq(heartbeatRuns.id, runId), stoppedBeforeProcessLaunchCondition(db)))
    .returning({ id: heartbeatRuns.id });
  return rows.length > 0;
}

/** Settled long enough that its adapter is done (the stop wait is 60 s): a late settlement or a server restart. */
export const SETTLED_STOP_MARK_DELAY_MS = 2 * 60_000;

/**
 * STUDIO-0053: the same marker for the agents' runs that settled after the stop wait timed out, or across a server
 * restart, so a pause can still complete. Same conditions (cancelled runs only), on runs finished more than two
 * minutes ago; called only for agents being paused; no age bound (older stuck runs are repaired the same way).
 */
export async function markSettledStopsBeforeProcessLaunch(db: Db, agentIds: string[], at = new Date()): Promise<number> {
  if (!agentIds.length) return 0;
  // cancelledAt is the run's own end, not the time of this check.
  const marker = sql`jsonb_build_object('version', 1, 'providerWorkStarted', false, 'source', 'stopped_before_process_launch',
    'cancelledAt', to_jsonb(${heartbeatRuns.finishedAt}))`;
  const rows = await db.update(heartbeatRuns).set({
    resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || jsonb_build_object(${PRE_DISPATCH_CANCELLATION_KEY}::text, ${marker})`,
    updatedAt: at,
  })
    .where(and(inArray(heartbeatRuns.agentId, agentIds), lt(heartbeatRuns.finishedAt, new Date(at.getTime() - SETTLED_STOP_MARK_DELAY_MS)),
      stoppedBeforeProcessLaunchCondition(db, { settledWithoutStopRequest: true, at })))
    .returning({ id: heartbeatRuns.id });
  return rows.length;
}

export function preDispatchCancellationResult(source: PreDispatchCancellationSource, at: Date) {
  return { [PRE_DISPATCH_CANCELLATION_KEY]: { version: 1, providerWorkStarted: false, source, cancelledAt: at.toISOString() } };
}

export function isPreDispatchCancellation(run: {
  status: string; runtimeMode: string | null; processPid: number | null; processGroupId: number | null;
  resultJson: Record<string, unknown> | null;
}): boolean {
  const marker = run.resultJson?.[PRE_DISPATCH_CANCELLATION_KEY] as { version?: unknown; providerWorkStarted?: unknown } | undefined;
  return run.status === "cancelled" && run.runtimeMode === "legacy" && !run.processPid && !run.processGroupId &&
    marker?.version === 1 && marker.providerWorkStarted === false;
}
