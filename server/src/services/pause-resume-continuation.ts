import { and, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { activityLog, agentWakeupRequests, budgetResumeClaims, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { BUDGET_PAUSE_STOP_REASON, isGovernancePauseStop } from "./governance-pause-stop.js";

/**
 * STUDIO-0074: when an agent becomes ready again after a pause, the runs that the pause cut continue by
 * themselves.
 *
 * Production, 18-20 Nov 2026: a manual pause cut the runs of a role; each left a hold that kept every later run of
 * its task from starting, and after the resume a person had to ask again on every task (a message, or Retry).
 * The product already continues the work a BUDGET pause cut, by filing the Retry of the board member who raised the
 * budget (budget-resume-continuation.ts); it leaves a manual pause out on purpose. The studio's owner decided on
 * 20 Nov 2026 that the resume of a role continues its cut work too.
 *
 * For each open task of the agent whose latest run of that agent was cut by the pause, this files the product's
 * Retry in the name of the person who resumed the agent (the `agent.resumed` activity entry). Everything after
 * that is the Retry's own path, so no rule is written twice:
 * - the same stop proof a person's request needs (explicit-native-continuation.ts): without it the request stays
 *   saved and nothing starts;
 * - the same refusal while a question, an approval or a card is pending;
 * - accepted only while the cut run is still the agent's latest run on the task (task-retry.ts), and retired as
 *   soon as a newer run exists.
 * Checked here, before filing: the cut run's hold still holds the task; the task is not blocked and has no
 * unresolved blocker; no request of a person is already waiting for the task.
 *
 * Every candidate gets one activity entry on its task per resume: `agent.pause_cut_work_continued`, or
 * `agent.pause_cut_work_not_continued` with the reason.
 *
 * Not covered: a resume no person asked for (an agent, a plugin, the company's resume): refused, with its entry;
 * a server stop between the agent's readiness and this call (nothing is filed and nothing is recorded; the task
 * stays held and listed, and the agent's next resume looks again); a run cut more than thirty days ago.
 */
export const PAUSE_CUT_WORK_CONTINUED = "agent.pause_cut_work_continued";
export const PAUSE_CUT_WORK_NOT_CONTINUED = "agent.pause_cut_work_not_continued";
export const PAUSE_RESUME_ACTOR_ID = "pause-resume";

const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const CUT_RUNS_READ_AT_MOST = 500;
const OPEN_TASK_STATUSES = ["todo", "in_progress", "in_review", "blocked"];
const LIVE_WAKE_STATUSES = ["queued", "deferred_issue_execution", "claimed"];
const ACTOR_SOURCES = ["local_implicit", "session", "board_key", "cloud_tenant"];
/** The waits of the continuation gate that mean: the previous run is not proven stopped yet. */
const STOP_NOT_PROVEN_WAITS = new Set(["remote_cleanup", "local_cleanup", "process_identity_missing", "process_running",
  "execution_settling", "cleanup_pending", "controller_settling"]);

type RequestTaskRetry = typeof import("./task-retry.js").requestTaskRetry;

export type PauseResumeContinuation = {
  companyId: string;
  agentId: string;
  /** Dispatches the filed Retry now; the deferred-receipt worker dispatches it too. */
  resumeTaskRetry: (companyId: string, requestId: string) => Promise<unknown>;
  /** The Retry path; defaults to requestTaskRetry. */
  requestRetry?: RequestTaskRetry;
  /** The product's reading of a task's blockers; defaults to the issue service's. */
  dependencyReady?: (issueId: string) => Promise<boolean>;
  now?: Date;
};

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** A stop a budget caused has its own continuation (budget-resume-continuation.ts). */
function cutForBudget(run: { resultJson: Record<string, unknown> | null }) {
  const pauseStop = record(run.resultJson?.pauseStop);
  const holds = Array.isArray(pauseStop.holds) ? pauseStop.holds : [];
  return holds.includes("budget") || pauseStop.companyPauseReason === "budget"
    || record(run.resultJson?.cancellation).reason === BUDGET_PAUSE_STOP_REASON;
}

const runIssueId = sql<string | null>`coalesce(${heartbeatRuns.issueId}::text, ${heartbeatRuns.nativeIssueId}::text,
  ${heartbeatRuns.contextSnapshot}->>'issueId')`;

export async function continueRunsCutByPause(db: Db, input: PauseResumeContinuation) {
  const { companyId, agentId } = input;
  const since = new Date((input.now ?? new Date()).getTime() - LOOKBACK_MS);
  const cancelled = await db.select({ id: heartbeatRuns.id, issueId: runIssueId, status: heartbeatRuns.status,
    startedAt: heartbeatRuns.startedAt, createdAt: heartbeatRuns.createdAt, resultJson: heartbeatRuns.resultJson })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId),
      gt(heartbeatRuns.startedAt, since), eq(heartbeatRuns.status, "cancelled")))
    .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(CUT_RUNS_READ_AT_MOST);
  const issueIds = [...new Set(cancelled.filter(run => run.issueId && isGovernancePauseStop(run) && !cutForBudget(run))
    .map(run => run.issueId!))];
  const result = { candidates: 0, continued: 0, notContinued: 0 };
  for (const issueId of issueIds) {
    // One task's failure must not stop the others; the agent's next resume looks at it again.
    try {
      const outcome = await continueOne(db, input, issueId);
      if (!outcome) continue;
      result.candidates += 1;
      if (outcome === "continued") result.continued += 1; else result.notContinued += 1;
    } catch (error) {
      logger.warn({ err: error, companyId, agentId, issueId }, "a run cut by a pause could not be continued at the resume");
    }
  }
  return result;
}

