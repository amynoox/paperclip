// STUDIO-0078 (TR-2069, 20 Nov 2026): guard against an endless relaunch on an
// engine session that no longer reopens.
//
// The fact. A role failed ten times in forty minutes on the same engine
// session. Each failure scheduled a bounded retry, and each retry was cancelled
// (`issue_waiting_for_response`); the next run came from another role's
// comment (`issue_commented`), which is not a retry, so the bounded-retry
// counter (retries.ts, `failedRunRetryBudgetSpent`) started from zero at every
// turn. Nothing bounded the cycle.
//
// The rule, applied when a run of an agent on an issue is about to prepare its
// session, whatever woke it:
// - the SERIES is the latest consecutive runs of the SAME agent on the SAME
//   issue that failed, resumed the same engine session, lasted under
//   RELAUNCH_LOOP_SHORT_RUN_MS and left nothing behind, whatever their error
//   code;
// - a run that ended on a timeout is counted whatever it lasted: a session
//   too large to reopen makes every run that resumes it reach its timeout,
//   and each of those runs lasts as long as the timeout itself (STUDIO-0080
//   returns the session of a timed-out run, so such a session is resumed).
//   Such a run counts only when the engine itself did nothing: a role that
//   compiles, plays or migrates through its whole timeout and comments only
//   at the end left nothing on the issue either, and must keep its session;
// - declared waits, refusals the worker router returns before any reservation,
//   failures it returns before it launches any engine, cancellations, and runs
//   that failed in setup before their adapter was admitted (a lease that could
//   not be acquired) are neither counted nor do they end the series: none of
//   them says anything about the session;
// - runs of other agents are not read at all, so another role's run or comment
//   between two failures does not end the series;
// - any other run of the agent (a success, a failure that left something
//   behind, a long failure, a failure on another session) ends it;
// - at RELAUNCH_LOOP_FAILURE_THRESHOLD, the run about to start drops the
//   session and starts on a fresh one, with one note on the issue;
// - if that run on a fresh session fails the same way (an empty failure), the
//   session was not the cause: the issue is handed to the direct manager of
//   the role (STUDIO-0083, manager-handover.ts), with a note that gives the
//   code and the number of failures, and no Board action. The role is no
//   longer the assignee, so nothing relaunches it on the issue until the
//   manager gives it back. The hand-over is made when that run ends, however
//   it ended. The role's own retry still in the queue and the manager's own
//   run on the issue (the worker router's card wakes it after each failure)
//   do not hold the issue: with them it is handed at once. Another agent's
//   live run, or a run of the role that has started, does: the hand-over is
//   then logged, kept, and asked again at the end of each run on the issue
//   until it is made or no longer due. It is
//   never refused without a word. If the server stops in between, the role
//   goes on, a new series forms on the session of the fresh run, and the
//   hand-over is made at the end of the next fresh run. Where no manager can
//   receive the issue (none, not invokable, or handed twice already), the
//   issue is blocked with a Board action, as stranded work is today;
// - a passing failure of the provider (quota, rate limit, an upstream outage,
//   a process lost at a restart) is neither counted nor ends the series, by
//   its code: three quick failures during an outage must not drop a sound
//   session. The adapter's "transient" family is NOT used for this:
//   production scheduled a transient retry after each failure of TR-2069,
//   which the server does only for a failure it reads as transient, so the
//   family would take the very failures the guard exists for out of the series.
//
// Reading the history at each start, with no counter of its own, is what makes
// the guard survive a server restart or a cut in the middle of the gesture:
// the next run reads the same runs and takes the same decision.
import { and, desc, eq, gte, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { logActivity } from "../activity-log.js";
import { issueService } from "../issues.js";
import { ISSUE_PROGRESS_ACTIVITY_ACTIONS } from "../issue-rewake-throttle.js";
import {
  ADAPTER_DECLARED_WAIT_ERROR_CODES,
  ROUTER_REFUSAL_ERROR_CODES,
} from "../recovery/adapter-declared-wait.js";
import { handIssueToManager, type ManagerHandoverWakeup } from "../recovery/manager-handover.js";
import { keyValueRow, runLinkRow, systemNoticePresentation } from "../recovery/notice-format.js";
import { isRunLogStoreType, type RunLogStoreType } from "../run-log-store.js";

/** Consecutive empty failures on one session before the session is dropped. */
export const RELAUNCH_LOOP_FAILURE_THRESHOLD = 3;

/** A failure counts only when the run lasted less than this, unless it ended on a timeout. */
export const RELAUNCH_LOOP_SHORT_RUN_MS = 5 * 60_000;

// A run that ended on a timeout: the run's own status, or the code under which
// the adapter or the worker router reports that its engine ran out of time.
export const RELAUNCH_LOOP_TIMEOUT_ERROR_CODES: readonly string[] = Object.freeze([
  "timeout",
  "router_interactive_timeout",
]);

export function isRelaunchLoopTimeout(run: Pick<RelaunchLoopRunSample, "status" | "errorCode">): boolean {
  return run.status === "timed_out" || Boolean(run.errorCode && RELAUNCH_LOOP_TIMEOUT_ERROR_CODES.includes(run.errorCode));
}

/** How many started runs of the agent on the issue are read, newest first. */
export const RELAUNCH_LOOP_RUN_SAMPLE_LIMIT = 40;

export const RELAUNCH_LOOP_GUARD_CONTEXT_KEY = "relaunchLoopGuard";

export const RELAUNCH_LOOP_FRESH_SESSION_ACTIVITY_ACTION = "issue.relaunch_loop_fresh_session";

// Refusals the worker router returns before it reserves any machine: no engine
// was launched, so the session was not tried. The first four are STUDIO-0059's;
// the others are the router's remaining pre-reservation refusals.
export const ROUTER_PRE_RESERVATION_REFUSAL_CODES: readonly string[] = Object.freeze([...new Set([
  // STUDIO-0083 names eight of them as refusals of its own; the list is kept whole here.
  ...ROUTER_REFUSAL_ERROR_CODES,
  "router_request_block_invalid",
  "router_request_system_unknown",
  "router_attempt_already_used",
  "router_ticket_already_completed",
  "router_reservation_released",
  "router_reservation_unavailable",
  "router_stale_reservation_wake",
  "router_ticket_not_assigned_to_agent",
])]);

// Failures the worker router returns before it launches any engine (its own
// list, 20 Nov 2026, router commit 6d298b0): an estimate that never came, a
// control scope or a secret read that stayed busy, a machine that stopped
// answering during preparation, no time left before the launch. Their cause is
// outside the session, and the server cannot tell them from a launched engine
// by the run's stage (the adapter is admitted before the router decides).
// `router_waiting_for_resources` and `router_previous_dispatch_unsettled` are
// declared waits and are skipped as such.
export const ROUTER_PRE_LAUNCH_FAILURE_CODES: readonly string[] = Object.freeze([
  "router_estimate_not_received",
  "router_control_scope_busy",
  "router_secret_read_limited",
  "router_worker_unreachable",
  "router_continuation_deadline_expired",
]);

// Lines the host writes into a run log itself, each through its own log call:
// the worker router's notes (one a minute while it waits before a launch) and
// Paperclip's own diagnostics. They are not the engine's output.
// Passing failures of the provider or of the host, by their code (the codes the server itself reads as a quota or
// an upstream failure, heartbeat/retries.ts readHeartbeatRunErrorFamily, and a process lost at a restart). They say
// nothing about the session.
export const RELAUNCH_LOOP_PASSING_FAILURE_CODES: readonly string[] = Object.freeze([
  "provider_quota",
  "codex_transient_upstream",
  "claude_transient_upstream",
  "process_lost",
]);

export const RUN_LOG_HOST_LINE_PREFIXES: readonly string[] = Object.freeze([
  "[paperclip-router] ",
  "[paperclip] ",
]);

// The line by which an engine announces its session (Codex: `thread.started`; Claude: `system`/`init`). It says a
// session was opened, not that the engine did anything. The worker router writes Codex's when the session opens,
// which can be ten minutes into a run that waited before its launch: counted as output, it would make an engine
// that then stayed silent until its timeout look like one at work.
function isSessionAnnouncementLine(text: string): boolean {
  if (!text.startsWith("{")) return false;
  try {
    const event = JSON.parse(text) as { type?: unknown; subtype?: unknown } | null;
    return event?.type === "thread.started" || (event?.type === "system" && event?.subtype === "init");
  } catch {
    return false;
  }
}

/** True when a run log chunk holds at least one line of the engine's work: not the host's, not a session announcement. */
export function isEngineOutputChunk(chunk: string): boolean {
  return chunk.split(/\r?\n/).some((line) => {
    const text = line.trim();
    return text.length > 0 && !RUN_LOG_HOST_LINE_PREFIXES.some((prefix) => line.trimStart().startsWith(prefix)) && !isSessionAnnouncementLine(text);
  });
}

/**
 * The time of the last record of a run log page (NDJSON, one record per log
 * call) that holds engine output; null when the page holds none.
 */
export function lastEngineOutputAtInLogPage(content: string): Date | null {
  const lines = content.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    let record: { ts?: unknown; stream?: unknown; chunk?: unknown };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue;
    }
    if (record.stream !== "stdout" && record.stream !== "stderr") continue;
    if (typeof record.chunk !== "string" || !isEngineOutputChunk(record.chunk)) continue;
    const at = typeof record.ts === "string" ? new Date(record.ts) : null;
    if (!at || Number.isNaN(at.getTime())) continue;
    return at;
  }
  return null;
}

