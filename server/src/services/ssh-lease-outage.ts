// STUDIO-0079 (TR-2093, 20 Nov 2026): an ssh lease that cannot be acquired
// because the link to the machine is down is an outage to wait out, not a
// failure to count. Constants and pure readings only: this file is imported by
// the retry accounting, so it must import nothing that imports it back.
//
// The run keeps the code `environment_provider_unavailable` (STUDIO-0052), so
// every place that already treats that code as "nothing started, safe to retry"
// keeps doing so. What tells an ssh outage apart is the provider recorded with
// the failure: the environment's driver.
import { SSH_LEASE_OUTAGE_RETRY_REASON } from "../modules/run-dispatch/domain/wake-context.js";
import { ENVIRONMENT_PROVIDER_UNAVAILABLE_CODE } from "./environment-provider-unavailable-error.js";

// Defined with the other retry reasons, where a retried run is recognised as the
// continuation of an answered question.
export { SSH_LEASE_OUTAGE_RETRY_REASON };

export const SSH_LEASE_OUTAGE_WAKE_REASON = "ssh_lease_outage_retry";

/**
 * How long the lease is asked for again, counted from the end of the first
 * failed run of the outage. The same bound as a machine wait
 * (ADAPTER_DECLARED_WAIT_MAX_MS): past it, a person's decision is due.
 */
export const SSH_LEASE_OUTAGE_MAX_MS = 12 * 60 * 60_000;

/** Delay before each retry; the last one repeats for as long as the outage lasts. */
export const SSH_LEASE_OUTAGE_RETRY_DELAYS_MS: readonly number[] = Object.freeze([
  30_000, 60_000, 120_000, 240_000, 300_000,
]);

export function sshLeaseOutageRetryDelayMs(attempt: number): number {
  const last = SSH_LEASE_OUTAGE_RETRY_DELAYS_MS.length - 1;
  const index = Number.isInteger(attempt) && attempt > 0 ? Math.min(attempt - 1, last) : 0;
  return SSH_LEASE_OUTAGE_RETRY_DELAYS_MS[index]!;
}

type OutageRun = {
  status?: string | null;
  errorCode?: string | null;
  resultJson?: Record<string, unknown> | null;
};

/** A run that failed because its ssh lease could not be acquired for a network reason. */
export function isSshLeaseOutageRun(run: OutageRun | null | undefined): boolean {
  if (!run || run.status !== "failed" || run.errorCode !== ENVIRONMENT_PROVIDER_UNAVAILABLE_CODE) return false;
  const failure = run.resultJson?.providerFailure;
  return Boolean(failure && typeof failure === "object" && !Array.isArray(failure)
    && (failure as Record<string, unknown>).provider === "ssh");
}
