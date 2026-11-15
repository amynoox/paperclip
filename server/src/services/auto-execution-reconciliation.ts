import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import type { ExecutionReconciliation } from "@paperclipai/shared";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { markExecutionReconciliation, validateExecutionReconciliation } from "./execution-recovery-resolution.js";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";
import { issueService } from "./issues.js";
import { LEGACY_RECOVERY_CAUSE } from "./legacy-execution-recovery.js";
import { logger } from "../middleware/logger.js";

// STUDIO-0050 (owner decision V321, 15 Nov 2026): a legacy run that the Board
// cancelled leaves a "preserve without replay" hold that only an operator could
// lift, by stating the run's action outcomes. Four times on 14 Nov an operator
// did so with the same facts the server already holds. When every guard below is
// proven by the server's own records, the server records that reconciliation
// itself, with the conservative outcome "mixed" (some actions may be done: the
// agent re-checks before redoing anything) and a factual evidence text. Any other
// case is left exactly as before: the hold stays, visible, for an operator.

export const AUTO_RECONCILIATION_ACTOR_ID = "system:auto-reconciliation";
const MAX_HOLD_AGE_MS = 24 * 60 * 60 * 1000;

/** Every guard the database can prove, as one predicate over action, run and task. */
function provableBoardCutHold(now: Date) {
  const oldest = new Date(now.getTime() - MAX_HOLD_AGE_MS).toISOString();
  return and(
    eq(issueRecoveryActions.cause, LEGACY_RECOVERY_CAUSE),
    eq(issueRecoveryActions.status, "resolved"),
    sql`${issueRecoveryActions.evidence} -> 'automaticRecovery' ->> 'replay' = 'blocked'`,
    sql`${issueRecoveryActions.evidence} -> 'automaticRecovery' ->> 'policy' = 'preserve_without_replay_v1'`,
    sql`${issueRecoveryActions.fingerprint} = 'legacy-execution:' || ${heartbeatRuns.id}::text`,
    sql`${issueRecoveryActions.evidence} ->> 'runId' = ${heartbeatRuns.id}::text`,
    sql`not (${issueRecoveryActions.evidence} ?| array['executionReconciliation', 'workspaceRestoreFailure', 'workspaceRestoreRecovery', 'systemRecovery'])`,
    sql`${issueRecoveryActions.updatedAt} > ${oldest}::timestamptz`,
    // The run: legacy, cancelled by a Board operator, no retained workspace.
    eq(heartbeatRuns.companyId, issueRecoveryActions.companyId),
    eq(heartbeatRuns.runtimeMode, "legacy"),
    eq(heartbeatRuns.status, "cancelled"),
    sql`${heartbeatRuns.resultJson} -> 'cancellation' ->> 'source' = 'operator'`,
    sql`${heartbeatRuns.resultJson} -> 'cancellation' -> 'initiator' ->> 'type' = 'user'`,
    sql`${heartbeatRuns.resultJson} -> 'cancellation' ->> 'expected' = 'true'`,
    sql`not (coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ?| array['workspaceRestoreFailure', 'workspaceRestoreRecovery'])`,
    sql`coalesce(${heartbeatRuns.contextSnapshot} ->> 'issueId', ${heartbeatRuns.issueId}::text) = ${issues.id}::text`,
    // The task: blocked or todo, assigned to the run's agent only, nothing running on it.
    eq(issues.id, issueRecoveryActions.sourceIssueId),
    eq(issues.companyId, issueRecoveryActions.companyId),
    sql`${issues.status} in ('blocked', 'todo')`,
    sql`${issues.assigneeAgentId} = ${heartbeatRuns.agentId}`,
    sql`${issues.assigneeUserId} is null`,
    sql`${issues.executionRunId} is null`,
    sql`${issues.checkoutRunId} is null`,
    sql`not exists (select 1 from heartbeat_runs live_run
      where live_run.company_id = ${issues.companyId} and live_run.id <> ${heartbeatRuns.id}
        and (live_run.issue_id = ${issues.id} or live_run.native_issue_id = ${issues.id}
          or live_run.context_snapshot ->> 'issueId' = ${issues.id}::text)
        and live_run.status in ('queued', 'running', 'scheduled_retry'))`,
    sql`not exists (select 1 from issue_recovery_actions other_action
      where other_action.company_id = ${issues.companyId} and other_action.source_issue_id = ${issues.id}
        and other_action.status in ('active', 'escalated'))`,
    // A restricted chat retry stays the chat's own delivery (operator path).
    sql`not exists (select 1 from chat_conversations conversation join chat_endpoints endpoint
        on endpoint.id = conversation.endpoint_id
      where endpoint.external_execution_policy = 'restricted'
        and conversation.company_id = ${issues.companyId} and conversation.issue_id = ${issues.id})`,
  );
}

async function listCandidates(db: Db, now: Date, limit: number) {
  return db.select({ actionId: issueRecoveryActions.id, issueId: issues.id, companyId: issues.companyId, runId: heartbeatRuns.id })
    .from(issueRecoveryActions)
    .innerJoin(issues, eq(issues.id, issueRecoveryActions.sourceIssueId))
    .innerJoin(heartbeatRuns, sql`${heartbeatRuns.id}::text = ${issueRecoveryActions.evidence} ->> 'runId'`)
    .where(provableBoardCutHold(now))
    .orderBy(issueRecoveryActions.updatedAt)
    .limit(limit);
}

export async function hasAutoReconcilableBoardCutHold(db: Db, now = new Date()) {
  return (await listCandidates(db, now, 1)).length > 0;
}

