// STUDIO-0083: one way to hand a ticket to the direct manager of the role it is assigned to, in place of a block
// with a Board action nobody but the operator can settle.
//
// The ticket is reassigned to the manager (the assignee's `reportsTo`), moved to `in_review`, a notice says why and
// what the manager is expected to do, and the manager is woken once. No recovery action is created: the manager
// closes the ticket or gives it back with its own rights (it is the assignee).
//
// The ticket is NOT handed, and the caller keeps today's path, when:
// - the ticket is not at work (`todo`, `in_progress`), is hidden, or is no longer assigned to that role;
// - the role has no manager, or the manager is the role itself, another company's, or not invokable;
// - the ticket still holds something on the server: a queued or running run, an execution or checkout lock on a
//   run that has not ended, an environment lease not released (the lease of the run that caused the hand-over
//   aside: its own end releases it);
// - the same run already caused a hand-over, or the ticket was already handed twice for the same cause since the
//   role last ran on it for another reason (the bound against a to-and-fro between the role and its manager).
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, environmentLeases, heartbeatRuns, issues } from "@paperclipai/db";
import { evaluateAgentInvokabilityFromDb } from "../agent-invokability.js";
import { logActivity, publishActivity, type ActivityPublication } from "../activity-log.js";
import { executeIssuePostCommitActions, issueService, type IssuePostCommitAction } from "../issues.js";
import { agentLinkRow, keyValueRow, runLinkRow, systemNoticePresentation } from "./notice-format.js";

export const MANAGER_HANDOVER_ACTIVITY_ACTION = "issue.handed_to_manager";
export const MANAGER_HANDOVER_WAKE_REASON = "issue_handed_to_manager";
/** The wake of a manager on a ticket that is not its own: a comment wake, the one the queue starts for another agent. */
export const BOARD_BLOCK_MANAGER_WAKE_REASON = "issue_commented";
/** Hand-overs of one ticket for one cause, in one series, before today's path takes over. */
export const MANAGER_HANDOVER_MAX_PER_SERIES = 2;

const WORK_STATUSES: readonly string[] = Object.freeze(["todo", "in_progress"]);
const LIVE_RUN_STATUSES = ["queued", "running"] as const;

export type ManagerHandoverNote = {
  title: string;
  /** `{manager}` is replaced by the manager's name. */
  body: string;
  /** What the manager is expected to do, one sentence. */
  nextAction: string;
};

export type ManagerHandoverInput = {
  issue: { id: string; companyId: string };
  /** The role the ticket is taken from. It must still be the assignee. */
  fromAgentId: string;
  /** A stable key of the reason, kept in the activity: `router_refusal`, `relaunch_loop`, `ssh_lease_outage`. */
  cause: string;
  /** The code shown in the notice and kept in the activity (a run error code), if any. */
  code: string | null;
  /** The run that caused the hand-over, if any. One run causes one hand-over at most. */
  sourceRun: { id: string; status: string; agentId: string | null } | null;
  note: ManagerHandoverNote;
};

export type ManagerHandoverRefusal =
  | "issue_not_found"
  | "issue_not_at_work"
  | "assignee_changed"
  | "no_manager"
  | "manager_not_invokable"
  | "still_held"
  | "run_already_handed"
  | "handed_before";

export type ManagerHandoverResult =
  | { handed: true; managerAgentId: string; managerName: string; issue: typeof issues.$inferSelect }
  | { handed: false; reason: ManagerHandoverRefusal };

export type ManagerHandoverWakeup = (
  agentId: string,
  opts: {
    source: "automation";
    triggerDetail: "system";
    reason: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
    contextSnapshot: Record<string, unknown>;
    requestedByActorType: "system";
    requestedByActorId: string | null;
  },
) => Promise<unknown>;

type HandoverActivity = { createdAt: Date; sourceRunId: string | null };

