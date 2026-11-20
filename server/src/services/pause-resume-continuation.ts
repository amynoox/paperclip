import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { activityLog, agentWakeupRequests, budgetResumeClaims, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity, publishActivity, type ActivityPublication, type LogActivityInput } from "./activity-log.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { AGENT_LIFECYCLE_STOP_REASON, AGENT_PAUSE_STOP_REASON, BUDGET_PAUSE_STOP_REASON, isGovernancePauseStop } from "./governance-pause-stop.js";
import type { PauseResumeOperation, ResumeRequester } from "../modules/agent-lifecycle/index.js";

/**
 * STUDIO-0074: when an agent becomes ready again after a pause, the runs that pause cut continue by themselves.
 *
 * Production, 18-20 Nov 2026: a manual pause cut the runs of a role; each left a hold that kept every later run of
 * its task from starting, and after the resume a person had to ask again on every task (a message, or Retry).
 * The product already continues the work a BUDGET pause cut, by filing the Retry of the board member who raised the
 * budget (budget-resume-continuation.ts); it leaves a manual pause out on purpose. The studio's owner decided on
 * 20 Nov 2026 that the resume of a role continues its cut work too.
 *
 * The lifecycle operation that made the agent ready says which pause was lifted and who asked to resume
 * (`pauseLifted`, modules/agent-lifecycle postgres.ts): the resume command saves the person in its own transaction.
 * For each open task of the agent whose latest run of that agent was cut during that pause, this files the
 * product's Retry in that person's name. Everything after that is the Retry's own path, so no rule is written twice:
 * - the same stop proof a person's request needs (explicit-native-continuation.ts): without it the request stays
 *   saved and nothing starts;
 * - the same refusal while a question, an approval or a card is pending;
 * - accepted only while the cut run is still the agent's latest run on the task (task-retry.ts), and retired as
 *   soon as a newer run exists.
 * Checked here, before filing: a person asked, signed in by a source the Retry accepts; the cut run's hold still
 * holds the task; the task is not blocked and has no unresolved blocker; no request of a person already waits.
 *
 * The task's activity says what happened, with who asked and how that person was signed in:
 * - `agent.pause_cut_work_not_continued`: nothing was filed, with the reason;
 * - `agent.pause_cut_work_request_filed`: the request is filed; written in the transaction that files it;
 * - `agent.pause_cut_work_kept`: the filed request waits (stop proof, a person's decision), with the reason;
 * - `agent.pause_cut_work_continued`: written when the run starts, at once or later (recordPauseCutWorkContinued,
 *   called where the Retry's run is created).
 *
 * Not looked at: a run a budget pause cut (it has its own continuation); a run cut before the pause that is being
 * lifted, unless the lifted pause cancelled a request filed for it (the resume files it again; a request a person
 * cancelled is never filed again); a ready state that follows no pause (first setup). A filed request starts
 * only while its task is neither blocked nor waiting for a blocker (pauseCutWorkRequestMayStart, called where
 * it is dispatched). One entry per cut run and per reason. Not covered: a server stop between the agent's
 * readiness and this call (nothing is filed and nothing is recorded; the task stays held and listed).
 */
export const PAUSE_CUT_WORK_CONTINUED = "agent.pause_cut_work_continued";
export const PAUSE_CUT_WORK_NOT_CONTINUED = "agent.pause_cut_work_not_continued";
export const PAUSE_CUT_WORK_REQUEST_FILED = "agent.pause_cut_work_request_filed";
export const PAUSE_CUT_WORK_KEPT = "agent.pause_cut_work_kept";
export const PAUSE_RESUME_ACTOR_ID = "pause-resume";
const RETRY_KEY = "pause-resume:";
/** The idempotency key of the filed Retry, as task-retry.ts stores it: this prefix, the cut run, the ready operation. */
export const PAUSE_RESUME_RETRY_KEY_PREFIX = `task-retry:${RETRY_KEY}`;

