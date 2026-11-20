import { isGovernancePauseStop } from "./governance-pause-stop.js";
import { readRunCancellation } from "./run-cancellation.js";

/**
 * STUDIO-0075: which cancelled runs leave the session their engine opened to their task.
 *
 * A run a PAUSE cut always does: it was stopped on purpose, by the control plane, and the role is to go on where it
 * was (the owner's rule, 20 Nov 2026).
 *
 * A run a PERSON stopped (the Board's Stop, or any cancellation a person signed) does when this switch is on. The
 * owner decided it on 20 Nov 2026: after a person stops a run in Paperclip and then writes, the role keeps its
 * conversation. This departs from the product's own rule ("New user input will use a fresh session"). Off, the
 * product's rule holds again: the session of such a run is left aside when its result comes late, and the person's
 * next request opens a new conversation. One line, one name: nothing else reads the decision.
 *
 * Any other cancellation (a lost controller lease, a reassignment, a shutdown) keeps the product's rule.
 */
export const KEEP_SESSION_AFTER_PERSON_STOP = true;

type CancelledRun = { status: string; resultJson?: Record<string, unknown> | null };

/** A person stopped this run: its cancellation record names a user as its author. */
export function isPersonStop(run: CancelledRun): boolean {
  return run.status === "cancelled" && readRunCancellation(run.resultJson ?? undefined)?.initiator.type === "user";
}

/**
 * The session of this cancelled run may become its task's session, and a person's request that continues the run
 * may go on in it.
 */
export function cancelledRunKeepsSession(run: CancelledRun): boolean {
  return isGovernancePauseStop(run) || (KEEP_SESSION_AFTER_PERSON_STOP && isPersonStop(run));
}
