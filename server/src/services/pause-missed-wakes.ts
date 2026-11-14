import { and, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { AGENT_LIFECYCLE_STOP_REASON, AGENT_PAUSE_STOP_REASON, BUDGET_PAUSE_STOP_REASON } from "./governance-pause-stop.js";
import { issueThreadInteractionAttentionAgentAllowed } from "./issue-thread-interaction-resolution.js";

/**
 * STUDIO-0028: wakes lost to an agent pause.
 *
 * A pause saves a person's comment and replays it when the pause lifts. Two
 * other kinds of wake were lost:
 * - a wake sent while the agent was paused is recorded as `skipped` with
 *   reason `agent.not_invokable` and never replayed (13 Nov 2026: the Quality
 *   Manager missed three wakes on TR-29 during the 19:20-20:08 pause);
 * - a wake already waiting when the pause started (`queued`, or
 *   `deferred_issue_execution` behind another agent's run) is cancelled by the
 *   pause stop, never started, and never replayed (14 Nov 2026, 00:28:23: the
 *   Quality Manager's wake for a question card the Game Tester addressed to it
 *   on TR-699, deferred behind the tester's run, cancelled at 00:28:51 by the
 *   pause; the card was still pending after the resume).
 *
 * When the agent becomes ready again, wake it once per task where such a wake
 * was lost and nothing has happened since: the task is still the agent's, or
 * the lost wake was for a card that is still pending and addressed to the
 * agent. No wake when the agent already ran on that task after the loss, or
 * when a wake of the agent for that task is still live. The idempotency key
 * names the lost wake, so a repeated resume or a concurrent caller never
 * doubles the wake.
 *
 * STUDIO-0038: a card may now be addressed to a paused agent. Its wake is
 * refused like any other, but the queue keeps no row when the refused request
 * came from a person (the route creating the card answers 201 and only logs
 * the refusal), and a plugin-created card may have no wake at all. So a card
 * still pending and addressed to the agent, with no wake recorded for it,
 * counts as a lost card wake from the moment it was created.
 *
 * Not covered: a wake that was never requested (no row), for example a task
 * whose recovery settled as blocked; there is nothing to replay.
 */
export const PAUSE_MISSED_WAKE_REASON = "issue_wakes_missed_during_pause";
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const NOT_INVOKABLE_REASONS = ["agent.not_invokable"];
const PAUSE_STOP_ERRORS = [AGENT_LIFECYCLE_STOP_REASON, AGENT_PAUSE_STOP_REASON, BUDGET_PAUSE_STOP_REASON];
const LIVE_WAKE_STATUSES = ["queued", "deferred_issue_execution", "claimed"];
const UUID = /^[0-9a-f-]{36}$/i;

type Wakeup = (agentId: string, opts: {
  source: "automation";
  triggerDetail: "system";
  reason: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  requestedByActorType: "system";
  requestedByActorId: string;
  contextSnapshot: Record<string, unknown>;
}) => Promise<unknown>;

// `id` is the lost wake request; null for a card whose wake was never recorded.
type Missed = { id: string | null; finishedAt: Date; interactionId: string | null };

export async function replayWakesMissedDuringPause(db: Db, input: {
  companyId: string;
  agentId: string;
  wakeup: Wakeup;
  now?: Date;
}): Promise<{ issues: number; woken: number }> {
  const since = new Date((input.now ?? new Date()).getTime() - LOOKBACK_MS);
  const lost = await db.select({
    id: agentWakeupRequests.id,
    issueId: sql<string | null>`${agentWakeupRequests.payload}->>'issueId'`,
    interactionId: sql<string | null>`${agentWakeupRequests.payload}->>'interactionId'`,
    finishedAt: agentWakeupRequests.finishedAt,
  }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId),
    eq(agentWakeupRequests.agentId, input.agentId),
    or(
      and(eq(agentWakeupRequests.status, "skipped"), inArray(agentWakeupRequests.reason, NOT_INVOKABLE_REASONS)),
      // Cancelled by a pause stop before it ever started a run.
      and(eq(agentWakeupRequests.status, "cancelled"), inArray(agentWakeupRequests.error, PAUSE_STOP_ERRORS),
        isNull(agentWakeupRequests.runId)),
    ),
    isNotNull(agentWakeupRequests.finishedAt),
    gt(agentWakeupRequests.finishedAt, since),
  )).orderBy(desc(agentWakeupRequests.finishedAt));

  // Per task: the latest lost wake, and the latest one that was for a card.
  const latest = new Map<string, Missed>();
  const latestCard = new Map<string, Missed>();
  for (const row of lost) {
    if (!row.issueId || !UUID.test(row.issueId)) continue;
    const missed = { id: row.id, finishedAt: row.finishedAt!, interactionId: row.interactionId && UUID.test(row.interactionId) ? row.interactionId : null };
    if (!latest.has(row.issueId)) latest.set(row.issueId, missed);
    if (missed.interactionId && !latestCard.has(row.issueId)) latestCard.set(row.issueId, missed);
  }

  // Pending cards addressed to the agent with no wake recorded for them (STUDIO-0038).
  const cards = await db.select({
    id: issueThreadInteractions.id,
    issueId: issueThreadInteractions.issueId,
    createdAt: issueThreadInteractions.createdAt,
    createdByAgentId: issueThreadInteractions.createdByAgentId,
    createdByUserId: issueThreadInteractions.createdByUserId,
    sourceRunId: issueThreadInteractions.sourceRunId,
    addresseeAgentId: issueThreadInteractions.addresseeAgentId,
    addresseeUserId: issueThreadInteractions.addresseeUserId,
    effectiveResolverPolicy: issueThreadInteractions.effectiveResolverPolicy,
    effectiveResolverPolicySource: issueThreadInteractions.effectiveResolverPolicySource,
    resolverPolicyProvenance: issueThreadInteractions.resolverPolicyProvenance,
  }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, input.companyId),
    eq(issueThreadInteractions.addresseeAgentId, input.agentId),
    eq(issueThreadInteractions.status, "pending"),
    gt(issueThreadInteractions.createdAt, since),
  )).orderBy(desc(issueThreadInteractions.createdAt));
  if (cards.length > 0) {
    const recorded = new Set((await db.select({
      interactionId: sql<string | null>`${agentWakeupRequests.payload}->>'interactionId'`,
    }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, input.companyId),
      eq(agentWakeupRequests.agentId, input.agentId),
      inArray(sql`${agentWakeupRequests.payload}->>'interactionId'`, cards.map(card => card.id)),
    ))).map(row => row.interactionId));
    for (const card of cards) {
      // Same attention rule as the wake sent when the card is created.
      if (recorded.has(card.id) || !issueThreadInteractionAttentionAgentAllowed({ agentId: input.agentId, interaction: card })) continue;
      const missed = { id: null, finishedAt: card.createdAt, interactionId: card.id };
      const known = latest.get(card.issueId);
      if (!known || known.finishedAt < card.createdAt) latest.set(card.issueId, missed);
      const knownCard = latestCard.get(card.issueId);
      if (!knownCard || knownCard.finishedAt < card.createdAt) latestCard.set(card.issueId, missed);
    }
  }

  let woken = 0;
  for (const [issueId, last] of latest) {
    const [issue] = await db.select({ id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId })
      .from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, issueId))).limit(1);
    if (!issue || ["done", "cancelled", "backlog"].includes(issue.status)) continue;
    let missed: Missed | null = issue.assigneeAgentId === input.agentId ? last : null;
    let interactionId: string | null = null;
    let interactionKind: string | null = null;
    if (!missed) {
      // Not the agent's task: replay only the wake of a card still pending and addressed to the agent.
      const card = latestCard.get(issueId);
      if (!card) continue;
      const [pending] = await db.select({ id: issueThreadInteractions.id, kind: issueThreadInteractions.kind }).from(issueThreadInteractions).where(and(
        eq(issueThreadInteractions.companyId, input.companyId),
        eq(issueThreadInteractions.issueId, issueId),
        eq(issueThreadInteractions.id, card.interactionId!),
        eq(issueThreadInteractions.status, "pending"),
        eq(issueThreadInteractions.addresseeAgentId, input.agentId),
      )).limit(1);
      if (!pending) continue;
      missed = card;
      interactionId = card.interactionId;
      interactionKind = pending.kind;
    }
    const [later] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
      gt(heartbeatRuns.createdAt, missed.finishedAt),
    )).limit(1);
    if (later) continue;
    const [live] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, input.companyId),
      eq(agentWakeupRequests.agentId, input.agentId),
      inArray(agentWakeupRequests.status, LIVE_WAKE_STATUSES),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
    )).limit(1);
    if (live) continue;
    try {
      await input.wakeup(input.agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: PAUSE_MISSED_WAKE_REASON,
        // STUDIO-0038: a card wake keeps the shape of the wake sent when the card
        // was created. The run context keeps the card only for an `interaction`
        // mutation, and dispatch lets the addressee run on a task it does not
        // own only for a verified `interaction_pending` wake
        // (verifyAddresseeInteractionWake: the named card is still pending and
        // addressed to it). Otherwise the queued run is cancelled as "issue
        // assignee changed" and the card still waits.
        payload: interactionId
          ? { issueId, mutation: "interaction", interactionId, interactionKind, missedWakeRequestId: missed.id }
          : { issueId, mutation: "pause_lifted", missedWakeRequestId: missed.id },
        idempotencyKey: `pause-missed:${input.agentId}:${issueId}:${missed.id ?? missed.interactionId}`,
        requestedByActorType: "system",
        requestedByActorId: "pause-missed-wakes",
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: interactionId ? "interaction_pending" : PAUSE_MISSED_WAKE_REASON,
          source: "agent.pause_lifted",
          missedWakeRequestId: missed.id,
          ...(interactionId ? { interactionId, interactionKind } : {}),
        },
      });
      woken += 1;
    } catch {
      // A wake refused now (a new pause, a budget stop, a blocked task) is not
      // lost: its own refusal is recorded, and the next resume retries it.
    }
  }
  return { issues: latest.size, woken };
}
