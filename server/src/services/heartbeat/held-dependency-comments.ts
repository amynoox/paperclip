// STUDIO-0063: an agent's comment on an issue that waits on unresolved blockers does not start the assignee's run
// (production 15 Nov 2026, TR-1258); it waits with the issue and is handed to the assignee later.
// - One decision for both gates (admission and claim): agentCommentHeldByDependencies.
// - The hand-over BASE of the current assignee on the issue: the time its latest QUALIFIED run was given its
//   hand-over. A run qualifies when it succeeded with its engine process started (processStartedAt) and its admission
//   computed a hand-over (it then carries heldDependencyHandoverAt, the time of that computation: the issue was ready,
//   or every unresolved blocker cancelled, or it was a stall or cancel hand-off wake). A run of before this change
//   (no such key) qualifies when it was not a bounded dependency run, with its start as the time. The base is the
//   ADMISSION time, not the start: a comment held after a queued run's admission stays after the base.
// - Hand-over, only after a trace since the base: a hold (the admission's skipped `issue_dependencies_blocked`
//   request, written in the hold's own transaction; or a run cancelled with that errorCode, one write) or an
//   activity that reassigned the issue to the assignee. Only a hold MARKED by this change counts
//   (HELD_DEPENDENCY_TRACE_KEY, written by every writer of that code): the holds of before never held a comment. The run then carries every agent comment (not
//   the assignee's own) written since the base. Without a trace no comment is read: an issue that was never held is
//   unchanged (its runs only get the hand-over time in their context, which no prompt shows).
// - Times: the hand-over time and the hold traces are stamped by the server while it works on the issue. A run
//   whose admission found a trace read every comment committed before it, so it settles every trace up to its
//   hand-over time. A run whose admission found none settles traces only up to HANDOVER_CLOCK_MARGIN_MS before its
//   hand-over time (a hold being written at that very moment), and comments are always read from that margin
//   before the base: an error can only repeat a comment, never lose one.
// - For a routed run, processStartedAt means "the command left for the worker machine" (the router passes onSpawn
//   through before the engine starts there); succeeded is the real proof. A run that succeeded without
//   processStartedAt (its write is only logged when it fails) does not qualify: at worst a repeat, never a loss.
import { and, desc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { activityLog, agentWakeupRequests, heartbeatRuns, issueComments, issueRelations, issues, type Db } from "@paperclipai/db";
import { ISSUE_BLOCKER_STALLED_WAKE_REASON } from "@paperclipai/shared";
import { extractWakeCommentIds, HELD_DEPENDENCY_TRACE_KEY } from "../../modules/run-dispatch/index.js";
import { insertIssueComment } from "../issue-comment-writes.js";

export const HELD_DEPENDENCY_COMMENT_IDS_KEY = "heldDependencyCommentIds";
export const HELD_DEPENDENCY_OLDER_COUNT_KEY = "heldDependencyOlderCount";
export const HELD_DEPENDENCY_REASON_KEY = "heldDependencyReason";
export const HELD_DEPENDENCY_HANDOVER_AT_KEY = "heldDependencyHandoverAt";
export { HELD_DEPENDENCY_TRACE_KEY };
/** The context keys of a hand-over, kept as one set when run contexts are merged. */
export const HELD_DEPENDENCY_CONTEXT_KEYS = [
  HELD_DEPENDENCY_COMMENT_IDS_KEY, HELD_DEPENDENCY_OLDER_COUNT_KEY, HELD_DEPENDENCY_REASON_KEY, HELD_DEPENDENCY_HANDOVER_AT_KEY,
] as const;
/** Margin for interleaved transactions and small clock differences between the server and the database. */
export const HANDOVER_CLOCK_MARGIN_MS = 10_000;
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

/** Whether ANY unresolved blocker is cancelled: then nothing is held (studio.21 behaviour, a bounded run). */
export async function anyUnresolvedBlockerCancelled(db: Reader, input: {
  companyId: string;
  unresolvedBlockerIssueIds: readonly string[];
}): Promise<boolean> {
  if (input.unresolvedBlockerIssueIds.length === 0) return false;
  const [cancelled] = await db.select({ id: issues.id }).from(issues).where(and(
    eq(issues.companyId, input.companyId),
    inArray(issues.id, [...input.unresolvedBlockerIssueIds]),
    eq(issues.status, "cancelled"),
  )).limit(1);
  return Boolean(cancelled);
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
 * person's exception. Only the issue's assignee is held (another role passes as before), and never while any
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
  return !(await anyUnresolvedBlockerCancelled(db, input));
}

/** A wake that asks the blocked assignee to act on its dependencies, so it carries the comments to hand over. */
export function isDependencyHandoffWake(context: Record<string, unknown>): boolean {
  return readString(context.wakeReason) === ISSUE_BLOCKER_STALLED_WAKE_REASON
    || readString(context.cancelledBlockerIssueId) !== null;
}

export type HandOverBase = {
  /** The hand-over time of the assignee's latest qualified run; null without one. */
  since: Date | null;
  /** Hold traces and reassignments after this time are still due (see the header for the margin). */
  traceSince: Date | null;
  /** Comments the latest qualified runs already carried: never repeated, although comments are read from the margin. */
  carriedCommentIds: string[];
};

/**
 * The assignee's hand-over base on the issue (see the header).
 * `succeededIsEnough` is the hand-over backstop's stop rule: a succeeded run whose admission computed a hand-over
 * counts even without processStartedAt (an adapter that does not report the start; `succeeded` is the real proof).
 * The hand-over itself keeps the strict base: at worst the next run repeats a comment, and no backstop wake loops.
 */
export async function readHandOverBase(db: Reader, input: {
  companyId: string;
  issueId: string;
  agentId: string;
  succeededIsEnough?: boolean;
}): Promise<HandOverBase> {
  const context = heartbeatRuns.contextSnapshot;
  const hasMarker = sql`(jsonb_typeof(${context}->'heldDependencyHandoverAt') = 'string'
    and ${context}->>'heldDependencyHandoverAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T')`;
  const handedOverAt = sql`(case when ${hasMarker}
    then (${context}->>'heldDependencyHandoverAt')::timestamptz else ${heartbeatRuns.startedAt} end)`;
  // The latest qualified runs: the first gives the base; the few within the margin of it refine what is settled.
  const rows = await db.select({
    handedOverAt: sql<string>`${handedOverAt}`,
    foundTrace: sql<boolean>`(${hasMarker} and jsonb_typeof(${context}->'heldDependencyReason') = 'string')`,
    context,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, input.agentId),
    sql`${context}->>'issueId' = ${input.issueId}`,
    eq(heartbeatRuns.status, "succeeded"),
    isNotNull(heartbeatRuns.startedAt),
    input.succeededIsEnough
      ? sql`(${hasMarker} or (${heartbeatRuns.processStartedAt} is not null
          and coalesce(${context}->>'dependencyBlockedInteraction', 'false') <> 'true'))`
      : and(isNotNull(heartbeatRuns.processStartedAt),
          sql`(${hasMarker} or coalesce(${context}->>'dependencyBlockedInteraction', 'false') <> 'true')`),
  )).orderBy(sql`${handedOverAt} desc`).limit(8);
  const runs = rows.map(row => ({ at: new Date(row.handedOverAt), foundTrace: row.foundTrace === true,
    context: (row.context ?? {}) as Record<string, unknown> })).filter(run => !Number.isNaN(run.at.getTime()));
  if (runs.length === 0) return { since: null, traceSince: null, carriedCommentIds: [] };
  const since = runs[0]!.at;
  const traceSince = new Date(Math.max(...runs.map(run => run.at.getTime() - (run.foundTrace ? 0 : HANDOVER_CLOCK_MARGIN_MS))));
  const carried = new Set<string>();
  for (const run of runs) {
    if (run.at.getTime() < since.getTime() - HANDOVER_CLOCK_MARGIN_MS) continue;
    for (const id of wakeContextCommentIds(run.context)) carried.add(id);
    const held = run.context[HELD_DEPENDENCY_COMMENT_IDS_KEY];
    if (Array.isArray(held)) for (const value of held) { const id = readString(value); if (id) carried.add(id); }
  }
  return { since, traceSince, carriedCommentIds: [...carried] };
}

