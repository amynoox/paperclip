// STUDIO-0063 (accepted by the owner): when the dependency gate holds an agent's comment for the assignee, one system
// note tells the thread (people, the watch, the commenter) that it waits. It gives no advice: a question card
// addressed to the assignee is refused by the worker router when the assignee is a routed role. It is a signal only;
// the handover never depends on it. One note per assignee and per series: none for this assignee since the start of
// its latest qualified run (the handover's base), under a lock on the issue row so two holds cannot both write it. It wakes nobody (a system comment written by the service, outside the comment route). If a cut prevents
// it, the next hold writes it.
// Not handled here (moved to the next batch): the note's other review points and the dotEvents noise.
import { and, eq, gt, inArray, like } from "drizzle-orm";
import { agents, issueComments, issues, type Db } from "@paperclipai/db";
import { insertIssueComment } from "../issue-comment-writes.js";
import { readHandOverBase, wakeContextCommentIds } from "./held-dependency-comments.js";

export const HELD_DEPENDENCY_NOTICE_MARKER = "<!-- held-dependency-comment-notice -->";
const noticeAssigneeMarker = (assigneeAgentId: string) => `<!-- held-dependency-comment-notice-for:${assigneeAgentId} -->`;

export async function noteHeldAgentComment(db: Db, input: {
  companyId: string;
  issueId: string;
  assigneeAgentId: string;
  context: Record<string, unknown>;
  unresolvedBlockerIssueIds: readonly string[];
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const lockDb = tx as unknown as Db;
    await lockDb.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).for("update");
    return writeNoticeOnce(lockDb, input);
  });
}

async function writeNoticeOnce(db: Db, input: Parameters<typeof noteHeldAgentComment>[1]): Promise<boolean> {
  const { since } = await readHandOverBase(db, {
    companyId: input.companyId, issueId: input.issueId, agentId: input.assigneeAgentId,
  });
  const [existing] = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId),
    eq(issueComments.issueId, input.issueId),
    eq(issueComments.authorType, "system"),
    like(issueComments.body, `%${noticeAssigneeMarker(input.assigneeAgentId)}%`),
    since ? gt(issueComments.createdAt, since) : undefined,
  )).limit(1);
  if (existing) return false;
  const commentIds = wakeContextCommentIds(input.context);
  const [comment] = commentIds.length
    ? await db.select({ authorAgentId: issueComments.authorAgentId }).from(issueComments).where(and(
      eq(issueComments.companyId, input.companyId), inArray(issueComments.id, commentIds),
    )).limit(1)
    : [];
  const names = async (ids: string[]) => ids.length
    ? (await db.select({ id: agents.id, name: agents.name }).from(agents)
      .where(and(eq(agents.companyId, input.companyId), inArray(agents.id, ids))))
    : [];
  const [commenter] = comment?.authorAgentId ? await names([comment.authorAgentId]) : [];
  const [assignee] = await names([input.assigneeAgentId]);
  const blockers = input.unresolvedBlockerIssueIds.length
    ? await db.select({ id: issues.id, identifier: issues.identifier }).from(issues)
      .where(and(eq(issues.companyId, input.companyId), inArray(issues.id, [...input.unresolvedBlockerIssueIds])))
    : [];
  const blockerList = blockers.map(row => row.identifier ?? row.id).join(", ") || "its blockers";
  const body =
    `A comment from ${commenter?.name ?? "another agent"} waits for ${blockerList} to resolve before it reaches ` +
    `${assignee?.name ?? "the assignee"}.\n\n${HELD_DEPENDENCY_NOTICE_MARKER}\n` +
    noticeAssigneeMarker(input.assigneeAgentId);
  await insertIssueComment(db, { companyId: input.companyId, issueId: input.issueId, authorType: "system", body });
  return true;
}