const CUT_RUNS_READ_AT_MOST = 500;
const OPEN_TASK_STATUSES = ["todo", "in_progress", "in_review", "blocked"];
const LIVE_WAKE_STATUSES = ["queued", "deferred_issue_execution", "claimed"];
/** The errors a pause leaves on a request it cancels. A request cancelled any other way was cancelled on purpose. */
const PAUSE_STOP_ERRORS = [AGENT_LIFECYCLE_STOP_REASON, AGENT_PAUSE_STOP_REASON, BUDGET_PAUSE_STOP_REASON];
/** A filed request the pause that started at `pausedAt` cancelled before its run started. */
const cancelledByPauseSince = (pausedAt: Date) => and(eq(agentWakeupRequests.reason, "task_retry"),
  eq(agentWakeupRequests.status, "cancelled"), inArray(agentWakeupRequests.error, PAUSE_STOP_ERRORS),
  sql`coalesce(${agentWakeupRequests.finishedAt}, ${agentWakeupRequests.updatedAt}) >= ${pausedAt.toISOString()}::timestamptz`);
/**
 * The sign-in sources the product's Retry accepts for its requester (task-retry.ts, taskRetryIntentSchema). Any
 * other source is refused here: it must never be filed as an ordinary session.
 */
const RETRY_ACTOR_SOURCES = ["local_implicit", "session", "board_key", "cloud_tenant"];
/** The waits of the continuation gate that mean: the previous run is not proven stopped yet. */
const STOP_NOT_PROVEN_WAITS = new Set(["remote_cleanup", "local_cleanup", "process_identity_missing", "process_running",
  "execution_settling", "cleanup_pending", "controller_settling"]);

type RequestTaskRetry = typeof import("./task-retry.js").requestTaskRetry;
type Record_ = (db: Db, input: LogActivityInput, publications?: ActivityPublication[]) => Promise<unknown>;

export type PauseResumeContinuation = {
  companyId: string;
  agentId: string;
  /** The operation that made the agent ready: one evaluation of a cut run per ready operation. */
  readyOperationId: string;
  /** When the pause that was lifted started. Only runs cut since then are looked at. */
  pausedAt: Date;
  /** The person who asked to resume during that pause; null when no person did. */
  requestedBy: ResumeRequester | null;
  /** Dispatches the filed Retry now; the deferred-receipt worker dispatches it too. */
  resumeTaskRetry: (companyId: string, requestId: string) => Promise<unknown>;
  /** The Retry path; defaults to requestTaskRetry. */
  requestRetry?: RequestTaskRetry;
  /** The product's reading of a task's blockers; defaults to the issue service's. */
  dependencyReady?: (issueId: string) => Promise<boolean>;
  /** Writes an activity entry; defaults to logActivity. */
  record?: Record_;
};

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** What the operation that made an agent ready says about the pause it lifted; null when it followed no pause. */
export function pauseLiftedOf(operation: unknown): { readyOperationId: string; pausedAt: Date; requestedBy: ResumeRequester | null } | null {
  const lifted = (operation as PauseResumeOperation | null | undefined)?.pauseLifted;
  const id = (operation as PauseResumeOperation | null | undefined)?.id;
  if (!lifted || !id || !lifted.pausedAt) return null;
  const pausedAt = new Date(lifted.pausedAt);
  if (!Number.isFinite(pausedAt.getTime())) return null;
  const by = lifted.requestedBy;
  return { readyOperationId: id, pausedAt,
    requestedBy: by && typeof by.userId === "string" && by.userId && typeof by.source === "string" ? by : null };
}

/** A stop a budget caused has its own continuation (budget-resume-continuation.ts). */
function cutForBudget(run: { resultJson: Record<string, unknown> | null }) {
  const pauseStop = record(run.resultJson?.pauseStop);
  const holds = Array.isArray(pauseStop.holds) ? pauseStop.holds : [];
  return holds.includes("budget") || pauseStop.companyPauseReason === "budget"
    || record(run.resultJson?.cancellation).reason === BUDGET_PAUSE_STOP_REASON;
}

const runIssueId = sql<string | null>`coalesce(${heartbeatRuns.issueId}::text, ${heartbeatRuns.nativeIssueId}::text,
  ${heartbeatRuns.contextSnapshot}->>'issueId')`;