function evidenceText(run: typeof heartbeatRuns.$inferSelect) {
  const cancellation = (run.resultJson?.cancellation ?? {}) as { recordedAt?: unknown };
  const at = typeof cancellation.recordedAt === "string" ? cancellation.recordedAt : run.finishedAt?.toISOString() ?? "unknown time";
  return [
    `Automatic reconciliation by the server: run ${run.id} was cancelled by a Board operator at ${at}.`,
    "Its local process is gone, every environment lease it held has been released and no coordinator holds it.",
    "No action outcome of the cut run is established: some actions may have been done. Re-check the current state (branches, pull requests, builds, comments) before redoing anything.",
  ].join(" ");
}

/** Reconcile one candidate; false leaves the hold untouched (retried later while it qualifies). */
async function reconcileOne(db: Db, candidate: { actionId: string; issueId: string; companyId: string; runId: string }, now: Date) {
  const publications: ActivityPublication[] = [];
  const outcome = await db.transaction(async tx => {
    const txDb = tx as unknown as Db;
    await tx.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.id, candidate.issueId), eq(issues.companyId, candidate.companyId))).for("update");
    const [row] = await tx.select({ action: issueRecoveryActions, run: heartbeatRuns, issue: issues })
      .from(issueRecoveryActions)
      .innerJoin(issues, eq(issues.id, issueRecoveryActions.sourceIssueId))
      .innerJoin(heartbeatRuns, sql`${heartbeatRuns.id}::text = ${issueRecoveryActions.evidence} ->> 'runId'`)
      .where(and(eq(issueRecoveryActions.id, candidate.actionId), provableBoardCutHold(now)))
      .for("update", { of: issueRecoveryActions });
    if (!row) return null;
    const { action, run, issue } = row;
    const openBlockers = (await issueService(txDb).getDependencyReadiness(issue.id, tx)).unresolvedBlockerCount > 0;
    if (issue.status === "todo" && openBlockers) return null;
    if (issue.status === "blocked" && !openBlockers) {
      // Back to todo only when this exact hold is what blocks the task.
      const blocker = await getExecutionBlocker(txDb, issue.companyId, issue.id);
      if (blocker?.recoveryActionId !== action.id || blocker.runId !== run.id) return null;
    }
    const decision: ExecutionReconciliation = {
      runId: run.id, providerStopped: true, actionOutcome: "mixed", outcomeEvidence: evidenceText(run),
    };
    // Same validation as the Board route: run terminal and owned, process gone,
    // no coordinator or successor, every environment lease released.
    await validateExecutionReconciliation({ db: txDb, companyId: issue.companyId, issueId: issue.id,
      agentId: issue.assigneeAgentId, sourceRunId: run.id, decision });
    const [reopened] = await tx.update(issueRecoveryActions).set({ status: "active", outcome: null, resolvedAt: null })
      .where(eq(issueRecoveryActions.id, action.id)).returning();
    await markExecutionReconciliation(txDb, reopened!, decision, AUTO_RECONCILIATION_ACTOR_ID, undefined,
      openBlockers ? { dependencyBlockedOnly: true } : undefined);
    if (issue.status === "blocked" && !openBlockers) {
      await issueService(txDb).update(issue.id, { status: "todo", actorAgentId: null, actorUserId: null }, tx, publications);
    }
    const resolved = await issueRecoveryActionService(txDb).resolveActiveForIssue({
      companyId: issue.companyId, sourceIssueId: issue.id, actionId: action.id, status: "resolved", outcome: "restored",
      resolutionNote: "Reconciled automatically by the server: the run was cancelled by a Board operator and every provable guard held.",
    }, tx);
    if (!resolved) throw new Error("auto reconciliation lost its recovery action");
    await logActivity(txDb, {
      companyId: issue.companyId, actorType: "system", actorId: AUTO_RECONCILIATION_ACTOR_ID, agentId: null, runId: null,
      action: "issue.execution_auto_reconciled", entityType: "issue", entityId: issue.id,
      details: {
        identifier: issue.identifier, recoveryActionId: action.id, runId: run.id, agentId: run.agentId,
        actionOutcome: "mixed", previousStatus: issue.status,
        path: openBlockers ? "dependency_blocked" : "continuation",
        proofs: ["cancelled_by_board_operator", "legacy_runtime", "no_retained_workspace", "assignee_is_run_agent",
          "no_live_run_or_run_lock", "no_other_active_recovery", "no_restricted_chat", "local_process_gone",
          "environment_leases_released", "no_coordinator_or_successor"],
      },
    }, publications);
    return true;
  });
  for (const publication of publications) publishActivity(publication);
  return outcome === true;
}

/**
 * Runs in the execution-continuation queue, before delivery: a reconciled hold
 * on a task without open blockers is then delivered as one continuation run
 * (forceFreshSession, key execution-reconciliation:<action>), exactly as after a
 * Board reconciliation; with open blockers the dependency wake starts it later.
 */
export async function autoReconcileBoardCutRuns(db: Db, now = new Date()) {
  let reconciled = 0;
  for (const candidate of await listCandidates(db, now, 20)) {
    try {
      if (await reconcileOne(db, candidate, now)) reconciled += 1;
    } catch (err) {
      // A guard that only the validation can check (process, lease, coordinator)
      // is not yet true: the hold stays and a later pass tries again.
      logger.info({ err, issueId: candidate.issueId, runId: candidate.runId }, "board-cut run not reconciled automatically yet");
    }
  }
  return { reconciled };
}