export interface RelaunchLoopRunSample {
  id: string;
  status: string;
  errorCode: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** The engine session the run resumed; null when it started a fresh one. */
  sessionIdBefore: string | null;
  /**
   * The server holds a sign that the engine worked during the run: output
   * tokens of the model, a summary returned by the adapter, or output the
   * engine itself was still writing after the run's first
   * RELAUNCH_LOOP_SHORT_RUN_MS (the host's own log lines are not the engine).
   * Read only for a run that ended on a timeout after that long.
   */
  engineWorked: boolean;
  /**
   * The run failed in setup, before its adapter was admitted: a legacy run
   * still at stage `preparing` (the controller writes `dispatching` in the
   * lease renewal that admits the adapter). The adapter's own
   * `providerWorkStarted: false` is not used: the worker router declares it on
   * failures of a launched engine too, and those are the ones to count.
   */
  engineNeverStarted: boolean;
  /**
   * Set when the guard started this run on a fresh session: the number of
   * failures of the series that led to it. Null or absent for any other run.
   */
  guardFailedRunCount?: number | null;
}

export type RelaunchLoopRunClass = "skipped" | "empty_failure" | "other";

/** A failed run that ended on a timeout after RELAUNCH_LOOP_SHORT_RUN_MS: whether it counts hangs on its engine's work. */
function engineWorkDecides(run: RelaunchLoopRunSample): boolean {
  return Boolean(
    run.startedAt && run.finishedAt && FAILED_STATUSES.includes(run.status) && isRelaunchLoopTimeout(run)
    && run.finishedAt.getTime() - run.startedAt.getTime() >= RELAUNCH_LOOP_SHORT_RUN_MS,
  );
}

