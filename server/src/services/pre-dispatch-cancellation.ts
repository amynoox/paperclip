// STUDIO-0043: a run cancelled by the server before its adapter was entered
// (stale queued-run gate, stale execution continuation) never started provider
// work: no local process, and no remote command on its environment lease. The
// cancellation records that fact so the agent stop proof does not wait for a
// process acknowledgement or a remote termination receipt that can never come.
// Kept apart from `executionCancellation`: an acknowledged cancellation means
// an operator stop at release (held wakes are not promoted), which a stale
// pre-dispatch cancellation is not.
// STUDIO-0053: the same proof for a legacy run that the Board stopped while it
// was still preparing (lease, workspace), before its adapter was invoked: the
// adapter settled after the stop, no process identity was ever recorded and no
// adapter or process event exists for the run, so no engine was launched.
import { and, eq, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";

export const PRE_DISPATCH_CANCELLATION_KEY = "preDispatchCancellation";

export type PreDispatchCancellationSource = "stale_queued_run_gate" | "stale_execution_continuation" | "operator_before_adapter_invoke";

/** Events that show the adapter was invoked or a provider process was asked for or started. */
export const PROVIDER_WORK_EVENT_TYPES = [
  "adapter.invoke", "native.process_start_requested", "native.process_identity_recorded", "tool.execution.started",
] as const;

/**
 * STUDIO-0053: record that a Board-stopped legacy run never reached its adapter. Call only after the run's adapter
 * control has settled (its event writes are done). Conditional update: a run that recorded a process, any provider
 * work event, an acknowledged cancellation or an existing marker is left alone. Returns whether the marker was written.
 */
export async function markCancelledBeforeAdapterInvoke(db: Db, runId: string, at = new Date()): Promise<boolean> {
  const marker = preDispatchCancellationResult("operator_before_adapter_invoke", at)[PRE_DISPATCH_CANCELLATION_KEY];
  const rows = await db.update(heartbeatRuns).set({
    resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || jsonb_build_object(${PRE_DISPATCH_CANCELLATION_KEY}::text, ${JSON.stringify(marker)}::jsonb)`,
    updatedAt: at,
  }).where(and(
    eq(heartbeatRuns.id, runId),
    eq(heartbeatRuns.status, "cancelled"),
    eq(heartbeatRuns.runtimeMode, "legacy"),
    isNull(heartbeatRuns.processPid),
    isNull(heartbeatRuns.processGroupId),
    sql`${heartbeatRuns.resultJson}->'executionCancellation'->>'state' = 'requested'`,
    sql`not (coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ? ${PRE_DISPATCH_CANCELLATION_KEY}::text)`,
    sql`not exists (select 1 from heartbeat_run_events provider_work where provider_work.run_id = ${heartbeatRuns.id}
      and provider_work.event_type in (${sql.join(PROVIDER_WORK_EVENT_TYPES.map(type => sql`${type}`), sql`, `)}))`,
  )).returning({ id: heartbeatRuns.id });
  return rows.length > 0;
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
