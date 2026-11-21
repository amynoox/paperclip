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
// STUDIO-0059: refusals the worker router returns BEFORE any reservation (no
// machine contacted, no engine launched, no dispatch created). Asking again
// cannot succeed (router contract,
// drafts/routeur-deux-moteurs/refus-sans-relance-pour-serveur.md), so none of
// them is retried. Production 15-16 Nov 2026: TR-1261 (three refused runs,
// then blocked), TR-1318 (`in_review`, refused `_ended` then `_closed`, then
// blocked by recovery). What follows a refusal depends on the code:
// - router_group_participant_reserved (router 0.30.14): a listed participant
//   already holds its own reservation; only replacing it lets the group pass.
// - router_group_participant_mismatch: another participant is not a child of
//   the same coordinating ticket, or names another group; only correcting the
//   `worker-router` block of the description lets it pass.
//   Both need a person's gesture: the issue is blocked AT ONCE, with a notice
//   naming the code, its meaning and the gesture, and a Board recovery action.
// - router_group_participant_closed: another listed participant is done or
//   cancelled. Blocked the same way while this issue still has work to do
//   (`todo`, `in_progress`); otherwise a note only, as `_ended` below.
// - router_group_participant_ended: this participant's part is finished.
//   Blocked the same way while this issue still has work to do (nothing
//   changes without a retry, so waiting would only delay the same block).
//   Once in review or done, neither retried nor blocked: the status stays and
//   one note per series says so (TR-1318). A new comment still wakes it, and
//   the router refuses again at no cost.
// - router_ticket_blocked: the ticket is blocked; its dependency wake starts
//   it again once unblocked. It stays a bounded wait (list below).
export const ROUTER_REFUSAL_ERROR_CODES: readonly string[] = Object.freeze([
  "router_group_participant_ended",
  "router_group_participant_closed",
  "router_group_participant_mismatch",
  "router_group_participant_reserved",
]);

export type RouterRefusalOutcome = "block" | "note";

const ROUTER_REFUSAL_WORK_STATUSES: readonly string[] = Object.freeze(["todo", "in_progress"]);

// What a refused run leads to, by its error code and the issue's status; null
// for any other code (that run keeps today's path).
export function routerRefusalOutcome(
  code: string | null | undefined,
  issueStatus: string | null | undefined,
): RouterRefusalOutcome | null {
  switch (code) {
    case "router_group_participant_reserved":
    case "router_group_participant_mismatch":
      return "block";
    case "router_group_participant_closed":
    case "router_group_participant_ended":
      return issueStatus && ROUTER_REFUSAL_WORK_STATUSES.includes(issueStatus) ? "block" : "note";
    default:
      return null;
  }
}

export type RouterRefusalText = { title: string; meaning: string; gesture: string | null };

const ROUTER_REFUSAL_TEXTS: Readonly<Record<string, RouterRefusalText>> = Object.freeze({
  router_group_participant_reserved: {
    title: "Worker router: a participant is already reserved",
    meaning: "another participant listed in this ticket's group already holds its own machine reservation, so the group cannot be reserved",
    gesture: "Replace the already-reserved participant in the `worker-router` block of the description (or wait for its reservation to end), then move this issue back to `todo`.",
  },
  router_group_participant_mismatch: {
    title: "Worker router: the group list is wrong",
    meaning: "another participant listed in this ticket's group is not a child of the same coordinating ticket, or names another group",
    gesture: "Correct the `worker-router` block of the description so every participant is a child of the same coordinating ticket and names this group, then move this issue back to `todo`.",
  },
  router_group_participant_closed: {
    title: "Worker router: a participant is closed",
    meaning: "another participant listed in this ticket's group is done or cancelled",
    gesture: "Remove the finished or cancelled participant from the `worker-router` block of the description (or reopen it), then move this issue back to `todo`.",
  },
  router_group_participant_ended: {
    title: "Worker router: this participant's part is finished",
    meaning: "this participant has finished its part of the group",
    gesture: "If this participant's part is finished, move the issue to review or done; otherwise reassign it, or correct the participant in the `worker-router` block of the description.",
  },
});

export function routerRefusalText(code: string): RouterRefusalText {
  return ROUTER_REFUSAL_TEXTS[code] ?? { title: "Worker router refusal", meaning: "the worker router refused the run", gesture: null };
}