async function continueOne(db: Db, input: PauseResumeContinuation, issueId: string): Promise<"continued" | "not_continued" | null> {
  const { companyId, agentId } = input;
  const [task] = await db.select({ id: issues.id, status: issues.status }).from(issues).where(and(
    eq(issues.companyId, companyId), eq(issues.id, issueId), eq(issues.assigneeAgentId, agentId),
    inArray(issues.status, OPEN_TASK_STATUSES)));
  // Closed, or no longer this agent's task: not its work any more.
  if (!task) return null;
  const onTask = and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId),
    or(eq(heartbeatRuns.issueId, issueId), eq(heartbeatRuns.nativeIssueId, issueId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`));
  const [cut] = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, startedAt: heartbeatRuns.startedAt,
    createdAt: heartbeatRuns.createdAt, resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns).where(onTask)
    .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
  // The agent already ran on the task after the cut, or its latest run ended another way: nothing to continue.
  if (!cut || !isGovernancePauseStop(cut) || cutForBudget(cut)) return null;
  const [budgetClaim] = await db.select({ id: budgetResumeClaims.runId }).from(budgetResumeClaims)
    .where(eq(budgetResumeClaims.runId, cut.id)).limit(1);
  if (budgetClaim) return null;

  // The resume that lifted the pause, and who asked for it. The entry is written by the resume route.
  const [resume] = await db.select({ id: activityLog.id, actorType: activityLog.actorType, actorId: activityLog.actorId,
    details: activityLog.details }).from(activityLog).where(and(eq(activityLog.companyId, companyId),
    eq(activityLog.entityType, "agent"), eq(activityLog.entityId, agentId), eq(activityLog.action, "agent.resumed"),
    gt(activityLog.createdAt, cut.startedAt ?? cut.createdAt))).orderBy(desc(activityLog.createdAt)).limit(1);
  const resumeActivityId = resume?.id ?? null;
  const recorded = await db.select({ action: activityLog.action, details: activityLog.details }).from(activityLog).where(and(
    eq(activityLog.companyId, companyId), eq(activityLog.entityType, "issue"), eq(activityLog.entityId, issueId),
    inArray(activityLog.action, [PAUSE_CUT_WORK_CONTINUED, PAUSE_CUT_WORK_NOT_CONTINUED]),
    sql`${activityLog.details}->>'interruptedRunId' = ${cut.id}`));
  // Continued once is final; a refusal is final for the resume that got it, and the next resume looks again.
  if (recorded.some(entry => entry.action === PAUSE_CUT_WORK_CONTINUED
    || (record(entry.details).resumeActivityId ?? null) === resumeActivityId)) return null;

  const resumedByUserId = resume?.actorType === "user" && resume.actorId ? resume.actorId : null;
  const trace = async (action: string, details: Record<string, unknown>) => {
    await logActivity(db, { companyId, actorType: "system", actorId: PAUSE_RESUME_ACTOR_ID, agentId, action,
      entityType: "issue", entityId: issueId,
      details: { interruptedRunId: cut.id, resumeActivityId, ...(resumedByUserId ? { resumedByUserId } : {}), ...details } });
    return action === PAUSE_CUT_WORK_CONTINUED ? "continued" as const : "not_continued" as const;
  };
  const refuse = (reason: string, details: Record<string, unknown> = {}) => trace(PAUSE_CUT_WORK_NOT_CONTINUED, { reason, ...details });

  if (!resumedByUserId) return refuse("resumed_without_a_person");
  const blocker = await getExecutionBlocker(db, companyId, issueId);
  // Reconciled, or already released by a person's request: the task's ordinary wakes start it.
  if (!blocker?.recoveryActionId) return refuse("hold_already_released");
  if (blocker.runId !== cut.id) return refuse("held_for_another_reason",
    { recoveryActionId: blocker.recoveryActionId, cause: blocker.cause });
  if (task.status === "blocked") return refuse("task_blocked");
  const dependencyReady = input.dependencyReady ?? (async (id: string) =>
    (await (await import("./issues.js")).issueService(db).getDependencyReadiness(id)).isDependencyReady);
  if (!await dependencyReady(issueId)) return refuse("blocked_by_dependency");
  const [waiting] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId),
    inArray(agentWakeupRequests.status, LIVE_WAKE_STATUSES), eq(agentWakeupRequests.requestedByActorType, "user"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`)).limit(1);
  // A message kept during the pause, or a Retry: that request continues the cut run by the same path.
  if (waiting) return refuse("already_requested_by_person", { wakeRequestId: waiting.id });

  const requestRetry = input.requestRetry ?? (await import("./task-retry.js")).requestTaskRetry;
  const actorSource = record(resume?.details).actorSource;
  let receipt: Awaited<ReturnType<RequestTaskRetry>>;
  try {
    receipt = await requestRetry({ db, companyId, issueId, observedRunId: cut.id, actorId: resumedByUserId,
      idempotencyKey: `pause-resume:${cut.id}:${resumeActivityId}`,
      ...(typeof actorSource === "string" && ACTOR_SOURCES.includes(actorSource) ? { actorSource } : {}) });
  } catch (error) {
    // A refusal the Retry path names is this resume's answer; anything else is left to the next resume.
    if (!(error instanceof HttpError) || error.status < 400 || error.status >= 500) throw error;
    const code = (error.details as { code?: unknown } | undefined)?.code;
    return refuse(typeof code === "string" ? code : `retry_refused_${error.status}`);
  }
  // The cut run is no longer the agent's latest run on the task, or the task was closed or handed over.
  if (!receipt.accepted || !receipt.requestId) return refuse("already_continued");
  await input.resumeTaskRetry(companyId, receipt.requestId).catch(error =>
    logger.warn({ err: error, companyId, issueId, requestId: receipt.requestId }, "the Retry of a run cut by a pause stays queued"));

  const [next] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId),
    sql`${heartbeatRuns.contextSnapshot}->>'previousRunId' = ${cut.id}`)).limit(1);
  if (next) return trace(PAUSE_CUT_WORK_CONTINUED, { retryRequestId: receipt.requestId, continuationRunId: next.id });
  const [wake] = await db.select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error,
    payload: agentWakeupRequests.payload }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.id, receipt.requestId)));
  if (wake?.status !== "deferred_issue_execution") {
    return refuse("retry_not_started", { retryRequestId: receipt.requestId, retryStatus: wake?.status ?? null,
      ...(wake?.error ? { retryError: wake.error } : {}) });
  }
  // The gate keeps the request: it starts by itself once the wait clears. Nothing started now.
  const wait = record(record(wake.payload).executionWait).reason;
  const reason = typeof wait !== "string" ? "retry_saved_not_dispatched"
    : STOP_NOT_PROVEN_WAITS.has(wait) ? "stop_not_proven" : wait === "decision_pending" ? "waiting_for_person" : wait;
  return refuse(reason, { retryRequestId: receipt.requestId, saved: true, ...(typeof wait === "string" ? { wait } : {}) });
}