const runEndedAt = sql<Date>`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.updatedAt})`;
const cutRunFields = { id: heartbeatRuns.id, issueId: runIssueId, status: heartbeatRuns.status, endedAt: runEndedAt,
  resultJson: heartbeatRuns.resultJson };

export async function continueRunsCutByPause(db: Db, input: PauseResumeContinuation) {
  const { companyId, agentId } = input;
  // Runs that never started are read too: a pause cuts queued runs as well.
  const cancelled = await db.select(cutRunFields).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
    eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "cancelled"), sql`${runEndedAt} >= ${input.pausedAt.toISOString()}::timestamptz`))
    .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(CUT_RUNS_READ_AT_MOST);
  // Requests an earlier resume filed and that the lifted pause cancelled: their tasks are looked at again.
  const lost = await db.select({ issueId: sql<string | null>`${agentWakeupRequests.payload}->>'issueId'` }).from(agentWakeupRequests)
    .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId),
      cancelledByPauseSince(input.pausedAt),
      sql`${agentWakeupRequests.idempotencyKey} like ${`${PAUSE_RESUME_RETRY_KEY_PREFIX}%`}`))
    .orderBy(desc(agentWakeupRequests.requestedAt)).limit(CUT_RUNS_READ_AT_MOST);
  const issueIds = [...new Set([
    ...cancelled.filter(run => run.issueId && isGovernancePauseStop(run) && !cutForBudget(run)).map(run => run.issueId!),
    ...lost.map(wake => wake.issueId).filter((id): id is string => Boolean(id))])];
  const result = { candidates: 0, continued: 0, kept: 0, notContinued: 0 };
  const failures: unknown[] = [];
  for (const issueId of issueIds) {
    // One task's failure must not stop the others. It is not swallowed: see below.
    try {
      const outcome = await continueOne(db, input, issueId);
      if (!outcome) continue;
      result.candidates += 1;
      result[outcome] += 1;
    } catch (error) {
      failures.push(error);
      logger.error({ err: error, companyId, agentId, issueId, readyOperationId: input.readyOperationId },
        "a run cut by a pause could not be continued, or its record could not be written, at the resume");
    }
  }
  // A failure, of a record above all, must not pass in silence: the lifecycle worker reports the ready hook's error.
  if (failures.length) {
    throw new AggregateError(failures, `the continuation of runs cut by a pause failed for ${failures.length} task(s) of agent ${agentId}`);
  }
  return result;
}