const FAILED_STATUSES: readonly string[] = Object.freeze(["failed", "timed_out"]);
const CUT_STATUSES: readonly string[] = Object.freeze(["cancelled", "interrupted"]);

/**
 * `skipped`: says nothing about the session, neither counted nor ending the
 * series. `empty_failure`: counted. `other`: ends the series.
 */
export function classifyRelaunchLoopRun(
  run: RelaunchLoopRunSample,
  producedSomething: boolean,
): RelaunchLoopRunClass {
  if (!run.startedAt) return "skipped";
  if (CUT_STATUSES.includes(run.status)) return "skipped";
  if (!FAILED_STATUSES.includes(run.status)) return "other";
  if (run.errorCode && ADAPTER_DECLARED_WAIT_ERROR_CODES.includes(run.errorCode)) return "skipped";
  if (run.errorCode && ROUTER_PRE_RESERVATION_REFUSAL_CODES.includes(run.errorCode)) return "skipped";
  if (run.errorCode && ROUTER_PRE_LAUNCH_FAILURE_CODES.includes(run.errorCode)) return "skipped";
  if (run.errorCode && RELAUNCH_LOOP_PASSING_FAILURE_CODES.includes(run.errorCode)) return "skipped";
  if (run.engineNeverStarted) return "skipped";
  if (!run.finishedAt) return "other";
  if (run.finishedAt.getTime() - run.startedAt.getTime() >= RELAUNCH_LOOP_SHORT_RUN_MS) {
    // A long run counts only when it ended on a timeout and its engine did nothing meanwhile.
    if (!isRelaunchLoopTimeout(run) || run.engineWorked) return "other";
  }
  if (producedSomething) return "other";
  return "empty_failure";
}

export type RelaunchLoopDecision =
  | { action: "none"; streak: number }
  | {
      action: "fresh_session";
      sessionId: string;
      /** The series, oldest first. */
      failedRuns: RelaunchLoopRunSample[];
    };

/**
 * Pure decision over the started runs of one agent on one issue, newest first
 * (the run about to start is not among them).
 */
