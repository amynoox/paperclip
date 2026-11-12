import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, agentWakeupRequests, heartbeatRuns, heartbeatRunEvents, issueComments, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import type { AdapterTaskInteractionWait } from "@paperclipai/adapter-utils";
import { isUuidLike } from "@paperclipai/shared";
import { getServerAdapter } from "../adapters/index.js";
import { parseObject } from "../adapters/utils.js";
import { notifyDeferredExecutionWork } from "./deferred-execution-notifications.js";
import { executionStartedEventPredicate } from "./pre-dispatch-execution-evidence.js";
import { notifyExecutionRunWork } from "./execution-control-notifications.js";
import { notifyChatRunMilestones } from "./chat-run-milestone-notifications.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export const ADAPTER_INTERACTION_WAIT = "adapter_interaction_pending";
export const ADAPTER_INTERACTION_WAIT_KEY = "adapterInteractionWait";
type Run = typeof heartbeatRuns.$inferSelect;

export function checkedAdapterInteractionWait(value: unknown): AdapterTaskInteractionWait | null {
  if (value == null) return null;
  const v = parseObject(value);
  if (v.kind !== "pending_interaction" || !Array.isArray(v.blockers) || v.blockers.length > 128 ||
      v.blockers.some(b => typeof parseObject(b).issueId !== "string" || typeof parseObject(b).interactionId !== "string" ||
        !isUuidLike(String(parseObject(b).issueId)) || !isUuidLike(String(parseObject(b).interactionId))))
    throw new Error("adapter_task_admission_invalid");
  return { kind: "pending_interaction", blockers: v.blockers as AdapterTaskInteractionWait["blockers"] };
}

/** Only a trusted installed adapter may restrict admission. No global pending
 * card policy is introduced: native responders and unconfigured adapters retain
 * their paths. A clear result never bypasses any native execution gate. */
export async function readAdapterTaskWait(db: Db, input: {
  companyId: string; agentId: string; issueId: string; context: Record<string, unknown>;
}, requireContract = false) {
  const [issue] = await db.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)));
  if (issue?.assigneeAgentId !== input.agentId) {
    if (requireContract) throw new Error("adapter_task_wait_owner_changed");
    return null;
  }
  const [agent] = await db.select().from(agents)
    .where(and(eq(agents.companyId, input.companyId), eq(agents.id, input.agentId)));
  if (!agent) {
    if (requireContract) throw new Error("adapter_task_wait_agent_missing");
    return null;
  }
  const hook = getServerAdapter(agent.adapterType).getTaskAdmission;
  if (!hook) {
    if (requireContract) throw new Error("adapter_task_admission_unavailable");
    return null;
  }
  // Admission happens before the normal provider prompt is materialized. Build
  // comment attribution from stored native data here too, never caller prose.
  const context = { ...input.context };
  delete context.paperclipWakeComment;
  delete context.paperclipWake;
  const commentId = context.commentId;
  if (["issue.comment", "issue.comment.reopen"].includes(String(context.source)) &&
      typeof commentId === "string" && isUuidLike(commentId)) {
    const [comment] = await db.select().from(issueComments).where(and(
      eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId), eq(issueComments.id, commentId)));
    if (comment) {
      const { body: _body, ...attribution } = comment;
      context.paperclipWakeComment = attribution;
      context.paperclipWake = { comments: [{ ...attribution, createdAt: comment.createdAt.toISOString(),
        author: { type: comment.authorType, id: comment.authorUserId ?? comment.authorAgentId } }] };
    }
  }
  const wait = checkedAdapterInteractionWait(await hook({ ...input, context,
    defaultEnvironmentId: agent.defaultEnvironmentId, config: parseObject(agent.adapterConfig) }));
  if (!wait?.blockers.length) return null;
  // Adapter output is only a hint. Require current, native, company-scoped
  // pending cards; a stale hint cannot manufacture an indefinite wait.
  const rows = await db.select({ id: issueThreadInteractions.id, issueId: issueThreadInteractions.issueId })
    .from(issueThreadInteractions).where(and(eq(issueThreadInteractions.companyId, input.companyId),
      eq(issueThreadInteractions.status, "pending"), inArray(issueThreadInteractions.id, wait.blockers.map(b => b.interactionId))));
  const blockers = wait.blockers.filter(b => rows.some(r => r.id === b.interactionId && r.issueId === b.issueId));
  return blockers.length ? { kind: "pending_interaction" as const, blockers } : null;
}