async function continueOne(db: Db, input: PauseResumeContinuation, issueId: string): Promise<"continued" | "kept" | "notContinued" | null> {
  const { companyId, agentId, readyOperationId } = input;
  const write = input.record ?? logActivity;
  const [task] = await db.select({ id: issues.id, status: issues.status }).from(issues).where(and(
    eq(issues.companyId, companyId), eq(issues.id, issueId), eq(issues.assigneeAgentId, agentId),
    inArray(issues.status, OPEN_TASK_STATUSES)));
  // Closed, or no longer this agent's task: not its work any more.
  if (!task) return null;
  const onTask = and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId),
    or(eq(heartbeatRuns.issueId, issueId), eq(heartbeatRuns.nativeIssueId, issueId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`));
  const [cut] = await db.select(cutRunFields).from(heartbeatRuns).where(onTask)
    .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
  // The agent already ran on the task after the cut, or its latest run ended another way: nothing to continue.
  if (!cut || !isGovernancePauseStop(cut) || cutForBudget(cut)) return null;
  // A run an earlier pause cut is not this resume's, unless the lifted pause cancelled the request filed for it:
  // a new pause cancels a kept request, and nothing else would file it again. A request a person cancelled stays so.
  let replacesRetryRequestId: string | null = null;
  if (new Date(cut.endedAt).getTime() < input.pausedAt.getTime()) {
    const [lostRequest] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId),
      cancelledByPauseSince(input.pausedAt),
      sql`${agentWakeupRequests.idempotencyKey} like ${`${PAUSE_RESUME_RETRY_KEY_PREFIX}${cut.id}:%`}`))
      .orderBy(desc(agentWakeupRequests.requestedAt)).limit(1);
    if (!lostRequest) return null;
    replacesRetryRequestId = lostRequest.id;
  }
  const [budgetClaim] = await db.select({ id: budgetResumeClaims.runId }).from(budgetResumeClaims)
    .where(eq(budgetResumeClaims.runId, cut.id)).limit(1);
  if (budgetClaim) return null;
  // One evaluation of a cut run per ready operation.
  const [evaluated] = await db.select({ id: activityLog.id }).from(activityLog).where(and(
    eq(activityLog.companyId, companyId), eq(activityLog.entityType, "issue"), eq(activityLog.entityId, issueId),
    inArray(activityLog.action, [PAUSE_CUT_WORK_NOT_CONTINUED, PAUSE_CUT_WORK_REQUEST_FILED]),
    sql`${activityLog.details}->>'interruptedRunId' = ${cut.id}`,
    sql`${activityLog.details}->>'readyOperationId' = ${readyOperationId}`)).limit(1);
  if (evaluated) return null;

  const person = input.requestedBy;
  const entry = (action: string, details: Record<string, unknown>): LogActivityInput => ({ companyId, actorType: "system",
    actorId: PAUSE_RESUME_ACTOR_ID, agentId, action, entityType: "issue", entityId: issueId,
    details: { interruptedRunId: cut.id, readyOperationId,
      ...(person ? { resumedByUserId: person.userId, actorSource: person.source } : {}),
      ...(replacesRetryRequestId ? { replacesRetryRequestId } : {}), ...details } });
  const refuse = async (reason: string, details: Record<string, unknown> = {}) => {
    await recordOnce(db, write, entry(PAUSE_CUT_WORK_NOT_CONTINUED, { reason, ...details }));
    return "notContinued" as const;
  };

  if (!person) return refuse("resumed_without_a_person");
  if (!RETRY_ACTOR_SOURCES.includes(person.source)) return refuse("resume_source_not_allowed");
  const blocker = await getExecutionBlocker(db, companyId, issueId);
  // No hold: a run cut before it started, a reconciled run, or a task a person's request already released. The
  // task's ordinary wakes start it; this files nothing.
  if (!blocker?.recoveryActionId) return refuse("not_held");
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

  // The Retry and its record commit together: no request is ever filed without its entry on the task.
  const requestRetry = input.requestRetry ?? (await import("./task-retry.js")).requestTaskRetry;
  const publications: ActivityPublication[] = [];
  let requestId: string | null = null;
  try {
    requestId = await db.transaction(async tx => {
      const receipt = await requestRetry({ db: tx as unknown as Db, companyId, issueId, observedRunId: cut.id,
        actorId: person.userId, actorSource: person.source,
        idempotencyKey: `${RETRY_KEY}${cut.id}:${readyOperationId}` });
      // The cut run is no longer the agent's latest run on the task, or the task was closed or handed over.
      if (!receipt.accepted || !receipt.requestId) return null;
      await write(tx as unknown as Db, entry(PAUSE_CUT_WORK_REQUEST_FILED, { retryRequestId: receipt.requestId }), publications);
      return receipt.requestId;
    });
  } catch (error) {
    // A refusal the Retry path names is this resume's answer; anything else is a failure.
    if (!(error instanceof HttpError) || error.status < 400 || error.status >= 500) throw error;
    const code = (error.details as { code?: unknown } | undefined)?.code;
    return refuse(typeof code === "string" ? code : `retry_refused_${error.status}`);
  }
  for (const publication of publications) publishActivity(publication);
  if (!requestId) return refuse("already_continued");

  // Dispatch now. Where the Retry's run is created, recordPauseCutWorkContinued writes the "continued" entry.
  await input.resumeTaskRetry(companyId, requestId).catch(error =>
    logger.warn({ err: error, companyId, issueId, requestId }, "the Retry of a run cut by a pause stays queued"));
  const [next] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId),
    sql`${heartbeatRuns.contextSnapshot}->>'previousRunId' = ${cut.id}`)).limit(1);
  if (next) return "continued";
  const [wake] = await db.select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error,
    payload: agentWakeupRequests.payload }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.id, requestId)));
  if (wake?.status !== "deferred_issue_execution") {
    return refuse("retry_not_started", { retryRequestId: requestId, retryStatus: wake?.status ?? null,
      ...(wake?.error ? { retryError: wake.error } : {}) });
  }
  // The gate keeps the request: it starts by itself once the wait clears. Kept, not refused.
  const wait = record(record(wake.payload).executionWait).reason;
  const reason = typeof wait !== "string" ? "retry_saved_not_dispatched"
    : STOP_NOT_PROVEN_WAITS.has(wait) ? "stop_not_proven" : wait === "decision_pending" ? "waiting_for_person" : wait;
  await recordOnce(db, write, entry(PAUSE_CUT_WORK_KEPT, { reason, retryRequestId: requestId, ...(typeof wait === "string" ? { wait } : {}) }));
  return "kept";
}

/** One entry per cut run and per reason: a second identical refusal or wait is not written again. */
async function recordOnce(db: Db, write: Record_, input: LogActivityInput) {
  const details = record(input.details);
  const [same] = await db.select({ id: activityLog.id }).from(activityLog).where(and(
    eq(activityLog.companyId, input.companyId), eq(activityLog.entityType, input.entityType),
    eq(activityLog.entityId, input.entityId), eq(activityLog.action, input.action),
    sql`${activityLog.details}->>'interruptedRunId' = ${String(details.interruptedRunId)}`,
    sql`${activityLog.details}->>'reason' = ${String(details.reason)}`)).limit(1);
  if (same) return false;
  await write(db, input);
  return true;
}

/**
 * Asked where a Retry is dispatched (heartbeat/run-control.ts, resumeTaskRetry), for the requests this file filed:
 * a task its owner has set to blocked since, or that waits for a blocker, must not start. The request stays kept,
 * and the task says why, once. A Retry a person filed is not concerned: it answers true.
 */
export async function pauseCutWorkRequestMayStart(db: Db, input: {
  companyId: string; agentId: string; issueId: string; retryRequestId: string; idempotencyKey: string | null;
  cutRunId: string; actorId: string; actorSource: string;
}) {
  if (!input.idempotencyKey?.startsWith(PAUSE_RESUME_RETRY_KEY_PREFIX)) return true;
  const [task] = await db.select({ status: issues.status }).from(issues).where(and(
    eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)));
  const reason = task?.status === "blocked" ? "task_blocked"
    : !(await (await import("./issues.js")).issueService(db).getDependencyReadiness(input.issueId)).isDependencyReady
      ? "blocked_by_dependency" : null;
  if (!reason) return true;
  const readyOperationId = input.idempotencyKey.slice(PAUSE_RESUME_RETRY_KEY_PREFIX.length).split(":")[1] ?? null;
  await recordOnce(db, logActivity, { companyId: input.companyId, actorType: "system", actorId: PAUSE_RESUME_ACTOR_ID,
    agentId: input.agentId, action: PAUSE_CUT_WORK_KEPT, entityType: "issue", entityId: input.issueId,
    details: { interruptedRunId: input.cutRunId, readyOperationId, resumedByUserId: input.actorId,
      actorSource: input.actorSource, retryRequestId: input.retryRequestId, reason } }).catch(error =>
    logger.error({ err: error, companyId: input.companyId, issueId: input.issueId, requestId: input.retryRequestId, reason },
      "a request that continues work a pause cut is kept back, but its record on the task could not be written"));
  return false;
}

/** A kept request says so on its task once it has waited this long for the proof that the cut run stopped. */
export const PAUSE_CUT_WORK_STILL_WAITING_AFTER_MS = 30 * 60_000;

/**
 * Asked where a kept Retry is looked at again (heartbeat/run-control.ts, resumeTaskRetry; the deferred-receipt work
 * looks at every kept request about every thirty seconds): the request this file filed did not start, and the gate
 * still waits for the proof that the cut run stopped. Past thirty minutes the task gets ONE note that says what is
 * awaited, so that a continuation that does not come is not silent.
 */
export async function notePauseCutWorkStillWaiting(db: Db, input: {
  companyId: string; agentId: string; issueId: string; retryRequestId: string; idempotencyKey: string | null;
  cutRunId: string; actorId: string; actorSource: string; now?: Date;
}) {
  if (!input.idempotencyKey?.startsWith(PAUSE_RESUME_RETRY_KEY_PREFIX)) return false;
  const [wake] = await db.select({ status: agentWakeupRequests.status, createdAt: agentWakeupRequests.createdAt,
    payload: agentWakeupRequests.payload }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.id, input.retryRequestId)));
  const waitRecord = record(record(wake?.payload).executionWait);
  const wait = waitRecord.reason;
  if (wake?.status !== "deferred_issue_execution" || typeof wait !== "string" || !STOP_NOT_PROVEN_WAITS.has(wait)) return false;
  if ((input.now ?? new Date()).getTime() - wake.createdAt.getTime() < PAUSE_CUT_WORK_STILL_WAITING_AFTER_MS) return false;
  const readyOperationId = input.idempotencyKey.slice(PAUSE_RESUME_RETRY_KEY_PREFIX.length).split(":")[1] ?? null;
  const first = await recordOnce(db, logActivity, { companyId: input.companyId, actorType: "system", actorId: PAUSE_RESUME_ACTOR_ID,
    agentId: input.agentId, action: PAUSE_CUT_WORK_KEPT, entityType: "issue", entityId: input.issueId,
    details: { interruptedRunId: input.cutRunId, readyOperationId, resumedByUserId: input.actorId, actorSource: input.actorSource,
      retryRequestId: input.retryRequestId, reason: "still_waiting_for_stop_proof", wait } });
  if (!first) return false;
  const message = typeof waitRecord.message === "string" ? ` (${waitRecord.message})` : "";
  await (await import("./issues.js")).issueService(db).addComment(input.issueId,
    `The work a pause cut on this task has not started again yet. Paperclip has waited for more than 30 minutes for proof that the previous run \`${input.cutRunId}\` stopped: \`${wait}\`${message}. The request is kept and starts by itself once that is proven; nothing was lost. If it does not clear, inspect that run and its machine.`,
    {}, { authorType: "system" });
  return true;
}

