/** Per-adapter invocation fence. A failed later attempt invalidates an earlier
 * stop receipt; a late callback from that earlier attempt cannot restore it. */
export function createProviderStoppedBoundary(onProviderStopped?: () => Promise<void>) {
  let invocation = 0;
  let stopped = false;
  let collected = false;
  return {
    beginInvocation(): () => void {
      const current = ++invocation;
      stopped = false;
      return () => { if (invocation === current) stopped = true; };
    },
    async collectBeforeRestore() {
      if (!stopped || collected || !onProviderStopped) return;
      collected = true;
      await onProviderStopped();
    },
  };
}

/** Longest wait for a late provider-stop receipt once the adapter has returned
 * while a prepared interactive process was still unproven. Past this bound the
 * callback bridge is stopped anyway, so it can never outlive its run. */
export const ORPHANED_BRIDGE_STOP_MAX_DELAY_MS = 10 * 60_000;

export type OrphanedBridgeStopReason = "provider_stopped" | "run_cancelled" | "max_delay";

/** Hands a callback bridge that the adapter must keep (provider stop unproven)
 * to a deferred stop instead of dropping it. The bridge stops exactly once, on
 * the first of: the returned trigger (a late provider-stop receipt), the run's
 * cancellation signal, or `maxDelayMs`. The bound timer never holds the process. */
export function deferOrphanedBridgeStop(input: {
  bridge: { stop(): Promise<void> };
  signal?: AbortSignal;
  maxDelayMs?: number;
}): (reason?: OrphanedBridgeStopReason) => void {
  let released = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onAbort = () => release("run_cancelled");
  const release = (reason: OrphanedBridgeStopReason = "provider_stopped") => {
    if (released) return;
    released = true;
    if (timer) clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
    // The run may already be settled: report through the process log only.
    console.warn(`[paperclip] Stopping a callback bridge kept after an unproven provider stop (${reason}).`);
    void Promise.resolve()
      .then(() => input.bridge.stop())
      .catch((error) => {
        console.warn(
          `[paperclip] Deferred callback bridge stop failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  };
  if (input.signal?.aborted) {
    release("run_cancelled");
    return release;
  }
  input.signal?.addEventListener("abort", onAbort, { once: true });
  timer = setTimeout(() => release("max_delay"), input.maxDelayMs ?? ORPHANED_BRIDGE_STOP_MAX_DELAY_MS);
  if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref();
  return release;
}
