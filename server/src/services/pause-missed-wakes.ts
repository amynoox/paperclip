import { and, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issues, type Db } from "@paperclipai/db";

/**
 * STUDIO-0028: wakes refused while an agent was paused.
 *
 * A pause saves a person's comment and replays it when the pause lifts, but any
 * other wake for the paused agent (a dependency that resolved, a comment from
 * another agent, an automatic signal) is recorded as `skipped` with reason
 * `agent.not_invokable` and never replayed. Production, 13 Nov 2026: the
 * Quality Manager missed three wakes on TR-29 during the 19:20–20:08 pause and
 * only resumed after an operator note.
 *
 * When the agent becomes ready again, wake it once per task it still owns that
 * received such a skipped wake and has had no run of this agent since. The
 * idempotency key names the latest skipped wake, so a repeated resume or a
 * concurrent caller never doubles the wake.
 */
export const PAUSE_MISSED_WAKE_REASON = "issue_wakes_missed_during_pause";
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const NOT_INVOKABLE_REASONS = ["agent.not_invokable"];

type Wakeup = (agentId: string, opts: {
  source: "automation";
  triggerDetail: "system";
  reason: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  requestedByActorType: "system";
  requestedByActorId: string;
  contextSnapshot: Record<string, unknown>;
}) => Promise<unknown>;

export async function replayWakesMissedDuringPause(db: Db, input: {
  companyId: string;
  agentId: string;
  wakeup: Wakeup;
  now?: Date;
}): Promise<{ issues: number; woken: number }> {
  const since = new Date((input.now ?? new Date()).getTime() - LOOKBACK_MS);
  const skipped = await db.select({
    id: agentWakeupRequests.id,
    issueId: sql<string | null>`${agentWakeupRequests.payload}->>'issueId'`,
    finishedAt: agentWakeupRequests.finishedAt,
    reason: agentWakeupRequests.reason,
  }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId),
    eq(agentWakeupRequests.agentId, input.agentId),
    eq(agentWakeupRequests.status, "skipped"),
    inArray(agentWakeupRequests.reason, NOT_INVOKABLE_REASONS),
    isNotNull(agentWakeupRequests.finishedAt),
    gt(agentWakeupRequests.finishedAt, since),
  )).orderBy(desc(agentWakeupRequests.finishedAt));

  const latestByIssue = new Map<string, { id: string; finishedAt: Date }>();
  for (const row of skipped) {
    if (!row.issueId || !/^[0-9a-f-]{36}$/i.test(row.issueId) || latestByIssue.has(row.issueId)) continue;
    latestByIssue.set(row.issueId, { id: row.id, finishedAt: row.finishedAt! });
  }

  let woken = 0;
  for (const [issueId, missed] of latestByIssue) {
    const [issue] = await db.select({ id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId })
      .from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, issueId))).limit(1);
    if (!issue || issue.assigneeAgentId !== input.agentId) continue;
    if (["done", "cancelled", "backlog"].includes(issue.status)) continue;
    const [later] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
      gt(heartbeatRuns.createdAt, missed.finishedAt),
    )).limit(1);
    if (later) continue;
    try {
      await input.wakeup(input.agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: PAUSE_MISSED_WAKE_REASON,
        payload: { issueId, mutation: "pause_lifted", missedWakeRequestId: missed.id },
        idempotencyKey: `pause-missed:${input.agentId}:${issueId}:${missed.id}`,
        requestedByActorType: "system",
        requestedByActorId: "pause-missed-wakes",
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: PAUSE_MISSED_WAKE_REASON,
          source: "agent.pause_lifted",
          missedWakeRequestId: missed.id,
        },
      });
      woken += 1;
    } catch {
      // A wake refused now (a new pause, a budget stop, a blocked task) is not
      // lost: its own refusal is recorded, and the next resume retries it.
    }
  }
  return { issues: latestByIssue.size, woken };
}