// Body of the blocking notice (`block`). The run was refused before any
// reservation, so no work was lost and nothing was retried.
export function routerRefusalBlockBody(code: string): string {
  const text = routerRefusalText(code);
  return (
    `The worker router refused this run before reserving any machine (\`${code}\`): ${text.meaning}. ` +
    "Asking again cannot pass, so nothing was retried. Moving the issue to `blocked` until the group is corrected."
  );
}

// Body of the note (`note`), posted once per series of refusals under the code.
export function routerRefusalNoteBody(code: string): string {
  const text = routerRefusalText(code);
  return (
    `The worker router refused this run before reserving any machine (\`${code}\`): ${text.meaning}. ` +
    "Nothing is retried and the issue status is unchanged."
  );
}

// STUDIO-0059 (second review): router_readmission_not_drained (router 0.30.14)
// - the router's receipts of an earlier dispatch are not settled yet; the
// router settles them and the next run passes. Same kind and bound as an
// unproven stop, on any status.
export const ADAPTER_DECLARED_WAIT_ERROR_CODES: readonly string[] = Object.freeze([
  "router_waiting_for_resources",
  "router_provider_stop_unverified",
  "router_previous_dispatch_unsettled",
  "router_readmission_not_drained",
  "router_ticket_blocked",
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
  router_readmission_not_drained: ADAPTER_DECLARED_STOP_WAIT_MAX_MS,
});

// STUDIO-0059: each kind of wait counts its own series. A run under another
// kind breaks the series, so a machine wait followed by a stop wait (or by a
// dependency wait) no longer takes the latest code's bound counted from the
// first machine wait. The unproven stop and its unsettled dispatch are one
// stop (the second is the next run's view of the first).
const ADAPTER_DECLARED_STOP_SERIES: readonly string[] = Object.freeze([
  "router_provider_stop_unverified",
  "router_previous_dispatch_unsettled",
  "router_readmission_not_drained",
]);

const ADAPTER_DECLARED_WAIT_SERIES_BY_CODE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  router_waiting_for_resources: Object.freeze(["router_waiting_for_resources"]),
  router_provider_stop_unverified: ADAPTER_DECLARED_STOP_SERIES,
  router_previous_dispatch_unsettled: ADAPTER_DECLARED_STOP_SERIES,
  router_readmission_not_drained: ADAPTER_DECLARED_STOP_SERIES,
  router_ticket_blocked: Object.freeze(["router_ticket_blocked"]),
});

// Codes counted in the same series as the given wait code.
export function adapterDeclaredWaitSeriesCodes(code: string | null | undefined): readonly string[] {
  return (code && ADAPTER_DECLARED_WAIT_SERIES_BY_CODE[code]) || (code ? [code] : []);
}

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
  "router_readmission_not_drained",
  "router_ticket_blocked",
  ...ROUTER_REFUSAL_ERROR_CODES,
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

// STUDIO-0059 (second review): the note posted once per series of a declared
// wait, in review as in work, so a held issue is not silent until its bound.
const ADAPTER_DECLARED_WAIT_MEANINGS: Readonly<Record<string, string>> = Object.freeze({
  router_waiting_for_resources: "no worker machine is free; the router keeps the request and wakes the assignee when one is",
  router_provider_stop_unverified: "the link to the worker machine was cut and the engine's stop is not proven yet; the router proves it and wakes the assignee",
  router_previous_dispatch_unsettled: "the previous dispatch is not settled yet; the router settles it and wakes the assignee",
  router_readmission_not_drained: "the router's receipts of an earlier dispatch are not settled yet; the next run passes once they are",
  router_ticket_blocked: "the ticket is blocked; its dependency wake starts it again once unblocked",
});

// STUDIO-0076: reason of the start given, when a pause lifts, to a task that waits on a declared wait.
export const DECLARED_WAIT_PAUSE_LIFTED_WAKE_REASON = "issue_declared_wait_pause_lifted";

export function adapterDeclaredWaitNoteBody(code: string): string {
  const meaning = ADAPTER_DECLARED_WAIT_MEANINGS[code] ?? "the worker router declared a wait";
  const hours = adapterDeclaredWaitMaxMs(code) / (60 * 60_000);
  return (
    `The worker router held this run (\`${code}\`): ${meaning}. ` +
    `Nothing is retried meanwhile; past ${hours} h without progress, normal recovery takes over.`
  );
}
