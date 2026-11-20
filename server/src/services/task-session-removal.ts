import { and, eq, sql } from "drizzle-orm";
import { activityLog, type Db } from "@paperclipai/db";

/**
 * STUDIO-0075: the mark a deliberate removal of a task's session leaves.
 *
 * A session is removed on purpose by a person (the reset of an agent's session), by the server (the session a cut
 * run left mid-turn, STUDIO-0048; the guard that gives up a session after repeated failures) or by a run at its own
 * end. The row is deleted, so nothing was left to tell a result that arrives LATE, from a run that started before
 * the removal, that the session it brings must not come back. The removal now writes one activity entry on the
 * agent, and a late result reads it: a removal always wins over the late result of a run created before it.
 */
export const TASK_SESSION_REMOVED = "agent.task_session_removed";

type Writer = Pick<Db, "insert">;
type Reader = Pick<Db, "select">;

/** Written in the transaction that removes the session. `taskKeys` null: every session of the agent. */
export async function recordTaskSessionRemoved(tx: Writer, input: {
  companyId: string; agentId: string; taskKeys: string[] | null; adapterType?: string | null; reason: string;
}) {
  await tx.insert(activityLog).values({
    companyId: input.companyId, actorType: "system", actorId: "task-session", action: TASK_SESSION_REMOVED,
    entityType: "agent", entityId: input.agentId, agentId: input.agentId,
    details: { taskKeys: input.taskKeys, adapterType: input.adapterType ?? null, reason: input.reason },
    // The database's clock, as for the creation of runs: the two are compared.
    createdAt: sql`clock_timestamp()`,
  });
}

/** Whether a session of this agent for this task was removed on purpose after the given run was created. */
export async function taskSessionRemovedAfterRun(tx: Reader, input: {
  companyId: string; agentId: string; taskKey: string; adapterType: string; runId: string;
}): Promise<boolean> {
  const [mark] = await tx.select({ id: activityLog.id }).from(activityLog).where(and(
    eq(activityLog.companyId, input.companyId), eq(activityLog.agentId, input.agentId),
    eq(activityLog.action, TASK_SESSION_REMOVED),
    // The run's own timestamp, with the database's precision.
    sql`${activityLog.createdAt} > (select run.created_at from heartbeat_runs run where run.id = ${input.runId})`,
    sql`(${activityLog.details}->'taskKeys' = 'null'::jsonb or ${activityLog.details}->'taskKeys' @> ${JSON.stringify([input.taskKey])}::jsonb)`,
    sql`(${activityLog.details}->>'adapterType' is null or ${activityLog.details}->>'adapterType' = ${input.adapterType})`,
  )).limit(1);
  return Boolean(mark);
}
