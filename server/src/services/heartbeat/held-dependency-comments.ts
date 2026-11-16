// STUDIO-0063: an agent's comment on an issue that waits on unresolved blockers does not start the assignee's run
// (production 15 Nov 2026, TR-1258); it waits with the issue and is handed to the assignee later.
// - One decision for both gates (admission and claim): agentCommentHeldByDependencies. Nothing is recorded.
// - The issue thread is the record. What the current assignee may not have seen is every agent comment (not its own)
//   written after the START of its latest QUALIFIED run on the issue: admitted with the issue ready (not under a
//   person's, card's or stall's bounded exception), with its engine process started (processStartedAt) and
//   succeeded. Without such a run, the whole thread. An error can only repeat a comment, never lose one: a comment
//   written during a run, or merged into it, comes after its start and is handed over again by the next run.
import { and, desc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { heartbeatRuns, issueComments, issueRelations, issues, type Db } from "@paperclipai/db";
import { ISSUE_BLOCKER_STALLED_WAKE_REASON } from "@paperclipai/shared";
import { extractWakeCommentIds } from "../../modules/run-dispatch/index.js";
import { insertIssueComment } from "../issue-comment-writes.js";

export const HELD_DEPENDENCY_COMMENT_IDS_KEY = "heldDependencyCommentIds";
export const HELD_DEPENDENCY_OLDER_COUNT_KEY = "heldDependencyOlderCount";
export const HELD_DEPENDENCY_COMMENTS_SHOWN_MAX = 20;

type Reader = Pick<Db, "select">;

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Every comment a run's context wakes on: the batched ids, then the single-comment keys. */
export function wakeContextCommentIds(context: Record<string, unknown> | null | undefined): string[] {
  const ids = extractWakeCommentIds(context);
  for (const value of [context?.wakeCommentId, context?.commentId]) {
    const id = readString(value);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Whether every unresolved blocker is cancelled (nothing would ever lift them; STUDIO-0029 hands them back). */
export async function allUnresolvedBlockersCancelled(db: Reader, input: {
  companyId: string;
  unresolvedBlockerIssueIds: readonly string[];
}): Promise<boolean> {
  if (input.unresolvedBlockerIssueIds.length === 0) return false;
  const blockers = await db.select({ status: issues.status }).from(issues).where(and(
    eq(issues.companyId, input.companyId),
    inArray(issues.id, [...input.unresolvedBlockerIssueIds]),
  ));
  return blockers.length > 0 && blockers.every(row => row.status === "cancelled");
}

/**
 * Whether the comment exception of the dependency gate is withheld for this wake, because only agents wrote what it
 * carries. Read from the comments themselves, so a run that merged a person's comment with an agent's keeps the
 * person's exception. Only the issue's assignee is held (another role passes as before), and never while every
 * unresolved blocker is cancelled.
 */
export async function agentCommentHeldByDependencies(db: Reader, input: {
  companyId: string;
  issueId: string;
  agentId: string;
  assigneeAgentId: string | null;
  context: Record<string, unknown>;
  requestedByActorType: string | null | undefined;
  unresolvedBlockerIssueIds: readonly string[];
}): Promise<boolean> {
  if (!input.assigneeAgentId || input.agentId !== input.assigneeAgentId) return false;
  const commentIds = wakeContextCommentIds(input.context);
  if (commentIds.length > 0) {
    const rows = await db.select({ authorType: issueComments.authorType }).from(issueComments).where(and(
      eq(issueComments.companyId, input.companyId),
      eq(issueComments.issueId, input.issueId),
      inArray(issueComments.id, commentIds),
    ));
    if (rows.some(row => row.authorType !== "agent")) return false;
    if (rows.length === 0 && input.requestedByActorType !== "agent") return false;
  } else if (input.requestedByActorType !== "agent") {
    return false;
  }
  return !(await allUnresolvedBlockersCancelled(db, input));
}

/** A wake that asks the blocked assignee to act on its dependencies, so it carries the comments to hand over. */
export function isDependencyHandoffWake(context: Record<string, unknown>): boolean {
  return readString(context.wakeReason) === ISSUE_BLOCKER_STALLED_WAKE_REASON
    || readString(context.cancelledBlockerIssueId) !== null;
}

/** Start of the assignee's latest qualified run on the issue (see the header); null without one. */
export async function readLatestQualifiedRunStart(db: Reader, input: {
  companyId: string;
  issueId: string;
  agentId: string;
}): Promise<Date | null> {
  const [run] = await db.select({ startedAt: heartbeatRuns.startedAt }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, input.agentId),
    sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`,
    eq(heartbeatRuns.status, "succeeded"),
    isNotNull(heartbeatRuns.processStartedAt),
    isNotNull(heartbeatRuns.startedAt),
    sql`coalesce(${heartbeatRuns.contextSnapshot}->>'dependencyBlockedInteraction', 'false') <> 'true'`,
  )).orderBy(desc(heartbeatRuns.startedAt), desc(heartbeatRuns.id)).limit(1);
  return run?.startedAt ?? null;
}

/**
 * The agent comments the assignee may not have seen: after the start of its latest qualified run (or the whole
 * thread). The latest twenty, oldest first, and how many older ones the thread holds.
 */
export async function readCommentsToHandOver(db: Reader, input: {
  companyId: string;
  issueId: string;
  assigneeAgentId: string;
  excludeCommentIds?: readonly string[];
}): Promise<{ ids: string[]; olderCount: number }> {
  const since = await readLatestQualifiedRunStart(db, {
    companyId: input.companyId, issueId: input.issueId, agentId: input.assigneeAgentId,
  });
  const exclude = [...new Set(input.excludeCommentIds ?? [])];
  const where = and(
    eq(issueComments.companyId, input.companyId),
    eq(issueComments.issueId, input.issueId),
    eq(issueComments.authorType, "agent"),
    or(isNull(issueComments.authorAgentId), ne(issueComments.authorAgentId, input.assigneeAgentId)),
    isNull(issueComments.deletedAt),
    since ? gt(issueComments.createdAt, since) : undefined,
    exclude.length ? sql`${issueComments.id} not in (${sql.join(exclude.map(id => sql`${id}::uuid`), sql`, `)})` : undefined,
  );
  const latest = await db.select({ id: issueComments.id }).from(issueComments).where(where)
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id)).limit(HELD_DEPENDENCY_COMMENTS_SHOWN_MAX);
  if (latest.length === 0) return { ids: [], olderCount: 0 };
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(issueComments).where(where);
  return { ids: latest.map(row => row.id).reverse(), olderCount: Math.max(0, total - latest.length) };
}

/**
 * Dependents of a blocker that just became done whose remaining unresolved blockers are all cancelled: nothing
 * else will wake their assignee (cancelled blockers stay unresolved), so the route hands the dependency back.
 */
export async function listDependentsLeftWithCancelledBlockers(db: Reader, input: {
  companyId: string;
  blockerIssueId: string;
}): Promise<Array<{ id: string; assigneeAgentId: string; cancelledBlockerIssueIds: string[] }>> {
  const dependents = await db.select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId })
    .from(issueRelations).innerJoin(issues, eq(issueRelations.relatedIssueId, issues.id)).where(and(
      eq(issueRelations.companyId, input.companyId),
      eq(issueRelations.type, "blocks"),
      eq(issueRelations.issueId, input.blockerIssueId),
      isNotNull(issues.assigneeAgentId),
      isNull(issues.hiddenAt),
      sql`${issues.status} not in ('done', 'cancelled', 'backlog')`,
    ));
  const out: Array<{ id: string; assigneeAgentId: string; cancelledBlockerIssueIds: string[] }> = [];
  for (const dependent of dependents) {
    const blockers = await db.select({ id: issues.id, status: issues.status })
      .from(issueRelations).innerJoin(issues, eq(issueRelations.issueId, issues.id)).where(and(
        eq(issueRelations.companyId, input.companyId),
        eq(issueRelations.type, "blocks"),
        eq(issueRelations.relatedIssueId, dependent.id),
      ));
    const unresolved = blockers.filter(row => row.status !== "done");
    if (unresolved.length > 0 && unresolved.every(row => row.status === "cancelled")) {
      out.push({ id: dependent.id, assigneeAgentId: dependent.assigneeAgentId!, cancelledBlockerIssueIds: unresolved.map(row => row.id) });
    }
  }
  return out;
}

/**
 * A blocker became done and its dependent's remaining unresolved blockers are all cancelled: hand the dependency back
 * to the dependent's assignee like a cancelled blocker (STUDIO-0029), with one system comment per such event. The
 * caller wakes the assignee on that comment (`cancelledBlockerIssueId` in the wake context).
 */
export async function handBackDependentsLeftWithCancelledBlockers(db: Db, input: {
  companyId: string;
  doneBlocker: { id: string; identifier: string | null; completedAt?: Date | string | null };
}): Promise<Array<{ dependentId: string; assigneeAgentId: string; commentId: string; cancelledBlockerIssueId: string }>> {
  const dependents = await listDependentsLeftWithCancelledBlockers(db, { companyId: input.companyId, blockerIssueId: input.doneBlocker.id });
  const out: Array<{ dependentId: string; assigneeAgentId: string; commentId: string; cancelledBlockerIssueId: string }> = [];
  const doneAt = input.doneBlocker.completedAt ? new Date(input.doneBlocker.completedAt).toISOString() : new Date().toISOString();
  for (const dependent of dependents) {
    const label = input.doneBlocker.identifier ?? input.doneBlocker.id;
    const body =
      `System dependency handoff: ${label} is done, and every blocker this task still waits on is cancelled. ` +
      "A cancelled blocker never resolves, so this task stays blocked until its blocker set changes.\n\n" +
      "As the assignee, reassess these dependencies: replace them with the tasks that now carry the work, or remove " +
      "them if nothing is left to wait for (set_dependencies, or `blockedByIssueIds` with the blockers to keep).\n\n" +
      `<!-- cancelled-blockers-left:${input.doneBlocker.id}:${doneAt} -->`;
    const comment = await db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
        eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, dependent.id),
        eq(issueComments.authorType, "system"), eq(issueComments.body, body),
      )).limit(1);
      if (existing) return null;
      const [inserted] = await insertIssueComment(tx, { companyId: input.companyId, issueId: dependent.id, authorType: "system", body });
      return inserted ?? null;
    });
    if (comment) out.push({ dependentId: dependent.id, assigneeAgentId: dependent.assigneeAgentId,
      commentId: comment.id, cancelledBlockerIssueId: dependent.cancelledBlockerIssueIds[0]! });
  }
  return out;
}
