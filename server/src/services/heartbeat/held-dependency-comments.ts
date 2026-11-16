// STUDIO-0063: an agent's comment on an issue that waits on unresolved blockers does not start the assignee's run
// (production 15 Nov 2026, TR-1258); it waits with the issue and is handed to the assignee later. One decision for
// both gates (admission and claim), and one durable trace of what was held:
// - held: a wake request `skipped` with reason `issue_dependencies_blocked`, requested by an `agent`, whose payload
//   names the issue and the held comments (`commentId` and/or `commentIds`);
// - handed over: a STARTED run of the issue carries the comment, in `heldDependencyCommentIds` or among its own wake
//   comments. A held comment that no started run carried is still to hand over, whatever ran in between.
import { and, asc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { ISSUE_BLOCKER_STALLED_WAKE_REASON } from "@paperclipai/shared";
import { extractWakeCommentIds } from "../../modules/run-dispatch/index.js";

export const HELD_DEPENDENCY_COMMENT_IDS_KEY = "heldDependencyCommentIds";
export const HELD_DEPENDENCY_COMMENTS_SHOWN_MAX = 20;
const HELD_DEPENDENCY_REASON = "issue_dependencies_blocked";

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

/**
 * Whether the comment exception of the dependency gate is withheld for this wake, because only agents wrote what it
 * carries. Read from the comments themselves, so a run that merged a person's comment with an agent's keeps the
 * person's exception. Only the issue's assignee is held (a mentioned agent passes as before), and never while every
 * unresolved blocker is cancelled (nothing would ever lift it).
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
  if (input.unresolvedBlockerIssueIds.length > 0) {
    const blockers = await db.select({ status: issues.status }).from(issues).where(and(
      eq(issues.companyId, input.companyId),
      inArray(issues.id, [...input.unresolvedBlockerIssueIds]),
    ));
    if (blockers.length > 0 && blockers.every(row => row.status === "cancelled")) return false;
  }
  return true;
}

/** A wake that asks the blocked assignee to act on its dependencies, so it carries the held comments. */
export function isDependencyHandoffWake(context: Record<string, unknown>): boolean {
  return readString(context.wakeReason) === ISSUE_BLOCKER_STALLED_WAKE_REASON
    || readString(context.cancelledBlockerIssueId) !== null;
}

/** Held agent comments on the issue that no started run of the issue carried yet, oldest first. */
export async function readUndeliveredHeldCommentIds(db: Reader, input: {
  companyId: string;
  issueId: string;
}): Promise<string[]> {
  const held = await db.select({
    commentId: sql<string | null>`${agentWakeupRequests.payload}->>'commentId'`,
    commentIds: sql<unknown>`${agentWakeupRequests.payload}->'commentIds'`,
    requestedAt: agentWakeupRequests.requestedAt,
  }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId),
    eq(agentWakeupRequests.status, "skipped"),
    eq(agentWakeupRequests.reason, HELD_DEPENDENCY_REASON),
    eq(agentWakeupRequests.requestedByActorType, "agent"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`,
    sql`(nullif(${agentWakeupRequests.payload}->>'commentId', '') is not null
      or jsonb_typeof(${agentWakeupRequests.payload}->'commentIds') = 'array')`,
  )).orderBy(asc(agentWakeupRequests.requestedAt), asc(agentWakeupRequests.id));
  const heldIds: string[] = [];
  for (const row of held) {
    const ids = [row.commentId, ...(Array.isArray(row.commentIds) ? row.commentIds : [])];
    for (const value of ids) {
      const id = readString(value);
      if (id && !heldIds.includes(id)) heldIds.push(id);
    }
  }
  if (heldIds.length === 0) return [];
  const oldest = held[0]!.requestedAt;
  const carried = await db.select({ context: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId),
    sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`,
    isNotNull(heartbeatRuns.startedAt),
    oldest ? gte(heartbeatRuns.createdAt, oldest) : undefined,
  ));
  const delivered = new Set<string>();
  for (const { context } of carried) {
    const snapshot = (context ?? {}) as Record<string, unknown>;
    for (const id of wakeContextCommentIds(snapshot)) delivered.add(id);
    const heldCarried = snapshot[HELD_DEPENDENCY_COMMENT_IDS_KEY];
    if (Array.isArray(heldCarried)) for (const value of heldCarried) {
      const id = readString(value);
      if (id) delivered.add(id);
    }
  }
  // A comment deleted since is not handed over.
  const live = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId),
    eq(issueComments.issueId, input.issueId),
    inArray(issueComments.id, heldIds),
    sql`${issueComments.deletedAt} is null`,
  ));
  const liveIds = new Set(live.map(row => row.id));
  return heldIds.filter(id => liveIds.has(id) && !delivered.has(id));
}

/**
 * The claim gate held a queued run: its wake request becomes the same trace as an admission hold, naming every
 * comment the run carried (merged ones included). Without a request, a skipped one is written.
 */
export async function recordClaimHeldComments(db: Db, input: {
  run: typeof heartbeatRuns.$inferSelect;
  issueId: string;
  commentIds: string[];
  unresolvedBlockerIssueIds: string[];
  error: string;
}): Promise<void> {
  if (input.commentIds.length === 0) return;
  const now = new Date();
  const heldPayload = {
    issueId: input.issueId,
    commentIds: input.commentIds,
    unresolvedBlockerIssueIds: input.unresolvedBlockerIssueIds,
    heldAt: "claim",
  };
  if (input.run.wakeupRequestId) {
    const updated = await db.update(agentWakeupRequests).set({
      status: "skipped",
      reason: HELD_DEPENDENCY_REASON,
      requestedByActorType: "agent",
      payload: sql`coalesce(${agentWakeupRequests.payload}, '{}'::jsonb) || ${JSON.stringify(heldPayload)}::jsonb`,
      finishedAt: now,
      error: input.error,
      updatedAt: now,
    }).where(eq(agentWakeupRequests.id, input.run.wakeupRequestId)).returning({ id: agentWakeupRequests.id });
    if (updated.length > 0) return;
  }
  await db.insert(agentWakeupRequests).values({
    companyId: input.run.companyId,
    agentId: input.run.agentId,
    source: "automation",
    triggerDetail: "system",
    reason: HELD_DEPENDENCY_REASON,
    payload: heldPayload,
    status: "skipped",
    requestedByActorType: "agent",
    requestedByActorId: null,
    finishedAt: now,
    error: input.error,
  });
}
