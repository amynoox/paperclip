// STUDIO-0063 (v6, point A): the periodic hand-over backstop, the "no silence" guarantee. The routes, the native
// status decision and the decision cards wake a dependent's assignee when its dependencies change; any other writer
// (plugins, runner tools, recovery paths, a direct service write) is caught here.
//
// Target: an issue assigned to an invocable agent that carries a hold trace since the assignee's hand-over base
// (held-dependency-comments.ts: hasHoldTraceSince), that is ready or waits only on cancelled blockers, and that has
// no live wake (queued, deferred, claimed) nor live run (queued, running, scheduled retry) of the assignee on it.
// Action: a wake whose admitted run carries the held comments. When only cancelled blockers are left, the wake is on
// the STUDIO-0029 hand-back comment (written if missing).
// Stop: a QUALIFIED run of the assignee after the trace moves the base past it (never "a wake was queued"). A run
// that fails, or never reaches the engine, leaves the issue eligible and a later pass wakes it again.
// Never a loop: the first re-wake comes at the next pass, then the wait between two backstop wakes of the same issue
// doubles (30 s, 1 min, 2 min... up to 1 h), counted from the backstop's own wake requests since the base. An issue
// whose runs never qualify (a router that refuses for hours, an adapter that reports no process start) is retried at
// most hourly, forever: late, never silent.
// Left alone: an issue with an active recovery action (its owner, the Board for a blocked execution path, decides the
// continuation; resolving it runs this pass again), and an assignee that is not invocable or over budget (the pass
// resumes when it is).
// Cadence: the stranded-assignment and resolved-dependency recovery queues (recovery/work.ts) check each open assigned
// issue (todo, in_progress, in_review; blocked) at every rebuild, 30 s after the previous complete scan, and on every
// notifyIssueRecovery (a status or blocker change). A forgotten writer costs at most one rebuild plus the pass.
import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import { agentWakeupRequests, agents, heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { issueService } from "../issues.js";
import { evaluateAgentInvokabilityFromDb } from "../agent-invokability.js";
import { ISSUE_BLOCKERS_RESOLVED_WAKE_REASON } from "../issue-dependency-wakeups.js";
import {
  allUnresolvedBlockersCancelled,
  handBackDependentsLeftWithCancelledBlockers,
  hasHoldTraceSince,
  readHandOverBase,
} from "../heartbeat/held-dependency-comments.js";

const LIVE_WAKE_STATUSES = ["queued", "deferred_issue_execution", "claimed"];
const LIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"];
export const HELD_HANDOVER_BACKSTOP_ACTOR_ID = "held_comment_handover_backstop";
export const HELD_HANDOVER_BACKSTOP_FIRST_WAIT_MS = 30_000;
export const HELD_HANDOVER_BACKSTOP_MAX_WAIT_MS = 60 * 60_000;

/** Wait before the next backstop wake of an issue, after `earlierWakes` of them since its base. */
export function heldHandoverBackstopWaitMs(earlierWakes: number): number {
  if (earlierWakes <= 1) return 0;
  return Math.min(HELD_HANDOVER_BACKSTOP_FIRST_WAIT_MS * 2 ** (earlierWakes - 2), HELD_HANDOVER_BACKSTOP_MAX_WAIT_MS);
}

export type HeldCommentHandoverWake = (agentId: string, request: {
  source: "automation";
  triggerDetail: "system";
  reason: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  requestedByActorType: "system";
  requestedByActorId: string;
  contextSnapshot: Record<string, unknown>;
}) => Promise<unknown>;

export type HeldCommentHandoverOutcome =
  | "not_target" | "agent_not_invocable" | "no_trace" | "not_ready" | "live_path" | "recovery_action" | "waiting"
  | "woken" | "handed_back";

export async function reconcileHeldCommentHandover(db: Db, input: {
  companyId: string;
  issueId: string;
  wake: HeldCommentHandoverWake;
  invocationBlocked?: (agentId: string, issueId: string) => Promise<boolean>;
  now?: Date;
  /** The next time this issue is worth another look (the end of a wait between two backstop wakes). */
  onDeferredDeadline?: (at: number) => void;
}): Promise<HeldCommentHandoverOutcome> {
  const [issue] = await db.select({
    id: issues.id, assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId,
    status: issues.status, hiddenAt: issues.hiddenAt, conversationAgentId: issues.conversationAgentId,
  }).from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)));
  if (!issue?.assigneeAgentId || issue.assigneeUserId || issue.hiddenAt || issue.conversationAgentId
    || ["done", "cancelled", "backlog"].includes(issue.status)) return "not_target";
  const assigneeAgentId = issue.assigneeAgentId;
  // The cheap reads first: a hold trace since the assignee's base. Most issues stop here.
  const base = await readHandOverBase(db, { companyId: input.companyId, issueId: issue.id, agentId: assigneeAgentId });
  if (!(await hasHoldTraceSince(db, { companyId: input.companyId, issueId: issue.id, assigneeAgentId, base }))) return "no_trace";
  const readiness = (await issueService(db).listDependencyReadiness(input.companyId, [issue.id])).get(issue.id);
  const ready = !readiness || readiness.isDependencyReady;
  const onlyCancelledLeft = !ready && await allUnresolvedBlockersCancelled(db, {
    companyId: input.companyId, unresolvedBlockerIssueIds: readiness?.unresolvedBlockerIssueIds ?? [],
  });
  if (!ready && !onlyCancelledLeft) return "not_ready";
  const [liveWake] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId),
    eq(agentWakeupRequests.agentId, assigneeAgentId),
    inArray(agentWakeupRequests.status, LIVE_WAKE_STATUSES),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`,
  )).limit(1);
  const [liveRun] = liveWake ? [] : await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, assigneeAgentId),
    inArray(heartbeatRuns.status, LIVE_RUN_STATUSES),
    sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`,
  )).limit(1);
  if (liveWake || liveRun) return "live_path";
  const [recoveryAction] = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, input.companyId),
    eq(issueRecoveryActions.sourceIssueId, issue.id),
    inArray(issueRecoveryActions.status, ["active", "escalated"]),
  )).limit(1);
  if (recoveryAction) return "recovery_action";
  const [agent] = await db.select().from(agents).where(and(eq(agents.companyId, input.companyId), eq(agents.id, assigneeAgentId)));
  if (!agent || !(await evaluateAgentInvokabilityFromDb(db, agent)).invokable) return "agent_not_invocable";
  if (input.invocationBlocked && await input.invocationBlocked(assigneeAgentId, issue.id)) return "agent_not_invocable";
  // The wait between two backstop wakes of this issue doubles; counted from the backstop's own requests since the base.
  const now = input.now ?? new Date();
  const keyPrefix = `held-handover-backstop:${issue.id}:`;
  const earlier = await db.select({ requestedAt: agentWakeupRequests.requestedAt }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId),
    eq(agentWakeupRequests.agentId, assigneeAgentId),
    like(agentWakeupRequests.idempotencyKey, `${keyPrefix}%`),
    base.traceSince ? sql`${agentWakeupRequests.requestedAt} > ${base.traceSince.toISOString()}::timestamptz` : undefined,
  )).orderBy(desc(agentWakeupRequests.requestedAt)).limit(64);
  if (earlier.length > 0) {
    const nextAt = earlier[0]!.requestedAt.getTime() + heldHandoverBackstopWaitMs(earlier.length + 1);
    if (now.getTime() < nextAt) {
      input.onDeferredDeadline?.(nextAt);
      return "waiting";
    }
  }
  const idempotencyKey = `${keyPrefix}${now.toISOString()}`;
  if (onlyCancelledLeft) {
    const [handoff] = await handBackDependentsLeftWithCancelledBlockers(db, {
      companyId: input.companyId, dependentIds: [issue.id], evenIfWoken: true,
    });
    if (handoff) {
      await input.wake(assigneeAgentId, {
        source: "automation", triggerDetail: "system", reason: "issue_commented",
        payload: { issueId: issue.id, commentId: handoff.commentId, mutation: "comment",
          cancelledBlockerIssueId: handoff.cancelledBlockerIssueId },
        idempotencyKey,
        requestedByActorType: "system", requestedByActorId: HELD_HANDOVER_BACKSTOP_ACTOR_ID,
        contextSnapshot: { issueId: issue.id, taskId: issue.id, commentId: handoff.commentId, wakeCommentId: handoff.commentId,
          source: "issue.held_comment_handover_backstop", wakeReason: "issue_commented",
          cancelledBlockerIssueId: handoff.cancelledBlockerIssueId },
      });
      return "handed_back";
    }
    return "not_ready";
  }
  await input.wake(assigneeAgentId, {
    source: "automation", triggerDetail: "system", reason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
    payload: { issueId: issue.id, blockerIssueIds: readiness?.blockerIssueIds ?? [], mutation: "held_comment_handover_backstop" },
    idempotencyKey,
    requestedByActorType: "system", requestedByActorId: HELD_HANDOVER_BACKSTOP_ACTOR_ID,
    contextSnapshot: { issueId: issue.id, taskId: issue.id, wakeReason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
      source: "issue.held_comment_handover_backstop", blockerIssueIds: readiness?.blockerIssueIds ?? [] },
  });
  return "woken";
}
