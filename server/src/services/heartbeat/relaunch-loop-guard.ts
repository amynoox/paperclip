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
// - declared waits, refusals the worker router returns before any reservation,
//   cancellations, and runs that failed in setup before their adapter was
//   admitted (a lease that could not be acquired) are neither counted nor do
//   they end the series: none of them says anything about the session;
// - runs of other agents are not read at all, so another role's run or comment
//   between two failures does not end the series;
// - any other run of the agent (a success, a failure that left something
//   behind, a long failure, a failure on another session) ends it;
// - at RELAUNCH_LOOP_FAILURE_THRESHOLD, the run about to start drops the
//   session and starts on a fresh one, with one note on the issue.
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
import { keyValueRow, runLinkRow, systemNoticePresentation } from "../recovery/notice-format.js";

/** Consecutive empty failures on one session before the session is dropped. */
export const RELAUNCH_LOOP_FAILURE_THRESHOLD = 3;

/** A failure counts only when the run lasted less than this. */
export const RELAUNCH_LOOP_SHORT_RUN_MS = 5 * 60_000;

/** How many started runs of the agent on the issue are read, newest first. */
export const RELAUNCH_LOOP_RUN_SAMPLE_LIMIT = 40;

export const RELAUNCH_LOOP_GUARD_CONTEXT_KEY = "relaunchLoopGuard";

export const RELAUNCH_LOOP_FRESH_SESSION_ACTIVITY_ACTION = "issue.relaunch_loop_fresh_session";

// Refusals the worker router returns before it reserves any machine: no engine
// was launched, so the session was not tried. The first four are STUDIO-0059's;
// the others are the router's remaining pre-reservation refusals.
export const ROUTER_PRE_RESERVATION_REFUSAL_CODES: readonly string[] = Object.freeze([
  ...ROUTER_REFUSAL_ERROR_CODES,
  "router_request_block_invalid",
  "router_request_system_unknown",
  "router_attempt_already_used",
  "router_ticket_already_completed",
  "router_reservation_released",
  "router_reservation_unavailable",
  "router_stale_reservation_wake",
  "router_ticket_not_assigned_to_agent",
]);

export interface RelaunchLoopRunSample {
  id: string;
  status: string;
  errorCode: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** The engine session the run resumed; null when it started a fresh one. */
  sessionIdBefore: string | null;
  /**
   * The run failed in setup, before its adapter was admitted: a legacy run
   * still at stage `preparing` (the controller writes `dispatching` in the
   * lease renewal that admits the adapter). The adapter's own
   * `providerWorkStarted: false` is not used: the worker router declares it on
   * failures of a launched engine too, and those are the ones to count.
   */
  engineNeverStarted: boolean;
}

export type RelaunchLoopRunClass = "skipped" | "empty_failure" | "other";

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
  if (run.engineNeverStarted) return "skipped";
  if (!run.finishedAt) return "other";
  if (run.finishedAt.getTime() - run.startedAt.getTime() >= RELAUNCH_LOOP_SHORT_RUN_MS) return "other";
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

export function relaunchLoopFreshSessionNoteBody(input: {
  agentName: string;
  failedRuns: readonly Pick<RelaunchLoopRunSample, "errorCode">[];
}): string {
  const codes = [...new Set(input.failedRuns.map((run) => run.errorCode ?? "no code"))]
    .map((code) => `\`${code}\``)
    .join(", ");
  const minutes = RELAUNCH_LOOP_SHORT_RUN_MS / 60_000;
  return (
    `The last ${input.failedRuns.length} runs of ${input.agentName} on this issue failed one after the other ` +
    `while resuming the same engine session, each in under ${minutes} minutes and without leaving anything behind (${codes}). ` +
    "That session is dropped: the next run starts on a fresh session."
  );
}

async function readStartedRuns(
  db: Db,
  input: { companyId: string; agentId: string; issueId: string; exceptRunId: string },
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
    })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId),
      sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`,
      isNotNull(heartbeatRuns.startedAt),
      ne(heartbeatRuns.id, input.exceptRunId),
    ))
    .orderBy(desc(heartbeatRuns.startedAt), desc(heartbeatRuns.id))
    .limit(RELAUNCH_LOOP_RUN_SAMPLE_LIMIT);
  return rows.map((row) => ({ ...row, engineNeverStarted: row.engineNeverStarted === true }));
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
  input: { companyId: string; agentId: string; issueId: string; runId: string },
): Promise<RelaunchLoopDecision> {
  const runs = await readStartedRuns(db, {
    companyId: input.companyId,
    agentId: input.agentId,
    issueId: input.issueId,
    exceptRunId: input.runId,
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

export interface RelaunchLoopGuardDeps {
  clearTaskSessions: (
    companyId: string,
    agentId: string,
    opts?: { taskKey?: string | null; adapterType?: string | null },
  ) => Promise<unknown>;
  onDecision?: (decision: Extract<RelaunchLoopDecision, { action: "fresh_session" }>) => Promise<unknown>;
  onError?: (error: unknown) => void;
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
