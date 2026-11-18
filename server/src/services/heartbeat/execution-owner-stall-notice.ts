// STUDIO-0066: a wake kept behind the previous run's process or environment lease starts by itself once that owner
// is gone. When a hold is still there long after the wake was asked for (the owner itself, or a recovery action the
// stopped run left open), the wake stays kept and the thread gets ONE system note per hold, so that people and the
// watch see why the assignee has not started. The note is a signal only: nothing depends on it, and it wakes nobody
// (a system comment written by the service, outside the comment route).
import { and, eq, like } from "drizzle-orm";
import { agents, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { insertIssueComment } from "../issue-comment-writes.js";

/** How long the previous owner may hold the task before the thread is told. */
export const EXECUTION_OWNER_STALL_NOTICE_MS = 10 * 60_000;
export const EXECUTION_OWNER_STALL_NOTICE_MARKER = "<!-- execution-owner-stall-notice -->";
// One note per hold: the stopped run's own process or lease ("owner"), then each recovery action that holds after it.
const noticeHoldMarker = (runId: string | null, recoveryActionId: string | null) =>
  `<!-- execution-owner-stall-notice-for:${runId ?? "none"}:${recoveryActionId ?? "owner"} -->`;

export async function noteStalledExecutionOwner(db: Db, input: {
  companyId: string;
  issueId: string;
  waitingAgentId: string;
  ownerRunId: string | null;
  recoveryActionId: string | null;
  nextAction: string;
  waitingSince: Date;
}): Promise<boolean> {
  const alreadyTold = async (reader: Db) => (await reader.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId),
    eq(issueComments.issueId, input.issueId),
    eq(issueComments.authorType, "system"),
    like(issueComments.body, `%${noticeHoldMarker(input.ownerRunId, input.recoveryActionId)}%`),
  )).limit(1)).length > 0;
  // The sweep comes back every 30 s for as long as the owner holds: once the note is there, take no lock.
  if (await alreadyTold(db)) return false;
  return db.transaction(async (tx) => {
    const lockDb = tx as unknown as Db;
    // The issue row lock keeps two sweeps from both writing the note.
    await lockDb.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).for("update");
    if (await alreadyTold(lockDb)) return false;
    const [waiting] = await lockDb.select({ name: agents.name }).from(agents)
      .where(and(eq(agents.companyId, input.companyId), eq(agents.id, input.waitingAgentId))).limit(1);
    const [owner] = input.ownerRunId ? await lockDb.select({ name: agents.name }).from(heartbeatRuns)
      .innerJoin(agents, and(eq(agents.companyId, heartbeatRuns.companyId), eq(agents.id, heartbeatRuns.agentId)))
      .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.ownerRunId))).limit(1) : [];
    const minutes = Math.max(1, Math.floor((Date.now() - input.waitingSince.getTime()) / 60_000));
    const body =
      `${waiting?.name ?? "The assignee"} has not started on this task: its wake has waited ${minutes} minutes behind ` +
      `the previous run${owner ? ` of ${owner.name}` : ""}${input.ownerRunId ? ` (${input.ownerRunId.slice(0, 8)})` : ""}. ` +
      `${input.nextAction} ${waiting?.name ?? "The assignee"} starts by itself as soon as this hold is gone.\n\n` +
      `${EXECUTION_OWNER_STALL_NOTICE_MARKER}\n${noticeHoldMarker(input.ownerRunId, input.recoveryActionId)}`;
    await insertIssueComment(lockDb, { companyId: input.companyId, issueId: input.issueId, authorType: "system", body });
    return true;
  });
}
