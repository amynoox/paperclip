// STUDIO-0043: a run cancelled by the server before its adapter was entered
// (stale queued-run gate, stale execution continuation) never started provider
// work: no local process, and no remote command on its environment lease. The
// cancellation records that fact so the agent stop proof does not wait for a
// process acknowledgement or a remote termination receipt that can never come.
// Kept apart from `executionCancellation`: an acknowledged cancellation means
// an operator stop at release (held wakes are not promoted), which a stale
// pre-dispatch cancellation is not.
export const PRE_DISPATCH_CANCELLATION_KEY = "preDispatchCancellation";

export type PreDispatchCancellationSource = "stale_queued_run_gate" | "stale_execution_continuation";

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