/** The hand-overs of a ticket from one role for one cause, newest first. */
export async function readManagerHandovers(
  db: Pick<Db, "select">,
  input: { companyId: string; issueId: string; fromAgentId?: string; cause?: string },
): Promise<HandoverActivity[]> {
  const rows = await db
    .select({ createdAt: activityLog.createdAt, details: activityLog.details })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, input.companyId),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, input.issueId),
      eq(activityLog.action, MANAGER_HANDOVER_ACTIVITY_ACTION),
      input.fromAgentId ? sql`${activityLog.details} ->> 'fromAgentId' = ${input.fromAgentId}` : undefined,
      input.cause ? sql`${activityLog.details} ->> 'cause' = ${input.cause}` : undefined,
    ))
    .orderBy(desc(activityLog.createdAt));
  return rows.map((row) => {
    const sourceRunId = (row.details as Record<string, unknown> | null)?.sourceRunId;
    return { createdAt: row.createdAt, sourceRunId: typeof sourceRunId === "string" ? sourceRunId : null };
  });
}

/**
 * When the ticket was last handed to a manager, for a caller that must not read again a failure older than that
 * (the manager gave the ticket back: the role has not run since).
 */
export async function readLatestManagerHandoverAt(
  db: Pick<Db, "select">,
  input: { companyId: string; issueId: string },
): Promise<Date | null> {
  return (await readManagerHandovers(db, input))[0]?.createdAt ?? null;
}

