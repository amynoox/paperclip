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
export const ADAPTER_DECLARED_WAIT_ERROR_CODES: readonly string[] = Object.freeze([
  "router_waiting_for_resources",
]);

// Bound on such a wait, counted from the oldest run of the latest consecutive
// series of the assignee's runs on the issue that all failed under a code
// above. Past it, normal stranded-work recovery applies again.
// 12 h: a machine wait depends on how long another task's reservation lasts,
// and a reservation covers every run of that task until it is released, not a
// single run. Observed on 14 Nov 2026: TR-702 held one machine from 00:46:57 to
// 03:05:44; TR-699 held another from 01:15:57 and still held it at 04:41
// (3 h 25). The router keeps the request without limit; past 12 h, normal
// escalation shows a task that has really waited too long.
export const ADAPTER_DECLARED_WAIT_MAX_MS = 12 * 60 * 60_000;

export function isAdapterDeclaredWaitErrorCode(code: string | null | undefined): boolean {
  return Boolean(code && ADAPTER_DECLARED_WAIT_ERROR_CODES.includes(code));
}