/**
 * Whether the issue carries a MARKED hold trace still due: the admission's skipped `issue_dependencies_blocked`
 * request (a coalesced automatic hold only moves `updatedAt`, and marks the row), or a run cancelled with that
 * errorCode (at its cancellation time). The assignee's own holds; and, while it has no base on the issue (it never completed a run
 * here), a hold of any agent: the issue was held for a previous assignee.
 */
export async function hasHoldTraceSince(db: Reader, input: {
  companyId: string;
  issueId: string;
  assigneeAgentId: string;
  base: HandOverBase;
}): Promise<boolean> {
  const floor = input.base.traceSince;
  const ownOnly = input.base.since !== null;
  const [skipped] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId),
    ownOnly ? eq(agentWakeupRequests.agentId, input.assigneeAgentId) : undefined,
    eq(agentWakeupRequests.status, "skipped"),
    eq(agentWakeupRequests.reason, "issue_dependencies_blocked"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`,
    sql`${agentWakeupRequests.payload}->>${HELD_DEPENDENCY_TRACE_KEY} = 'true'`,
    floor ? or(gt(agentWakeupRequests.requestedAt, floor), gt(agentWakeupRequests.updatedAt, floor),
      gt(agentWakeupRequests.finishedAt, floor)) : undefined,
  )).limit(1);
  if (skipped) return true;
  const [cancelledAtClaim] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId),
    ownOnly ? eq(heartbeatRuns.agentId, input.assigneeAgentId) : undefined,
    sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`,
    eq(heartbeatRuns.status, "cancelled"),
    eq(heartbeatRuns.errorCode, "issue_dependencies_blocked"),
    sql`${heartbeatRuns.resultJson}->>${HELD_DEPENDENCY_TRACE_KEY} = 'true'`,
    floor ? sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.updatedAt}) > ${floor.toISOString()}::timestamptz` : undefined,
  )).limit(1);
  return Boolean(cancelledAtClaim);
}

export type HandOverReason = "dependency_hold" | "reassignment";

/** The trace that calls for a hand-over since the base (see the header), or null. */
export async function readHandOverReason(db: Reader, input: {
  companyId: string;
  issueId: string;
  assigneeAgentId: string;
  base: HandOverBase;
}): Promise<HandOverReason | null> {
  if (await hasHoldTraceSince(db, input)) return "dependency_hold";
  const floor = input.base.traceSince;
  const [reassigned] = await db.select({ id: activityLog.id }).from(activityLog).where(and(
    eq(activityLog.companyId, input.companyId),
    eq(activityLog.entityType, "issue"),
    eq(activityLog.entityId, input.issueId),
    or(
      and(
        eq(activityLog.action, "issue.updated"),
        sql`${activityLog.details}->'changes'->'assigneeAgentId'->>'to' = ${input.assigneeAgentId}`,
        sql`${activityLog.details}->'changes'->'assigneeAgentId'->>'from' is distinct from ${input.assigneeAgentId}`,
      ),
      // A case handoff moves the issue with its own activity.
      and(
        eq(activityLog.action, "issue.reassigned"),
        sql`${activityLog.details}->>'assigneeAgentId' = ${input.assigneeAgentId}`,
        sql`${activityLog.details}->>'previousAssigneeAgentId' is distinct from ${input.assigneeAgentId}`,
      ),
    ),
    floor ? gt(activityLog.createdAt, floor) : undefined,
  )).limit(1);
  return reassigned ? "reassignment" : null;
}

/**
 * The agent comments the assignee may not have seen: written since its base (or the whole thread), when a trace calls
 * for a hand-over. The latest twenty, oldest first, and how many older ones the thread holds.
 */
export async function readCommentsToHandOver(db: Reader, input: {
  companyId: string;
  issueId: string;
  assigneeAgentId: string;
  excludeCommentIds?: readonly string[];
}): Promise<{ ids: string[]; olderCount: number; reason: HandOverReason | null }> {
  const base = await readHandOverBase(db, {
    companyId: input.companyId, issueId: input.issueId, agentId: input.assigneeAgentId,
  });
  // Nothing without a trace: an issue that was never held (nor reassigned) gets no hand-over. The base and trace
  // reads run on every admitted wake of the assignee that can act (a few reads); the comments only after a trace.
  const reason = await readHandOverReason(db, { ...input, base });
  if (!reason) return { ids: [], olderCount: 0, reason: null };
  const floor = base.since ? new Date(base.since.getTime() - HANDOVER_CLOCK_MARGIN_MS) : null;
  const exclude = [...new Set([...(input.excludeCommentIds ?? []), ...base.carriedCommentIds])];
  const where = and(
    eq(issueComments.companyId, input.companyId),
    eq(issueComments.issueId, input.issueId),
    eq(issueComments.authorType, "agent"),
    or(isNull(issueComments.authorAgentId), ne(issueComments.authorAgentId, input.assigneeAgentId)),
    isNull(issueComments.deletedAt),
    floor ? gt(issueComments.createdAt, floor) : undefined,
    exclude.length ? sql`${issueComments.id} not in (${sql.join(exclude.map(id => sql`${id}::uuid`), sql`, `)})` : undefined,
  );
  const latest = await db.select({ id: issueComments.id }).from(issueComments).where(where)
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id)).limit(HELD_DEPENDENCY_COMMENTS_SHOWN_MAX);
  if (latest.length === 0) return { ids: [], olderCount: 0, reason };
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(issueComments).where(where);
  return { ids: latest.map(row => row.id).reverse(), olderCount: Math.max(0, total - latest.length), reason };
}

/**
 * Dependents (among `dependentIds`) whose unresolved blockers are all cancelled: nothing else will wake their
 * assignee (cancelled blockers stay unresolved), so the dependency is handed back as for a cancelled blocker
 * (STUDIO-0029): one system comment per dependent and per set of cancelled blockers, and the caller wakes the
 * assignee on it (`cancelledBlockerIssueId` in the wake context). The comment and its wake cannot share one
 * transaction (the wake is admitted by the heartbeat service): the deduplication skips only when the wake exists too,
 * so a comment left without its wake (a cut between the two) is woken again by the next dependency change.
 */
export async function handBackDependentsLeftWithCancelledBlockers(db: Db, input: {
  companyId: string;
  dependentIds: readonly string[];
  /** The backstop wakes again on the hand-back comment even when an earlier wake of it exists. */
  evenIfWoken?: boolean;
}): Promise<Array<{ dependentId: string; assigneeAgentId: string; commentId: string; cancelledBlockerIssueId: string }>> {
  const out: Array<{ dependentId: string; assigneeAgentId: string; commentId: string; cancelledBlockerIssueId: string }> = [];
  for (const dependentId of [...new Set(input.dependentIds)]) {
    const [dependent] = await db.select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId, status: issues.status })
      .from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, dependentId), isNull(issues.hiddenAt)));
    if (!dependent?.assigneeAgentId || ["done", "cancelled", "backlog"].includes(dependent.status)) continue;
    const blockers = await db.select({ id: issues.id, identifier: issues.identifier, status: issues.status })
      .from(issueRelations).innerJoin(issues, eq(issueRelations.issueId, issues.id)).where(and(
        eq(issueRelations.companyId, input.companyId),
        eq(issueRelations.type, "blocks"),
        eq(issueRelations.relatedIssueId, dependentId),
      ));
    const unresolved = blockers.filter(row => row.status !== "done");
    if (unresolved.length === 0 || !unresolved.every(row => row.status === "cancelled")) continue;
    const cancelledIds = unresolved.map(row => row.id).sort();
    const labels = unresolved.map(row => row.identifier ?? row.id).sort().join(", ");
    const body =
      `System dependency handoff: every blocker this task still waits on is cancelled (${labels}). ` +
      "A cancelled blocker never resolves, so this task stays blocked until its blocker set changes.\n\n" +
      "As the assignee, reassess these dependencies: replace them with the tasks that now carry the work, or remove " +
      "them if nothing is left to wait for (set_dependencies, or `blockedByIssueIds` with the blockers to keep).\n\n" +
      `<!-- cancelled-blockers-left:${dependentId}:${cancelledIds.join(",")} -->`;
    const assigneeAgentId = dependent.assigneeAgentId;
    const comment = await db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
        eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, dependentId),
        eq(issueComments.authorType, "system"), eq(issueComments.body, body),
      )).limit(1);
      if (existing) {
        const [woken] = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
          eq(agentWakeupRequests.companyId, input.companyId),
          eq(agentWakeupRequests.agentId, assigneeAgentId),
          sql`${agentWakeupRequests.payload}->>'commentId' = ${existing.id}`,
          sql`${agentWakeupRequests.status} not in ('skipped', 'failed', 'cancelled')`,
        )).limit(1);
        return woken && !input.evenIfWoken ? null : existing;
      }
      const [inserted] = await insertIssueComment(tx, { companyId: input.companyId, issueId: dependentId, authorType: "system", body });
      return inserted ?? null;
    });
    if (comment) out.push({ dependentId, assigneeAgentId, commentId: comment.id, cancelledBlockerIssueId: cancelledIds[0]! });
  }
  return out;
}