export async function handIssueToManager(
  db: Db,
  deps: { enqueueWakeup: ManagerHandoverWakeup },
  input: ManagerHandoverInput,
): Promise<ManagerHandoverResult> {
  const publications: ActivityPublication[] = [];
  const postCommitActions: IssuePostCommitAction[] = [];
  const result = await db.transaction(async (tx): Promise<ManagerHandoverResult> => {
    const database = tx as unknown as Db;
    const [current] = await tx.select().from(issues)
      .where(and(eq(issues.companyId, input.issue.companyId), eq(issues.id, input.issue.id)))
      .for("update").limit(1);
    if (!current || current.hiddenAt) return { handed: false, reason: "issue_not_found" };
    if (!WORK_STATUSES.includes(current.status)) return { handed: false, reason: "issue_not_at_work" };
    if (current.assigneeAgentId !== input.fromAgentId || current.assigneeUserId) return { handed: false, reason: "assignee_changed" };

    const [role] = await tx.select().from(agents)
      .where(and(eq(agents.companyId, current.companyId), eq(agents.id, input.fromAgentId))).limit(1);
    if (!role?.reportsTo || role.reportsTo === role.id) return { handed: false, reason: "no_manager" };
    const [manager] = await tx.select().from(agents)
      .where(and(eq(agents.companyId, current.companyId), eq(agents.id, role.reportsTo))).limit(1);
    if (!manager) return { handed: false, reason: "no_manager" };
    if (!(await evaluateAgentInvokabilityFromDb(database, manager)).invokable) return { handed: false, reason: "manager_not_invokable" };

    // Nothing of the ticket is still held on the server.
    const [liveRun] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, current.companyId),
        inArray(heartbeatRuns.status, [...LIVE_RUN_STATUSES]),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${current.id}`,
      )).limit(1);
    if (liveRun) return { handed: false, reason: "still_held" };
    const lockRunIds = [current.executionRunId, current.checkoutRunId].filter((id): id is string => Boolean(id));
    if (lockRunIds.length > 0) {
      const [liveLock] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .where(and(inArray(heartbeatRuns.id, lockRunIds), inArray(heartbeatRuns.status, [...LIVE_RUN_STATUSES]))).limit(1);
      if (liveLock) return { handed: false, reason: "still_held" };
    }
    const [lease] = await tx.select({ id: environmentLeases.id }).from(environmentLeases)
      .where(and(
        eq(environmentLeases.companyId, current.companyId),
        eq(environmentLeases.issueId, current.id),
        eq(environmentLeases.status, "active"),
        isNull(environmentLeases.releasedAt),
        input.sourceRun ? sql`${environmentLeases.heartbeatRunId} is distinct from ${input.sourceRun.id}` : undefined,
      )).limit(1);
    if (lease) return { handed: false, reason: "still_held" };

    // One run causes one hand-over; a series of the same cause is bounded.
    const earlier = await readManagerHandovers(tx, {
      companyId: current.companyId, issueId: current.id, fromAgentId: input.fromAgentId, cause: input.cause,
    });
    if (input.sourceRun && earlier.some((handover) => handover.sourceRunId === input.sourceRun!.id)) {
      return { handed: false, reason: "run_already_handed" };
    }
    // The series ends at the role's latest started run on the ticket that did not fail under this code.
    const [otherRun] = await tx.select({ createdAt: heartbeatRuns.createdAt }).from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, current.companyId),
        eq(heartbeatRuns.agentId, input.fromAgentId),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${current.id}`,
        sql`${heartbeatRuns.startedAt} is not null`,
        input.code
          ? sql`(${heartbeatRuns.status} <> 'failed' or ${heartbeatRuns.errorCode} is distinct from ${input.code})`
          : ne(heartbeatRuns.status, "failed"),
      ))
      .orderBy(desc(heartbeatRuns.createdAt)).limit(1);
    const inSeries = earlier.filter((handover) => !otherRun || handover.createdAt > otherRun.createdAt);
    if (inSeries.length >= MANAGER_HANDOVER_MAX_PER_SERIES) return { handed: false, reason: "handed_before" };

    const issuesSvc = issueService(database);
    const updated = await issuesSvc.update(current.id, {
      status: "in_review",
      assigneeAgentId: manager.id,
      assigneeUserId: null,
      companyGuard: current.companyId,
    }, tx, publications, postCommitActions);
    if (!updated) return { handed: false, reason: "issue_not_found" };

    const again = inSeries.length > 0;
    await issuesSvc.addComment(
      current.id,
      input.note.body.replaceAll("{manager}", manager.name)
        + (again ? ` This ticket was already handed to ${manager.name} for the same reason and given back; it will not be handed a third time.` : ""),
      {},
      {
        authorType: "system",
        presentation: systemNoticePresentation({ tone: "warning", title: input.note.title }),
        metadata: {
          version: 1,
          ...(input.sourceRun ? { sourceRunId: input.sourceRun.id } : {}),
          sections: [{
            title: "Handed to the manager",
            rows: [
              agentLinkRow("From", { id: role.id, name: role.name }),
              agentLinkRow("To", { id: manager.id, name: manager.name }),
              ...(input.sourceRun ? [runLinkRow("Run", input.sourceRun)] : []),
              ...(input.code ? [keyValueRow("Code", input.code)] : []),
              keyValueRow("Next action", input.note.nextAction),
            ],
          }],
        },
      },
      tx,
    );
    await logActivity(database, {
      companyId: current.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: null,
      action: MANAGER_HANDOVER_ACTIVITY_ACTION,
      entityType: "issue",
      entityId: current.id,
      details: {
        identifier: current.identifier,
        cause: input.cause,
        code: input.code,
        fromAgentId: role.id,
        toAgentId: manager.id,
        previousStatus: current.status,
        status: "in_review",
        sourceRunId: input.sourceRun?.id ?? null,
        handoverInSeries: inSeries.length + 1,
      },
    }, publications);
    return { handed: true, managerAgentId: manager.id, managerName: manager.name, issue: updated as typeof issues.$inferSelect };
  });
  if (!result.handed) return result;

  for (const publication of publications) publishActivity(publication);
  await executeIssuePostCommitActions(db, postCommitActions);
  // The wake is a row of the database: a restart between the commit and this line loses it, and the ticket is
  // then in review at the manager, who sees it at its next run on anything.
  // At the release of the refused run the previous owner's execution is not settled yet: the queue keeps this wake
  // (STUDIO-0066, a hand-over wake while the previous run stops) and its periodic pass admits it once the ticket
  // has no execution blocker left.
  await deps.enqueueWakeup(result.managerAgentId, {
    source: "automation",
    triggerDetail: "system",
    reason: MANAGER_HANDOVER_WAKE_REASON,
    idempotencyKey: `manager-handover:${input.issue.id}:${input.sourceRun?.id ?? input.cause}`,
    payload: { issueId: input.issue.id, mutation: "manager_handover", cause: input.cause, code: input.code },
    requestedByActorType: "system",
    requestedByActorId: null,
    contextSnapshot: {
      issueId: input.issue.id,
      taskId: input.issue.id,
      wakeReason: MANAGER_HANDOVER_WAKE_REASON,
      source: "issue.manager_handover",
      handoverCause: input.cause,
      ...(input.code ? { handoverCode: input.code } : {}),
      ...(input.sourceRun ? { handoverSourceRunId: input.sourceRun.id } : {}),
    },
  });
  return result;
}

export const BOARD_BLOCK_MANAGER_NOTICE_TITLE = "Blocked for the Board: the manager is woken";