export function adapterWaitPayload(payload: unknown, context: Record<string, unknown>, wait: AdapterTaskInteractionWait) {
  return { ...parseObject(payload), issueId: context.issueId, _paperclipWakeContext: context,
    [ADAPTER_INTERACTION_WAIT_KEY]: { version: 1, ...wait },
    executionWait: { reason: ADAPTER_INTERACTION_WAIT,
      message: "Waiting for the required task interactions. Saved input has not been delivered.",
      interactionIds: wait.blockers.map(b => b.interactionId) } };
}

/** Cancel only an attempt proven not to have reached a provider. Move its
 * original receipt (and coalesced receipts) back to the native durable queue.
 * Caller owns issue then run locks. No plugin reservation is released here. */
export async function deferAdapterRunInTransaction(db: Db, run: Run, issueId: string,
  wait: AdapterTaskInteractionWait, preProvider = false) {
  if (run.runtimeMode === "native" || !run.wakeupRequestId ||
      !["queued", ...(preProvider ? ["running"] : [])].includes(run.status) ||
      run.processPid || run.processGroupId || run.processStartedAt || run.sessionIdAfter ||
      run.resultJson?.cancellation || run.resultJson?.startupCancellation) return false;
  const started = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id), executionStartedEventPredicate())).limit(1);
  if (started.length) return false;
  const receipts = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.agentId, run.agentId),
    eq(agentWakeupRequests.runId, run.id), inArray(agentWakeupRequests.status, ["queued", "claimed", "coalesced"]))).for("update");
  if (!receipts.some(r => r.id === run.wakeupRequestId)) return false;
  // Older/malformed receipts without their own provenance stay with the
  // original attempt. A merged context cannot reconstruct another input's
  // author, source or interaction authority safely.
  if (receipts.some(r => parseObject(r.payload?._paperclipWakeContext).issueId !== issueId)) return false;
  const now = new Date();
  const [cancelled] = await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: now, updatedAt: now,
    costAccountingPending: true,
    usageJson: { ...parseObject(run.usageJson), accountingProviderWorkStarted: false },
    errorCode: ADAPTER_INTERACTION_WAIT, error: "Waiting for required task interactions; input is saved.",
    resultJson: { ...parseObject(run.resultJson), stopReason: ADAPTER_INTERACTION_WAIT,
      adapterInteractionWait: { version: 1, ...wait },
      cancellation: { source: "control_plane", expected: true, initiator: { type: "system" },
        reason: "Required task interactions are pending", recordedAt: now.toISOString() },
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } })
    .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.status, run.status)))
    .returning({ id: heartbeatRuns.id });
  if (!cancelled) return false;
  await notifyExecutionRunWork(db, { companyId: run.companyId, agentId: run.agentId, runId: run.id, issueId });
  await notifyChatRunMilestones(db, { companyId: run.companyId, runId: run.id, issueId });
  await notifyDeliveryWork(db, DELIVERY_QUEUES.accounting);
  for (const receipt of receipts) {
    // Keep each receipt's actor, input, idempotency key and own context. The
    // merged run context is not another comment author's authority.
    const context = parseObject(receipt.payload?._paperclipWakeContext);
    await db.update(agentWakeupRequests).set({ status: "deferred_issue_execution", runId: null,
      claimedAt: null, finishedAt: null, error: null, updatedAt: now,
      payload: { ...adapterWaitPayload(receipt.payload, context, wait),
        adapterInteractionWait: { version: 1, ...wait, preparationRunId: run.id } } })
      .where(eq(agentWakeupRequests.id, receipt.id));
    await notifyDeferredExecutionWork(db, { companyId: run.companyId, requestId: receipt.id });
  }
  await db.update(issues).set({ executionRunId: null, executionAgentNameKey: null, executionLockedAt: null, updatedAt: now })
    .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId), eq(issues.executionRunId, run.id)));
  return true;
}

export async function deferAdapterRun(db: Db, run: Run, wait: AdapterTaskInteractionWait, preProvider = false) {
  const issueId = parseObject(run.contextSnapshot).issueId;
  if (typeof issueId !== "string" || !isUuidLike(issueId)) return false;
  return db.transaction(async tx => {
    await tx.execute(sql`select id from issues where company_id = ${run.companyId} and id = ${issueId} for update`);
    const [current] = await tx.select().from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId))).for("update");
    if (!current) return false;
    return deferAdapterRunInTransaction(tx as unknown as Db, current, issueId, wait, preProvider);
  });
}
