// STUDIO-0095: a scheduled retry its gate cancelled before any dispatch.
//
// Production, 22 Nov 2026, TR-2562. A scheduled disposition repair was cancelled by the retry gate as superseded by a
// wake that waited behind it. The release that promotes waiting wakes treats a cancelled legacy run as one whose
// actions may need reconciliation, and promotes nothing behind it; here the run never left `scheduled_retry`, so
// there is nothing to reconcile, and the wake that superseded it waited for ever.
//
// The gate leaves a receipt in the run's result when it cancels a retry. A run is "a retry its gate cancelled before
// any dispatch" when it carries that receipt AND nothing was retained of an execution (no start, no process, no
// session, no lease, no execution event): the same retained-evidence proof as the other dispatch cancellations.
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { noRetainedExecutionPredicate } from "./pre-dispatch-execution-evidence.js";

export const SCHEDULED_RETRY_SUPPRESSION_KEY = "scheduledRetrySuppression";

/** What the retry gate writes in the result of the retry it cancels. */
export function scheduledRetrySuppressionReceipt(errorCode: string) {
  return { [SCHEDULED_RETRY_SUPPRESSION_KEY]: { version: 1, errorCode } };
}

export async function isSuppressedScheduledRetryVerified(
  db: Pick<Db, "select">,
  run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "status" | "runtimeMode">,
): Promise<boolean> {
  if (run.status !== "cancelled" || run.runtimeMode !== "legacy") return false;
  const [verified] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id),
    eq(heartbeatRuns.status, "cancelled"), isNotNull(heartbeatRuns.finishedAt),
    sql`${heartbeatRuns.resultJson}->${SCHEDULED_RETRY_SUPPRESSION_KEY}::text->>'version' = '1'`,
    noRetainedExecutionPredicate(),
  )).limit(1);
  return Boolean(verified);
}
