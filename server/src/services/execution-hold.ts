import { and, eq, inArray } from "drizzle-orm";
import { issueRecoveryActions, type Db } from "@paperclipai/db";
import { executionBlockerPredicate, getExecutionBlocker } from "./execution-blocker.js";

/**
 * STUDIO-0071: the recovery action that holds a task's execution, listed in the task's response.
 *
 * Production, 19 Nov 2026: two runs cut by a pause each left a hold that was settled `resolved` with
 * `automaticRecovery.replay = "blocked"`. Such a hold still blocks every execution of the task
 * (executionBlockerPredicate) but is no longer an active action: `activeRecoveryAction` was null, the task lists
 * showed nothing and the task stayed `todo` while its wakes waited.
 *
 * The field is read from getExecutionBlocker, the function admission itself asks, so it can neither say "held" nor
 * "free" differently from admission. `activeRecoveryAction` is left alone: it also decides who may change the task.
 */
export type ExecutionHold = {
  recoveryActionId: string;
  cause: string;
  runId: string | null;
  /** What to do to release the hold, as admission states it. */
  nextAction: string;
  /** False when the hold is not the task's active recovery action: nothing else lists it. */
  listedAsActiveAction: boolean;
};

type ExecutionBlocker = Awaited<ReturnType<typeof getExecutionBlocker>>;

export function executionHoldOf(blocker: ExecutionBlocker, activeRecoveryActionId: string | null | undefined): ExecutionHold | null {
  // A hold without a recovery action is a process or a lease still held by the previous run: it ends by itself.
  if (!blocker?.recoveryActionId) return null;
  return { recoveryActionId: blocker.recoveryActionId, cause: blocker.cause, runId: blocker.runId ?? null,
    nextAction: blocker.nextAction, listedAsActiveAction: blocker.recoveryActionId === activeRecoveryActionId };
}

/**
 * How many confirmations of a list run at once: half of the database pool's default size (10 connections), each
 * confirmation making one query at a time, so that a list never takes the whole pool from the rest of the server.
 */
export const EXECUTION_HOLD_CONFIRMATIONS_AT_ONCE = 5;

/**
 * The holds of a list of tasks. One grouped read finds the tasks that have a recovery action able to hold execution;
 * each of them is then confirmed by getExecutionBlocker, so the list never states a rule of its own.
 */
export async function listExecutionHolds(db: Db, companyId: string, issueIds: string[],
  activeRecoveryActionId: (issueId: string) => string | null | undefined): Promise<Map<string, ExecutionHold>> {
  const holds = new Map<string, ExecutionHold>();
  const ids = [...new Set(issueIds)];
  if (!ids.length) return holds;
  const candidates = await db.selectDistinct({ issueId: issueRecoveryActions.sourceIssueId }).from(issueRecoveryActions)
    .where(and(eq(issueRecoveryActions.companyId, companyId), inArray(issueRecoveryActions.sourceIssueId, ids),
      executionBlockerPredicate()));
  // After a general pause most tasks of a list are held: the confirmations run several at once. The first failure
  // fails the whole read, because a partial map would say "nothing holds" for the tasks it did not confirm.
  let next = 0;
  let failed = false;
  const confirmNext = async () => {
    while (!failed && next < candidates.length) {
      const { issueId } = candidates[next++]!;
      try {
        const hold = executionHoldOf(await getExecutionBlocker(db, companyId, issueId), activeRecoveryActionId(issueId));
        if (hold) holds.set(issueId, hold);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(EXECUTION_HOLD_CONFIRMATIONS_AT_ONCE, candidates.length) }, confirmNext));
  return holds;
}