/**
 * The run of a Retry this file filed has been created: say so on the task. Called where the Retry is dispatched
 * (heartbeat/run-control.ts, resumeTaskRetry), so a request that was kept and starts later is recorded too.
 */
export async function recordPauseCutWorkContinued(db: Db, input: {
  companyId: string; agentId: string; issueId: string; retryRequestId: string; idempotencyKey: string | null;
  cutRunId: string; actorId: string; actorSource: string; continuationRunId: string;
}) {
  if (!input.idempotencyKey?.startsWith(PAUSE_RESUME_RETRY_KEY_PREFIX)) return false;
  const [cutRunId, readyOperationId] = input.idempotencyKey.slice(PAUSE_RESUME_RETRY_KEY_PREFIX.length).split(":");
  if (cutRunId !== input.cutRunId) return false;
  const [recorded] = await db.select({ id: activityLog.id }).from(activityLog).where(and(
    eq(activityLog.companyId, input.companyId), eq(activityLog.entityType, "issue"), eq(activityLog.entityId, input.issueId),
    eq(activityLog.action, PAUSE_CUT_WORK_CONTINUED),
    sql`${activityLog.details}->>'retryRequestId' = ${input.retryRequestId}`)).limit(1);
  if (recorded) return false;
  await logActivity(db, { companyId: input.companyId, actorType: "system", actorId: PAUSE_RESUME_ACTOR_ID,
    agentId: input.agentId, action: PAUSE_CUT_WORK_CONTINUED, entityType: "issue", entityId: input.issueId,
    details: { interruptedRunId: input.cutRunId, readyOperationId: readyOperationId ?? null,
      resumedByUserId: input.actorId, actorSource: input.actorSource, retryRequestId: input.retryRequestId,
      continuationRunId: input.continuationRunId } });
  return true;
}