export function evaluateRelaunchLoop(input: {
  runs: readonly RelaunchLoopRunSample[];
  runIdsThatProducedSomething: ReadonlySet<string>;
}): RelaunchLoopDecision {
  const series: RelaunchLoopRunSample[] = [];
  let sessionId: string | null = null;
  for (const run of input.runs) {
    const kind = classifyRelaunchLoopRun(run, input.runIdsThatProducedSomething.has(run.id));
    if (kind === "skipped") continue;
    if (kind !== "empty_failure" || !run.sessionIdBefore) break;
    if (sessionId === null) sessionId = run.sessionIdBefore;
    if (run.sessionIdBefore !== sessionId) break;
    series.push(run);
  }
  if (sessionId === null || series.length < RELAUNCH_LOOP_FAILURE_THRESHOLD) {
    return { action: "none", streak: series.length };
  }
  return { action: "fresh_session", sessionId, failedRuns: [...series].reverse() };
}

export const RELAUNCH_LOOP_HANDOVER_CAUSE = "relaunch_loop";

export type RelaunchLoopHandoverDecision =
  | { handover: false }
  | { handover: true; freshRun: RelaunchLoopRunSample };

/**
 * Pure decision over the same runs: the newest run that says something about
 * the session is the one the guard started on a fresh session, and it is an
 * empty failure too. A run that only waited or was refused says nothing and
 * is passed over; any other run of the agent since then ends the matter.
 * `heldBefore`: the hand-over was due and another agent's run held the issue. The role may have failed empty again
 * meanwhile: such runs change nothing, the hand-over is still due under the fresh run.
 */
export function evaluateRelaunchLoopHandover(input: {
  runs: readonly RelaunchLoopRunSample[];
  runIdsThatProducedSomething: ReadonlySet<string>;
  heldBefore?: boolean;
}): RelaunchLoopHandoverDecision {
  for (const run of input.runs) {
    const kind = classifyRelaunchLoopRun(run, input.runIdsThatProducedSomething.has(run.id));
    if (kind === "skipped") continue;
    if (kind !== "empty_failure") return { handover: false };
    if (typeof run.guardFailedRunCount === "number") return { handover: true, freshRun: run };
    if (!input.heldBefore) return { handover: false };
  }
  return { handover: false };
}

export function relaunchLoopHandoverNote(input: { agentName: string; failedRunCount: number; code: string | null }) {
  const code = input.code ?? "no code";
  return {
    title: "Relaunch guard: handed to the manager",
    body:
      `${input.agentName} failed ${input.failedRunCount} times in a row on this issue while resuming the same engine session, `
      + `then failed again on a fresh session (\`${code}\`), each time without leaving anything behind. `
      + `The session was not the cause, so ${input.agentName} is no longer relaunched on this issue. `
      + `Handed to {manager} for review: read the failed runs, then give the issue back to ${input.agentName}, reassign it, or close it.`,
    nextAction: `Read the failed runs, then give the issue back to ${input.agentName}, reassign it, or close it.`,
  };
}

export function relaunchLoopBoardBlockBody(input: { agentName: string; failedRunCount: number; code: string | null }): string {
  return (
    `${input.agentName} failed ${input.failedRunCount} times in a row on this issue while resuming the same engine session, `
    + `then failed again on a fresh session (\`${input.code ?? "no code"}\`), each time without leaving anything behind. `
    + "No manager can receive the issue. Moving it to `blocked` so it is visible for intervention."
  );
}

export function relaunchLoopFreshSessionNoteBody(input: {
  agentName: string;
  failedRuns: readonly Pick<RelaunchLoopRunSample, "errorCode" | "status">[];
}): string {
  const codes = [...new Set(input.failedRuns.map((run) => run.errorCode ?? "no code"))]
    .map((code) => `\`${code}\``)
    .join(", ");
  const minutes = RELAUNCH_LOOP_SHORT_RUN_MS / 60_000;
  const timeouts = input.failedRuns.filter(isRelaunchLoopTimeout).length;
  const how = timeouts === 0
    ? `each in under ${minutes} minutes`
    : timeouts === input.failedRuns.length
      ? "each on a timeout"
      : `each on a timeout or in under ${minutes} minutes`;
  return (
    `The last ${input.failedRuns.length} runs of ${input.agentName} on this issue failed one after the other ` +
    `while resuming the same engine session, ${how} and without leaving anything behind (${codes}). ` +
    "That session is dropped: the next run starts on a fresh session."
  );
}

