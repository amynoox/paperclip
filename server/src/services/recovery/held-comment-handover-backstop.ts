// STUDIO-0063 (v6, point A): the periodic hand-over backstop, the "no silence" guarantee. The routes, the native
// status decision and the decision cards wake a dependent's assignee when its dependencies change; any other writer
// (plugins, runner tools, recovery paths, a direct service write) is caught here.
//
// Target: an issue assigned to an invocable agent that carries a hold trace OF THAT ASSIGNEE (the admission's skipped
// `issue_dependencies_blocked` request, or a run the claim gate cancelled with that errorCode) newer than its base
// (the start of its latest qualified run), that is ready or waits only on cancelled blockers, and that has no live
// wake (queued, deferred, claimed) nor live run (queued, running, scheduled retry) of the assignee on it.
// Action: when only cancelled blockers are left, the STUDIO-0029 hand-back comment first; then a wake whose admitted
// run carries the held comments (held-dependency-comments.ts).
// Stop: a QUALIFIED run of the assignee after the trace moves the base past it. A run that fails before the engine
// leaves the issue eligible, and the next pass wakes it again; no key prevents that second wake, only "no live wake"
// prevents a duplicate.
// Cadence: the stranded-assignment and resolved-dependency recovery queues (recovery/work.ts) rebuild every 30 s and
// also run on every notifyIssueRecovery (a status or blocker change), so a forgotten caller costs at most one rebuild
// plus the pass.
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { agentWakeupRequests, agents, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { issueService } from "../issues.js";
import { ISSUE_BLOCKERS_RESOLVED_WAKE_REASON } from "../issue-dependency-wakeups.js";
import {
  allUnresolvedBlockersCancelled,
  handBackDependentsLeftWithCancelledBlockers,
  readLatestQualifiedRunStart,
} from "../heartbeat/held-dependency-comments.js";

const NOT_INVOCABLE_AGENT_STATUSES = ["paused", "terminated", "pending_approval"];
const LIVE_WAKE_STATUSES = ["queued", "deferred_issue_execution", "claimed"];
const LIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"];

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
  | "not_target" | "agent_not_invocable" | "no_trace" | "not_ready" | "live_path" | "woken" | "handed_back";

export async function reconcileHeldCommentHandover(db: Db, input: {
  companyId: string;
  issueId: string;
  wake: HeldCommentHandoverWake;
  invocationBlocked?: (agentId: string, issueId: string) => Promise<boolean>;
}): Promise<HeldCommentHandoverOutcome> {
  const [issue] = await db.select({
    id: issues.id, assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId,
    status: issues.status, hiddenAt: issues.hiddenAt, conversationAgentId: issues.conversationAgentId,
  }).from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)));
  if (!issue?.assigneeAgentId || issue.assigneeUserId || issue.hiddenAt || issue.conversationAgentId
    || ["done", "cancelled", "backlog"].includes(issue.status)) return "not_target";
  const assigneeAgentId = issue.assigneeAgentId;
  const [agent] = await db.select({ status: agents.status }).from(agents)
    .where(and(eq(agents.companyId, input.companyId), eq(agents.id, assigneeAgentId)));
  if (!agent || NOT_INVOCABLE_AGENT_STATUSES.includes(agent.status)) return "agent_not_invocable";
  // The cheap reads first: a hold trace of this assignee after its base.
  const since = await readLatestQualifiedRunStart(db, { companyId: input.companyId, issueId: issue.id, agentId: assigneeAgentId });
  const [skipped] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId),
    eq(agentWakeupRequests.agentId, assigneeAgentId),
    eq(agentWakeupRequests.status, "skipped"),
    eq(agentWakeupRequests.reason, "issue_dependencies_blocked"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`,
    since ? gt(agentWakeupRequests.requestedAt, since) : undefined,
  )).limit(1);
  const [cancelledAtClaim] = skipped ? [] : await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, assigneeAgentId),
    eq(heartbeatRuns.status, "cancelled"),
    eq(heartbeatRuns.errorCode, "issue_dependencies_blocked"),
    sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`,
    since ? gt(heartbeatRuns.createdAt, since) : undefined,
  )).limit(1);
  if (!skipped && !cancelledAtClaim) return "no_trace";
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
  if (input.invocationBlocked && await input.invocationBlocked(assigneeAgentId, issue.id)) return "agent_not_invocable";
  const now = new Date();
  if (onlyCancelledLeft) {
    const [handoff] = await handBackDependentsLeftWithCancelledBlockers(db, { companyId: input.companyId, dependentIds: [issue.id] });
    if (handoff) {
      await input.wake(assigneeAgentId, {
        source: "automation", triggerDetail: "system", reason: "issue_commented",
        payload: { issueId: issue.id, commentId: handoff.commentId, mutation: "comment",
          cancelledBlockerIssueId: handoff.cancelledBlockerIssueId },
        idempotencyKey: `held-handover-backstop:${issue.id}:${now.toISOString()}`,
        requestedByActorType: "system", requestedByActorId: "held_comment_handover_backstop",
        contextSnapshot: { issueId: issue.id, taskId: issue.id, commentId: handoff.commentId, wakeCommentId: handoff.commentId,
          source: "issue.held_comment_handover_backstop", wakeReason: "issue_commented",
          cancelledBlockerIssueId: handoff.cancelledBlockerIssueId },
      });
      return "handed_back";
    }
    // The hand-back comment exists and was woken: wake again with the same hand-back context.
  }
  await input.wake(assigneeAgentId, {
    source: "automation", triggerDetail: "system",
    reason: onlyCancelledLeft ? "issue_commented" : ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
    payload: { issueId: issue.id, blockerIssueIds: readiness?.blockerIssueIds ?? [], mutation: "held_comment_handover_backstop" },
    idempotencyKey: `held-handover-backstop:${issue.id}:${now.toISOString()}`,
    requestedByActorType: "system", requestedByActorId: "held_comment_handover_backstop",
    contextSnapshot: { issueId: issue.id, taskId: issue.id,
      wakeReason: onlyCancelledLeft ? "issue_commented" : ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
      source: "issue.held_comment_handover_backstop", blockerIssueIds: readiness?.blockerIssueIds ?? [],
      ...(onlyCancelledLeft ? { cancelledBlockerIssueId: readiness?.unresolvedBlockerIssueIds?.[0] ?? null } : {}) },
  });
  return "woken";
}
