// STUDIO-0063, point 6 of the third review (kept apart so it can be removed on its own): when the dependency gate
// holds an agent's comment for the assignee, one system note tells the thread (people, the watch, the commenter)
// that it waits, and how to get an answer before. One note per series: none of this kind since the start of the
// assignee's latest qualified run (the same base as the handover). It wakes nobody (a system comment written by the
// service, outside the comment route). If a cut prevents it, the next hold writes it.
import { and, eq, gt, inArray, like } from "drizzle-orm";
import { agents, issueComments, issues, type Db } from "@paperclipai/db";
import { insertIssueComment } from "../issue-comment-writes.js";
import { readLatestQualifiedRunStart, wakeContextCommentIds } from "./held-dependency-comments.js";

export const HELD_DEPENDENCY_NOTICE_MARKER = "<!-- held-dependency-comment-notice -->";

export async function noteHeldAgentComment(db: Db, input: {
  companyId: string;
  issueId: string;
  assigneeAgentId: string;
  context: Record<string, unknown>;
  unresolvedBlockerIssueIds: readonly string[];
}): Promise<boolean> {
  const since = await readLatestQualifiedRunStart(db, {
    companyId: input.companyId, issueId: input.issueId, agentId: input.assigneeAgentId,
  });
  const [existing] = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId),
    eq(issueComments.issueId, input.issueId),
    eq(issueComments.authorType, "system"),
    like(issueComments.body, `%${HELD_DEPENDENCY_NOTICE_MARKER}%`),
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
    `${assignee?.name ?? "the assignee"}. For an answer before, put a question card addressed to ` +
    `${assignee?.name ?? "the assignee"} on your own task.\n\n${HELD_DEPENDENCY_NOTICE_MARKER}`;
  await insertIssueComment(db, { companyId: input.companyId, issueId: input.issueId, authorType: "system", body });
  return true;
}