// What the server records of an engine's own work during a run, whatever the adapter:
// - the model's output tokens (usage_json, written from the adapter's result; Claude reports them as its stream
//   goes, so a run cut by its timeout has them);
// - the summary the adapter returned (result_json.summary: text the engine wrote);
// - output the engine was still writing after the run's first RELAUNCH_LOOP_SHORT_RUN_MS: an engine that fell silent
//   before that only waited for its timeout. The run row keeps the time of its last log chunk (last_output_at)
//   whoever wrote it, and the host writes lines of its own (the worker router, one a minute while it waits before a
//   launch): when that time is late, the run log itself is read from its end for the last chunk that is not the
//   host's. The worker router returns neither tokens nor a summary with a failure, so for a routed role this third
//   sign is the only one.
const outputTokensOf = (key: string) =>
  sql`(jsonb_typeof(${heartbeatRuns.usageJson} -> ${key}) = 'number' and (${heartbeatRuns.usageJson} ->> ${key})::numeric > 0)`;
const ENGINE_REPORTED_SQL = sql<boolean>`coalesce(
  ${outputTokensOf("outputTokens")} or ${outputTokensOf("rawOutputTokens")}
  or nullif(btrim(${heartbeatRuns.resultJson} ->> 'summary'), '') is not null,
  false)`;
const LATE_OUTPUT_SQL = sql<boolean>`coalesce(
  ${heartbeatRuns.lastOutputAt} >= ${heartbeatRuns.startedAt} + make_interval(secs => ${RELAUNCH_LOOP_SHORT_RUN_MS / 1000}),
  false)`;

/** Reads a page of a run's log (the run log store's `read`). */
export type RelaunchLoopRunLogReader = (
  handle: { store: RunLogStoreType; logRef: string },
  opts: { offset: number; limitBytes: number; alignStartToRecord: boolean },
) => Promise<{ content: string }>;

const RUN_LOG_PAGE_BYTES = 256_000;
const RUN_LOG_MAX_PAGES = 8;
/** Run logs read per decision, newest runs first; an older run with late output keeps "the engine worked". */
const RUN_LOG_MAX_READS = 6;

type RunLogRef = { logStore: string | null; logRef: string | null; logBytes: number | null };

// The time of the last engine output of a finished run, read from the end of its log. `null`: the log holds none.
// `undefined`: not known (no reader, no log, a log too long to read back, an error), and the caller keeps
// "the engine worked": dropping the session of a role at work costs more than one more run on a dead one.
async function readLastEngineOutputAt(readRunLog: RelaunchLoopRunLogReader | undefined, run: RunLogRef): Promise<Date | null | undefined> {
  if (!readRunLog || !run.logRef || !isRunLogStoreType(run.logStore) || run.logBytes === null) return undefined;
  try {
    let end = Number(run.logBytes);
    for (let page = 0; page < RUN_LOG_MAX_PAGES && end > 0; page += 1) {
      const offset = Math.max(0, end - RUN_LOG_PAGE_BYTES);
      const { content } = await readRunLog({ store: run.logStore, logRef: run.logRef }, { offset, limitBytes: end - offset, alignStartToRecord: true });
      const at = lastEngineOutputAtInLogPage(content);
      if (at) return at;
      end = offset;
    }
    return end > 0 ? undefined : null;
  } catch {
    return undefined;
  }
}