/**
 * L16: the server blocked a ticket with a recovery action only the Board can settle. Nobody was woken: the direct
 * manager of the role is woken once per action, to look and to warn. Nothing else changes: the ticket stays blocked
 * and the action stays the Board's.
 * The manager is not the assignee, and the queue starts a run of another agent on a ticket only for a comment
 * (run-dispatch/domain/policy.ts, decideIssueOwnership): so the server writes one notice on the ticket, addressed to
 * the manager, and wakes it on that comment, as a person's comment would.
 * Not woken: a role without a manager (the CEO), a manager that is not invokable, and a manager whose own run is the
 * one that led to the block.
 */
export async function wakeManagerOfBlockedIssue(
  db: Db,
  deps: { enqueueWakeup: ManagerHandoverWakeup },
  input: {
    issue: { id: string; companyId: string; assigneeAgentId: string | null };
    recoveryActionId: string;
    cause: string;
    sourceRun: { id: string; agentId: string | null; errorCode?: string | null } | null;
  },
): Promise<{ woken: true; managerAgentId: string } | { woken: false; reason: "no_assignee" | "no_manager" | "manager_not_invokable" | "manager_is_the_cause" }> {
  if (!input.issue.assigneeAgentId) return { woken: false, reason: "no_assignee" };
  const [role] = await db.select().from(agents)
    .where(and(eq(agents.companyId, input.issue.companyId), eq(agents.id, input.issue.assigneeAgentId))).limit(1);
  if (!role?.reportsTo || role.reportsTo === role.id) return { woken: false, reason: "no_manager" };
  const [manager] = await db.select().from(agents)
    .where(and(eq(agents.companyId, input.issue.companyId), eq(agents.id, role.reportsTo))).limit(1);
  if (!manager) return { woken: false, reason: "no_manager" };
  if (input.sourceRun?.agentId === manager.id) return { woken: false, reason: "manager_is_the_cause" };
  if (!(await evaluateAgentInvokabilityFromDb(db, manager)).invokable) return { woken: false, reason: "manager_not_invokable" };
  const comment = await issueService(db).addComment(
    input.issue.id,
    `This ticket of ${role.name} was blocked with a recovery action only the Board can settle (\`${input.cause}\`). `
      + `${manager.name}, its direct manager, is woken once to look at it: settle the recovery action if the way forward is clear, or tell the operator. `
      + "The ticket stays blocked and stays assigned as it is.",
    {},
    {
      authorType: "system",
      presentation: systemNoticePresentation({ tone: "info", title: BOARD_BLOCK_MANAGER_NOTICE_TITLE }),
      metadata: {
        version: 1,
        ...(input.sourceRun ? { sourceRunId: input.sourceRun.id } : {}),
        sections: [{
          title: "Manager woken",
          rows: [
            agentLinkRow("Role", { id: role.id, name: role.name }),
            agentLinkRow("Manager", { id: manager.id, name: manager.name }),
            // Not "Recovery action": that label is how the server finds the escalation notice of an action
            // (noticeMetadataReferencesRecoveryAction), and this notice is not it.
            keyValueRow("Board action", input.recoveryActionId),
            keyValueRow("Cause", input.cause),
          ],
        }],
      },
    },
  );
  await deps.enqueueWakeup(manager.id, {
    source: "automation",
    triggerDetail: "system",
    reason: BOARD_BLOCK_MANAGER_WAKE_REASON,
    idempotencyKey: `board-recovery-manager-wake:${input.recoveryActionId}`,
    payload: {
      issueId: input.issue.id, commentId: comment.id, mutation: "board_recovery_manager_wake",
      recoveryActionId: input.recoveryActionId, cause: input.cause,
    },
    requestedByActorType: "system",
    requestedByActorId: null,
    contextSnapshot: {
      issueId: input.issue.id,
      taskId: input.issue.id,
      wakeReason: BOARD_BLOCK_MANAGER_WAKE_REASON,
      commentId: comment.id,
      wakeCommentId: comment.id,
      source: "issue.comment",
      boardRecoveryManagerWake: true,
      recoveryActionId: input.recoveryActionId,
      recoveryCause: input.cause,
      blockedAssigneeAgentId: role.id,
      ...(input.sourceRun?.errorCode ? { blockedRunErrorCode: input.sourceRun.errorCode } : {}),
    },
  });
  return { woken: true, managerAgentId: manager.id };
}
