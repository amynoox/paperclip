// Closed list of run error codes by which an adapter declares that the run
// ended because the work is waiting for a resource that the adapter (or its
// plugin) owns and will hand out later, waking the assignee itself. Such a run
// is not a lost execution path: within the bound below, stranded-work recovery
// neither requeues nor blocks the issue, and run completion schedules no
// transient retry (each retry would only repeat the same request). Add a code
// only when its owner confirms it keeps the request and wakes the assignee on
// release.
// - router_waiting_for_resources: the worker router keeps the request in its
//   registry, without limit, and wakes the assignee (the reservation's
//   executor) with `worker_router_group_ready` once a machine is free.
// - router_provider_stop_unverified: the link to the worker machine was cut
//   during the run, so its stop could not be proven; the router (0.30.10 and
//   later) keeps the dispatch open, proves the stop once the machine answers,
//   settles the dispatch and wakes the assignee with
//   `worker_router_dispatch_settled` (at most twice per reservation).
// - router_previous_dispatch_unsettled: the same state seen by the next run
//   (it waited up to 10 min for the proof); same settlement and wake by the
//   router's periodic pass.
export const ADAPTER_DECLARED_WAIT_ERROR_CODES: readonly string[] = Object.freeze([
  "router_waiting_for_resources",
  "router_provider_stop_unverified",
  "router_previous_dispatch_unsettled",
]);

// Bound on such a wait, counted from the END of the oldest run of the latest
// consecutive series of the assignee's runs on the issue that all failed under
// a code above (or from the Board's latest return of the issue, if later), and chosen
// by the code of the latest run. Past it, normal stranded-work recovery
// applies again.
// Machine wait, 12 h: a machine wait depends on how long another task's reservation lasts,
// and a reservation covers every run of that task until it is released, not a
// single run. Observed on 14 Nov 2026: TR-702 held one machine from 00:46:57 to
// 03:05:44; TR-699 held another from 01:15:57 and still held it at 04:41
// (3 h 25). The router keeps the request without limit; past 12 h, normal
// escalation shows a task that has really waited too long.
export const ADAPTER_DECLARED_WAIT_MAX_MS = 12 * 60 * 60_000;

// Unproven stop after a cut link, 1 h: the router retries the proof at least
// every 2 minutes once the machine answers, and opens its own incident ticket
// for the maintenance post when the proof fails for 10 minutes (machine silent,
// engine still alive, no launcher trace from a router older than 0.30.10); it
// then sends no wake, so normal escalation must take over soon after.
export const ADAPTER_DECLARED_STOP_WAIT_MAX_MS = 60 * 60_000;

const ADAPTER_DECLARED_WAIT_MAX_MS_BY_CODE: Readonly<Record<string, number>> = Object.freeze({
  router_waiting_for_resources: ADAPTER_DECLARED_WAIT_MAX_MS,
  router_provider_stop_unverified: ADAPTER_DECLARED_STOP_WAIT_MAX_MS,
  router_previous_dispatch_unsettled: ADAPTER_DECLARED_STOP_WAIT_MAX_MS,
});

export function isAdapterDeclaredWaitErrorCode(code: string | null | undefined): boolean {
  return Boolean(code && ADAPTER_DECLARED_WAIT_ERROR_CODES.includes(code));
}

// Codes of the list for which run completion schedules no transient retry.
// router_provider_stop_unverified is left out on purpose: with router 0.30.10
// the retried run itself waits for the link (one read a minute, 10 min at
// most), proves the stop and starts the engine, so the transient retry is the
// fastest way back after a cut link; it ends router_previous_dispatch_unsettled
// at worst, which is then neither retried nor blocked within the bound.
export const ADAPTER_DECLARED_WAIT_NO_TRANSIENT_RETRY_CODES: readonly string[] = Object.freeze([
  "router_waiting_for_resources",
  "router_previous_dispatch_unsettled",
]);

// STUDIO-0046: an unproven stop after a cut link is retried by the server on
// the code alone (contract with the worker router, 14 Nov 2026): the adapter
// declares no errorFamily, so that a Codex agent's retry keeps its normal
// invocation (transient_upstream would switch it to the Codex fallback mode).
export const SERVER_TRANSIENT_RETRY_CODES: readonly string[] = Object.freeze([
  "router_provider_stop_unverified",
]);

export function isServerTransientRetryCode(code: string | null | undefined): boolean {
  return Boolean(code && SERVER_TRANSIENT_RETRY_CODES.includes(code));
}

export function suppressesTransientRetry(code: string | null | undefined): boolean {
  return Boolean(code && ADAPTER_DECLARED_WAIT_NO_TRANSIENT_RETRY_CODES.includes(code));
}

export function adapterDeclaredWaitMaxMs(code: string | null | undefined): number {
  return (code && ADAPTER_DECLARED_WAIT_MAX_MS_BY_CODE[code]) || ADAPTER_DECLARED_WAIT_MAX_MS;
}