async function readStartedRuns(
  db: Db,
  input: { companyId: string; agentId: string; issueId: string; exceptRunId: string | null; readRunLog?: RelaunchLoopRunLogReader },
): Promise<RelaunchLoopRunSample[]> {
  const rows = await db
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      errorCode: heartbeatRuns.errorCode,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      sessionIdBefore: heartbeatRuns.sessionIdBefore,
      engineNeverStarted: sql<boolean>`coalesce(${heartbeatRuns.runtimeMode} = 'legacy' and ${heartbeatRuns.executionStage} = 'preparing', false)`,
      engineReported: ENGINE_REPORTED_SQL,
      lateOutput: LATE_OUTPUT_SQL,
      guardFailedRunCount: sql<number | null>`case when ${heartbeatRuns.contextSnapshot} -> ${RELAUNCH_LOOP_GUARD_CONTEXT_KEY} ->> 'action' = 'fresh_session'
        then jsonb_array_length(coalesce(${heartbeatRuns.contextSnapshot} -> ${RELAUNCH_LOOP_GUARD_CONTEXT_KEY} -> 'failedRunIds', '[]'::jsonb)) end`,
      logStore: heartbeatRuns.logStore,
      logRef: heartbeatRuns.logRef,
      logBytes: heartbeatRuns.logBytes,
    })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId),
      sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`,
      isNotNull(heartbeatRuns.startedAt),
      input.exceptRunId ? ne(heartbeatRuns.id, input.exceptRunId) : undefined,
    ))
    .orderBy(desc(heartbeatRuns.startedAt), desc(heartbeatRuns.id))
    .limit(RELAUNCH_LOOP_RUN_SAMPLE_LIMIT);
  const samples: RelaunchLoopRunSample[] = [];
  let logReads = 0;
  for (const { engineReported, lateOutput, logStore, logRef, logBytes, ...row } of rows) {
    let engineWorked = engineReported === true || lateOutput === true;
    // The late chunk may be the host's own: ask the log, for the runs where the answer decides.
    if (engineReported !== true && lateOutput === true && row.startedAt && engineWorkDecides({ ...row, engineWorked: false, engineNeverStarted: false })
      && logReads < RUN_LOG_MAX_READS) {
      logReads += 1;
      const lastEngineOutputAt = await readLastEngineOutputAt(input.readRunLog, { logStore, logRef, logBytes });
      if (lastEngineOutputAt !== undefined) {
        engineWorked = lastEngineOutputAt !== null
          && lastEngineOutputAt.getTime() >= row.startedAt.getTime() + RELAUNCH_LOOP_SHORT_RUN_MS;
      }
    }
    samples.push({
      ...row,
      engineNeverStarted: row.engineNeverStarted === true,
      engineWorked,
      guardFailedRunCount: row.guardFailedRunCount === null || row.guardFailedRunCount === undefined ? null : Number(row.guardFailedRunCount),
    });
  }
  return samples;
}

// "Left something behind": the product's own list of issue-visible progress
// (issue-rewake-throttle.ts), written by the agent itself during that run, on
// any issue, or a comment of the agent created by that run. Entries the server
// writes on its own (actor `system`) are not the agent's work.
async function readRunIdsThatProducedSomething(
  db: Db,
  input: { companyId: string; runIds: readonly string[] },
): Promise<Set<string>> {
  const produced = new Set<string>();
  if (input.runIds.length === 0) return produced;
  const [activityRows, commentRows] = await Promise.all([
    db
      .selectDistinct({ runId: activityLog.runId })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, input.companyId),
        inArray(activityLog.runId, [...input.runIds]),
        eq(activityLog.actorType, "agent"),
        eq(activityLog.entityType, "issue"),
        inArray(activityLog.action, ISSUE_PROGRESS_ACTIVITY_ACTIONS),
      )),
    db
      .selectDistinct({ runId: issueComments.createdByRunId })
      .from(issueComments)
      .where(and(
        eq(issueComments.companyId, input.companyId),
        inArray(issueComments.createdByRunId, [...input.runIds]),
        eq(issueComments.authorType, "agent"),
      )),
  ]);
  for (const row of [...activityRows, ...commentRows]) if (row.runId) produced.add(row.runId);
  return produced;
}

/** Read the history of the agent on the issue and decide. Writes nothing. */
export async function readRelaunchLoopDecision(
  db: Db,
  input: { companyId: string; agentId: string; issueId: string; runId: string; readRunLog?: RelaunchLoopRunLogReader },
): Promise<RelaunchLoopDecision> {
  const runs = await readStartedRuns(db, {
    companyId: input.companyId,
    agentId: input.agentId,
    issueId: input.issueId,
    exceptRunId: input.runId,
    readRunLog: input.readRunLog,
  });
  // Only failures can be counted, so only theirs is worth reading.
  const candidateIds = runs
    .filter((run) => classifyRelaunchLoopRun(run, false) === "empty_failure")
    .map((run) => run.id);
  const runIdsThatProducedSomething = await readRunIdsThatProducedSomething(db, {
    companyId: input.companyId,
    runIds: candidateIds,
  });
  return evaluateRelaunchLoop({ runs, runIdsThatProducedSomething });
}

// One note per series: the issue row is locked, and a note with the same body
// written since the end of the series is not written twice (a run that was cut
// before it left, then the next run taking the same decision). A system comment
// wakes nobody.
async function ensureFreshSessionNote(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    agent: { id: string; name: string };
    runId: string;
    decision: Extract<RelaunchLoopDecision, { action: "fresh_session" }>;
  },
): Promise<boolean> {
  const body = relaunchLoopFreshSessionNoteBody({ agentName: input.agent.name, failedRuns: input.decision.failedRuns });
  const newest = input.decision.failedRuns[input.decision.failedRuns.length - 1]!;
  const seriesEnd = newest.finishedAt ?? newest.startedAt;
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ id: issues.id, hiddenAt: issues.hiddenAt })
      .from(issues)
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)))
      .for("update")
      .limit(1);
    if (!current || current.hiddenAt) return false;
    const [existing] = await tx
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
        eq(issueComments.authorType, "system"),
        eq(issueComments.body, body),
        seriesEnd ? gte(issueComments.createdAt, seriesEnd) : undefined,
      ))
      .limit(1);
    if (existing) return false;
    await issueService(tx as unknown as Db).addComment(
      input.issueId,
      body,
      {},
      {
        authorType: "system",
        presentation: systemNoticePresentation({ tone: "warning", title: "Relaunch guard: fresh session" }),
        metadata: {
          version: 1,
          sourceRunId: input.runId,
          sections: [{
            title: "Relaunch guard",
            rows: [
              ...input.decision.failedRuns.map((run) =>
                runLinkRow(`Failed run (${run.errorCode ?? "no code"})`, { id: run.id, status: run.status, agentId: input.agent.id })),
              keyValueRow("Dropped session", input.decision.sessionId),
              runLinkRow("Run on the fresh session", { id: input.runId, status: "running", agentId: input.agent.id }),
            ],
          }],
        },
      },
      tx,
    );
    await logActivity(tx as unknown as Db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: "relaunch_loop_guard",
      action: RELAUNCH_LOOP_FRESH_SESSION_ACTIVITY_ACTION,
      entityType: "issue",
      entityId: input.issueId,
      agentId: input.agent.id,
      runId: input.runId,
      details: {
        droppedSessionId: input.decision.sessionId,
        failedRunIds: input.decision.failedRuns.map((run) => run.id),
        errorCodes: input.decision.failedRuns.map((run) => run.errorCode),
      },
    });
    return true;
  });
}

export interface RelaunchLoopHandoverDeps {
  enqueueWakeup: ManagerHandoverWakeup;
  readRunLog?: RelaunchLoopRunLogReader;
  /** No manager can receive the issue: the caller blocks it with a Board action, as stranded work is today. */
  blockForBoard?: (input: { issueId: string; runId: string; comment: string }) => Promise<unknown>;
  /** The hand-over was due and was not made: never without a word. */
  onNotHanded?: (input: { issueId: string; freshRunId: string; reason: string }) => void;
  onError?: (error: unknown) => void;
}

/**
 * `held`: due, but a run or a lease on the issue still holds it; to ask again when a run on the issue ends.
 * `left`: due, and not made for a reason that will not change by itself (the reason is given to `onNotHanded`).
 */
export type RelaunchLoopHandoverOutcome = "none" | "handed" | "blocked_for_board" | "held" | "left";

const HANDOVER_REFUSALS_FOR_THE_BOARD: readonly string[] = Object.freeze(["no_manager", "manager_not_invokable", "handed_before"]);

/**
 * The run the guard started on a fresh session failed empty too: hand the issue
 * to the role's direct manager. Called when that run ends. It reads the runs
 * and writes nothing of its own: the hand-over refuses a run that already
 * caused one, so asking twice hands once. It never fails its caller.
 */
export async function handOverAfterFreshSessionFailure(
  db: Db,
  deps: RelaunchLoopHandoverDeps,
  input: { companyId: string; agent: { id: string; name: string }; issueId: string | null; exceptRunId?: string | null; heldBefore?: boolean;
    /** The run at whose end this is asked: its lease is released by that end. */
    endedRunId?: string | null },
): Promise<RelaunchLoopHandoverOutcome> {
  if (!input.issueId) return "none";
  try {
    const runs = await readStartedRuns(db, {
      companyId: input.companyId,
      agentId: input.agent.id,
      issueId: input.issueId,
      exceptRunId: input.exceptRunId ?? null,
      readRunLog: deps.readRunLog,
    });
    const candidateIds = runs
      .filter((run) => classifyRelaunchLoopRun(run, false) === "empty_failure")
      .map((run) => run.id);
    const runIdsThatProducedSomething = await readRunIdsThatProducedSomething(db, { companyId: input.companyId, runIds: candidateIds });
    const decision = evaluateRelaunchLoopHandover({ runs, runIdsThatProducedSomething, heldBefore: input.heldBefore });
    if (!decision.handover) return "none";
    const run = decision.freshRun;
    const said = { agentName: input.agent.name, failedRunCount: run.guardFailedRunCount ?? RELAUNCH_LOOP_FAILURE_THRESHOLD, code: run.errorCode };
    const result = await handIssueToManager(db, { enqueueWakeup: deps.enqueueWakeup }, {
      issue: { id: input.issueId, companyId: input.companyId },
      fromAgentId: input.agent.id,
      cause: RELAUNCH_LOOP_HANDOVER_CAUSE,
      code: run.errorCode,
      sourceRun: { id: run.id, status: run.status, agentId: input.agent.id },
      note: relaunchLoopHandoverNote(said),
      // The role's own retry in the queue and the manager's own run are the normal state after a failure.
      doesNotHold: { queuedRunsOfTheRole: true, runsOfTheManager: true, leaseOfRunId: input.endedRunId ?? null },
    });
    if (result.handed) return "handed";
    if (HANDOVER_REFUSALS_FOR_THE_BOARD.includes(result.reason) && deps.blockForBoard) {
      await deps.blockForBoard({ issueId: input.issueId, runId: run.id, comment: relaunchLoopBoardBlockBody(said) });
      return "blocked_for_board";
    }
    // The same run asked twice, or an issue that left the role or its work meanwhile: nothing is due any more.
    if (["run_already_handed", "assignee_changed", "issue_not_at_work", "issue_not_found"].includes(result.reason)) return "none";
    deps.onNotHanded?.({ issueId: input.issueId, freshRunId: run.id, reason: result.reason });
    return result.reason === "still_held" ? "held" : "left";
  } catch (error) {
    deps.onError?.(error);
    return "none";
  }
}

export interface RelaunchLoopGuardDeps {
  clearTaskSessions: (
    companyId: string,
    agentId: string,
    opts?: { taskKey?: string | null; adapterType?: string | null },
  ) => Promise<unknown>;
  onDecision?: (decision: Extract<RelaunchLoopDecision, { action: "fresh_session" }>) => Promise<unknown>;
  onError?: (error: unknown) => void;
  /** The run log store's reader; without it a late log chunk counts as the engine's. */
  readRunLog?: RelaunchLoopRunLogReader;
}

/**
 * Called once per run, before its session is chosen. On a series it posts the
 * note, drops the kept session of the agent for the issue, and marks the run
 * and its `context` so the session preparation starts fresh. Order: the note
 * first, the mark last, so a cut between two writes is repaired by the next
 * run, which reads the same series and finds the note already there.
 *
 * It never fails the run: an error here is reported and the run goes on as it
 * would have without the guard.
 */
export async function applyRelaunchLoopGuard(
  db: Db,
  deps: RelaunchLoopGuardDeps,
  input: {
    run: { id: string; companyId: string };
    agent: { id: string; companyId: string; name: string; adapterType: string | null };
    issueId: string | null;
    taskKey: string | null;
    context: Record<string, unknown>;
  },
): Promise<RelaunchLoopDecision> {
  if (!input.issueId) return { action: "none", streak: 0 };
  try {
    const decision = await readRelaunchLoopDecision(db, {
      companyId: input.agent.companyId,
      agentId: input.agent.id,
      issueId: input.issueId,
      runId: input.run.id,
      readRunLog: deps.readRunLog,
    });
    if (decision.action !== "fresh_session") return decision;

    await ensureFreshSessionNote(db, {
      companyId: input.agent.companyId,
      issueId: input.issueId,
      agent: input.agent,
      runId: input.run.id,
      decision,
    });
    if (input.taskKey) {
      await deps.clearTaskSessions(input.agent.companyId, input.agent.id, {
        taskKey: input.taskKey,
        adapterType: input.agent.adapterType,
      });
    }
    const mark = {
      version: 1,
      action: "fresh_session",
      droppedSessionId: decision.sessionId,
      failedRunIds: decision.failedRuns.map((run) => run.id),
      errorCodes: decision.failedRuns.map((run) => run.errorCode),
    };
    // A person's or a continuation's explicit resume names a session too: it is
    // removed with the kept one, or the dropped session would come back by it.
    await db
      .update(heartbeatRuns)
      .set({
        sessionIdBefore: null,
        contextSnapshot: sql`(coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) - 'resumeSessionParams' - 'resumeSessionDisplayId') || ${JSON.stringify({
          forceFreshSession: true,
          [RELAUNCH_LOOP_GUARD_CONTEXT_KEY]: mark,
        })}::jsonb`,
      })
      .where(and(eq(heartbeatRuns.id, input.run.id), eq(heartbeatRuns.companyId, input.agent.companyId)));
    delete input.context.resumeSessionParams;
    delete input.context.resumeSessionDisplayId;
    input.context.forceFreshSession = true;
    input.context[RELAUNCH_LOOP_GUARD_CONTEXT_KEY] = mark;
    await deps.onDecision?.(decision);
    return decision;
  } catch (error) {
    deps.onError?.(error);
    return { action: "none", streak: 0 };
  }
}
