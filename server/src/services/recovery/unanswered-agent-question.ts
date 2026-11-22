// STUDIO-0089 (lot 26, R2): a question one role asks another, left without an answer, is taken up by the server.
//
// The facts. Production, 22 Nov 2026. TR-2394: a card addressed to the CTO; the CTO was woken once, at the card's
// creation, its run succeeded, and it did not answer; nothing woke it again and the card waited for hours. A card
// wakes its addressee once (routes/issues.ts, the `interaction-pending:<card>` wake) and never again.
//
// The rule, for a pending question or confirmation addressed to an AGENT, on an open task:
// - nothing is done while the addressee has not read yet: a wake of the addressee for this card is still in the
//   queue, or a run of the addressee for it is queued or running. They are read BY THE CARD, wherever they were
//   delivered: on the card's task, or on a task of the addressee itself when the card's wake named one. Nor while
//   the addressee is paused or stopped by its budget: that is left to the resume, as before;
// - after `relaunchAfterMinutes` (5), ONCE per card: the addressee is woken again, with the wake of the card's
//   creation under another request reason and key. The relaunch is NOT sent when the card's first wake led to no
//   successful run of the addressee on this task (a router refusal, the dependency gate, a failure): a second wake
//   would end the same way. That is said on the task;
// - after `managerAfterMinutes` (15), ONCE per card, and only once the relaunch is spent: a new card on the same task,
//   written by the system and addressed to the direct manager of the addressee, with its wake. No manager, or one
//   that cannot be addressed: nothing more, said once on the task;
// - the card written to the manager is relaunched once like any other, and never gives a card to the manager above;
// - when the question is no longer pending, the server withdraws ITS OWN card to the manager if that one still
//   waits, so that nothing it wrote keeps the task waiting;
// - a card that already waited a day is left alone (a card open for long is told to the owner by another piece).
// Never: an answer in someone's place, another's card closed, a card addressed to a person relaunched.
//
// Once-ness is read from what is stored, with no counter: the relaunch from its line of activity (written under the
// card's row lock, before the wake), the manager's card from its idempotency key (unique per task).
// Cadence: the stranded-assignment and resolved-dependency recovery queues (recovery/work.ts) look at each open task
// that has an assignee (todo, in_progress, in_review; blocked) every 30 s, and at the deadline given back here.
// The delays live in the company's `interaction_resolver_governance` (`unansweredAgentQuestion`); `enabled: false`
// switches the piece off for the company.
import { and, asc, eq, gte, inArray, isNotNull, isNull, like, notInArray, or, sql } from "drizzle-orm";
import { activityLog, agentWakeupRequests, agents, companies, heartbeatRuns, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { persistActivity } from "../activity-log.js";
import { evaluateAgentAddressabilityFromDb, evaluateAgentInvokabilityFromDb } from "../agent-invokability.js";
import { issueThreadInteractionAttentionAgentAllowed } from "../issue-thread-interaction-resolution.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";

const LIVE_WAKE_STATUSES = ["queued", "deferred_issue_execution", "claimed"];
const LIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"];
const CARD_KINDS = ["ask_user_questions", "request_confirmation"];
export const UNANSWERED_QUESTION_ACTOR_ID = "unanswered-agent-question";
export const UNANSWERED_QUESTION_RELAUNCH_REASON = "interaction_relaunch";
export const UNANSWERED_QUESTION_RELAUNCHED_ACTION = "issue.thread_interaction_relaunched";
export const UNANSWERED_QUESTION_MANAGER_ACTION = "issue.thread_interaction_manager_asked";
export const UNANSWERED_QUESTION_MANAGER_KEY_PREFIX = "unanswered-question:";
export const UNANSWERED_QUESTION_RELAUNCH_DEFAULT_MINUTES = 5;
export const UNANSWERED_QUESTION_MANAGER_DEFAULT_MINUTES = 15;
export const UNANSWERED_QUESTION_MAX_AGE_MS = 24 * 60 * 60_000;

export const unansweredQuestionRelaunchKey = (interactionId: string) => `interaction-pending:${interactionId}:relance:1`;
export const unansweredQuestionManagerKey = (interactionId: string) => `${UNANSWERED_QUESTION_MANAGER_KEY_PREFIX}${interactionId}:manager`;

export type UnansweredQuestionWake = (agentId: string, request: {
  source: "automation";
  triggerDetail: "system";
  reason: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  requestedByActorType: "system";
  requestedByActorId: string;
  contextSnapshot: Record<string, unknown>;
}) => Promise<unknown>;

export type UnansweredQuestionOutcome =
  | "not_due" | "too_old" | "not_answerable" | "addressee_held" | "not_read_yet" | "relaunched" | "relaunch_not_sent"
  | "manager_not_due" | "manager_asked" | "manager_not_asked" | "done" | "withdrawn";

/** The company's delays, in milliseconds; null when the company switched the piece off. */
export function readUnansweredQuestionSettings(governance: unknown): { relaunchAfterMs: number; managerAfterMs: number } | null {
  const raw = governance && typeof governance === "object"
    ? (governance as Record<string, unknown>).unansweredAgentQuestion : null;
  const settings = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  if (settings.enabled === false) return null;
  const minutes = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value >= 1 ? value : fallback;
  const relaunchAfterMs = minutes(settings.relaunchAfterMinutes, UNANSWERED_QUESTION_RELAUNCH_DEFAULT_MINUTES) * 60_000;
  // The manager is never asked before the addressee's relaunch is due.
  const managerAfterMs = Math.max(relaunchAfterMs,
    minutes(settings.managerAfterMinutes, UNANSWERED_QUESTION_MANAGER_DEFAULT_MINUTES) * 60_000);
  return { relaunchAfterMs, managerAfterMs };
}

function titleOf(card: typeof issueThreadInteractions.$inferSelect) {
  const payload = (card.payload ?? {}) as unknown as Record<string, unknown>;
  const questions = Array.isArray(payload.questions) ? payload.questions as Array<Record<string, unknown>> : [];
  const text = [card.title, payload.title, payload.prompt, questions[0]?.prompt]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return (text ?? "untitled question").trim().replace(/\s+/g, " ").slice(0, 160);
}

/** The wake a card sends its addressee when it is created (routes/issues.ts), under the reason and key given. */
function cardWake(card: { id: string; issueId: string; kind: string; sourceCommentId: string | null; sourceRunId: string | null },
  request: { reason: string; idempotencyKey: string; source: string; relaunch?: number; wakeIssueId?: string }) {
  // The task the wake is delivered on: the card's own, or the addressee's task the card's first wake named.
  const issueId = request.wakeIssueId ?? card.issueId;
  const named = { interactionId: card.id, interactionKind: card.kind, sourceCommentId: card.sourceCommentId ?? null,
    sourceRunId: card.sourceRunId ?? null, ...(request.relaunch ? { interactionRelaunch: request.relaunch } : {}),
    ...(issueId !== card.issueId ? { interactionIssueId: card.issueId } : {}) };
  return {
    source: "automation" as const, triggerDetail: "system" as const, reason: request.reason,
    payload: { issueId, ...named, mutation: "interaction" },
    idempotencyKey: request.idempotencyKey,
    requestedByActorType: "system" as const, requestedByActorId: UNANSWERED_QUESTION_ACTOR_ID,
    // Dispatch admits an addressee on a task it does not own from the run context, not from the request's reason:
    // `interaction_pending` and the named card, still pending and addressed to it (verifyAddresseeInteractionWake).
    contextSnapshot: { issueId, taskId: issueId, ...named, wakeReason: "interaction_pending", source: request.source },
  };
}

export async function relaunchUnansweredAgentQuestions(db: Db, input: {
  companyId: string;
  issueId: string;
  wake: UnansweredQuestionWake;
  invocationBlocked?: (agentId: string, issueId: string, projectId: string | null) => Promise<boolean>;
  now?: Date;
  /** The next time this task is worth another look (a card's relaunch or manager delay). */
  onDeferredDeadline?: (at: number) => void;
}): Promise<Array<{ interactionId: string; outcome: UnansweredQuestionOutcome }>> {
  const now = input.now ?? new Date();
  // The cheap read first: most tasks carry no pending card addressed to an agent and stop here. Cards that already
  // waited a day are not read (they would take the places of the day's cards), except the server's own cards to
  // managers, which are still withdrawn.
  const cards = await db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, input.companyId), eq(issueThreadInteractions.issueId, input.issueId),
    eq(issueThreadInteractions.status, "pending"), inArray(issueThreadInteractions.kind, CARD_KINDS),
    isNotNull(issueThreadInteractions.addresseeAgentId), isNull(issueThreadInteractions.addresseeUserId),
    or(gte(issueThreadInteractions.createdAt, new Date(now.getTime() - UNANSWERED_QUESTION_MAX_AGE_MS)),
      like(issueThreadInteractions.idempotencyKey, `${UNANSWERED_QUESTION_MANAGER_KEY_PREFIX}%`)),
  )).orderBy(asc(issueThreadInteractions.createdAt)).limit(20);
  if (cards.length === 0) return [];
  const [issue] = await db.select({ status: issues.status, hiddenAt: issues.hiddenAt, projectId: issues.projectId,
    governance: companies.interactionResolverGovernance })
    .from(issues).innerJoin(companies, eq(companies.id, issues.companyId))
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)));
  if (!issue || issue.hiddenAt || ["done", "cancelled"].includes(issue.status)) return [];
  // Switched off for the company: nothing is relaunched and no manager is asked, but the server still withdraws the
  // cards it wrote itself once their question no longer waits.
  const settings = readUnansweredQuestionSettings(issue.governance);
  const interactions = issueThreadInteractionService(db);
  const outcomes: Array<{ interactionId: string; outcome: UnansweredQuestionOutcome }> = [];
  const say = (card: { id: string }, action: string, details: Record<string, unknown>, runner: Db = db) =>
    persistActivity(runner, { companyId: input.companyId, actorType: "system", actorId: UNANSWERED_QUESTION_ACTOR_ID,
      action, entityType: "issue", entityId: input.issueId, details: { interactionId: card.id, at: now.toISOString(), ...details } });
  /** When the task said this of the card (the time of the pass that said it), or null. */
  const said = async (card: { id: string }, action: string, runner: Db = db): Promise<Date | null> => {
    const [row] = await runner.select({ at: activityLog.createdAt, details: activityLog.details }).from(activityLog)
      .where(and(eq(activityLog.companyId, input.companyId), eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, input.issueId), eq(activityLog.action, action),
        sql`${activityLog.details}->>'interactionId' = ${card.id}`)).orderBy(asc(activityLog.createdAt)).limit(1);
    if (!row) return null;
    const at = new Date(String((row.details as Record<string, unknown> | null)?.at ?? ""));
    return Number.isNaN(at.getTime()) ? row.at : at;
  };
  // The addressee's wakes and runs FOR THIS CARD, wherever they were delivered: on the card's task, or on a task of
  // the addressee itself when the card's wake named one (the request and the run's context then carry the card).
  const wakeForCard = (card: { id: string }) => or(sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`,
    sql`${agentWakeupRequests.payload}->>'interactionId' = ${card.id}`);
  const runForCard = (card: { id: string }) => or(sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`,
    sql`${heartbeatRuns.contextSnapshot}->>'interactionId' = ${card.id}`);

  for (const card of cards) {
    const outcome = await (async (): Promise<UnansweredQuestionOutcome | null> => {
      const addresseeAgentId = card.addresseeAgentId!;
      // The server's own card to a manager: withdrawn once the question it speaks of is no longer pending.
      const about = card.idempotencyKey?.startsWith(UNANSWERED_QUESTION_MANAGER_KEY_PREFIX) && !card.createdByAgentId && !card.createdByUserId
        ? card.idempotencyKey.slice(UNANSWERED_QUESTION_MANAGER_KEY_PREFIX.length).split(":")[0]! : null;
      if (about) {
        const [question] = await db.select({ status: issueThreadInteractions.status }).from(issueThreadInteractions)
          .where(and(eq(issueThreadInteractions.companyId, input.companyId), eq(issueThreadInteractions.id, about)));
        if (question?.status !== "pending") {
          await interactions.withdrawInteraction({ id: input.issueId, companyId: input.companyId }, card.id,
            { reason: "The question this card speaks of is no longer waiting for an answer." }, { systemId: UNANSWERED_QUESTION_ACTOR_ID });
          return "withdrawn";
        }
      }
      if (!settings) return null;
      const relaunchAt = card.createdAt.getTime() + settings.relaunchAfterMs;
      if (now.getTime() < relaunchAt) { input.onDeferredDeadline?.(relaunchAt); return "not_due"; }
      // A card that already waited a day is not taken up: when this piece is put in service, the cards left for days
      // are not all relaunched at once.
      if (now.getTime() - card.createdAt.getTime() > UNANSWERED_QUESTION_MAX_AGE_MS) return "too_old";
      const managerDone = about !== null || Boolean((await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions)
        .where(and(eq(issueThreadInteractions.companyId, input.companyId), eq(issueThreadInteractions.issueId, input.issueId),
          eq(issueThreadInteractions.idempotencyKey, unansweredQuestionManagerKey(card.id)))).limit(1))[0])
        || Boolean(await said(card, UNANSWERED_QUESTION_MANAGER_ACTION));
      const relaunchDone = await said(card, UNANSWERED_QUESTION_RELAUNCHED_ACTION);
      if (relaunchDone && managerDone) return "done";
      // The same attention rule as the wake of the card's creation: an agent that may not answer is not woken.
      const payload = (card.payload ?? {}) as unknown as Record<string, unknown>;
      if (!issueThreadInteractionAttentionAgentAllowed({ agentId: addresseeAgentId, interaction: card as never,
        governedAction: card.kind === "request_confirmation" && payload.toolAction !== undefined })) return "not_answerable";
      const [addressee] = await db.select().from(agents)
        .where(and(eq(agents.companyId, input.companyId), eq(agents.id, addresseeAgentId)));
      if (!addressee || !(await evaluateAgentInvokabilityFromDb(db, addressee)).invokable) return "addressee_held";
      if (input.invocationBlocked && await input.invocationBlocked(addresseeAgentId, input.issueId, issue.projectId)) return "addressee_held";
      const [liveWake] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.agentId, addresseeAgentId),
        inArray(agentWakeupRequests.status, LIVE_WAKE_STATUSES), wakeForCard(card))).limit(1);
      const [liveRun] = liveWake ? [] : await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, addresseeAgentId),
        inArray(heartbeatRuns.status, LIVE_RUN_STATUSES), runForCard(card))).limit(1);
      if (liveWake || liveRun) return "not_read_yet";

      if (!relaunchDone) {
        const [firstWake] = await db.select({ id: agentWakeupRequests.id, payload: agentWakeupRequests.payload })
          .from(agentWakeupRequests).where(and(
            eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.agentId, addresseeAgentId),
            sql`${agentWakeupRequests.payload}->>'interactionId' = ${card.id}`))
          .orderBy(asc(agentWakeupRequests.requestedAt)).limit(1);
        const [readRun] = firstWake ? await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, addresseeAgentId),
          eq(heartbeatRuns.status, "succeeded"), gte(heartbeatRuns.finishedAt, card.createdAt), runForCard(card))).limit(1) : [];
        const sent = !firstWake || Boolean(readRun);
        // The relaunch goes where the first wake went. The card does not keep that task: the first wake's request
        // does. It must still be an open task of the addressee; otherwise the card's own task, as without it.
        const firstIssueId = (firstWake?.payload as Record<string, unknown> | null | undefined)?.issueId;
        const [own] = typeof firstIssueId === "string" && firstIssueId !== input.issueId
          ? await db.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, input.companyId),
            sql`${issues.id}::text = ${firstIssueId}`, eq(issues.assigneeAgentId, addresseeAgentId),
            notInArray(issues.status, ["done", "cancelled"]))).limit(1) : [];
        const wakeIssueId = own?.id;
        // Said under the card's row lock and before the wake: once, whatever becomes of the wake.
        const first = await db.transaction(async tx => {
          const [locked] = await tx.select({ status: issueThreadInteractions.status }).from(issueThreadInteractions)
            .where(eq(issueThreadInteractions.id, card.id)).for("update");
          if (locked?.status !== "pending" || await said(card, UNANSWERED_QUESTION_RELAUNCHED_ACTION, tx as unknown as Db)) return false;
          await say(card, UNANSWERED_QUESTION_RELAUNCHED_ACTION, { addresseeAgentId, sent,
            ...(sent ? {} : { reason: "first_wake_reached_no_successful_run" }),
            ...(sent && wakeIssueId ? { wakeIssueId } : {}) }, tx as unknown as Db);
          return true;
        });
        if (!first) return "done";
        if (!sent) return "relaunch_not_sent";
        await input.wake(addresseeAgentId, cardWake(card, { reason: UNANSWERED_QUESTION_RELAUNCH_REASON,
          idempotencyKey: unansweredQuestionRelaunchKey(card.id), source: "issue.interaction.relaunched", relaunch: 1,
          ...(wakeIssueId ? { wakeIssueId } : {}) }))
          .catch(err => logger.warn({ err, issueId: input.issueId, interactionId: card.id, agentId: addresseeAgentId },
            "the relaunch of an unanswered question could not be enqueued"));
        return "relaunched";
      }

      // The manager is asked after its delay, and never sooner after the relaunch than a card relaunched on time
      // would have had: a card that was already old when it was relaunched still leaves its addressee that time.
      const managerAt = Math.max(card.createdAt.getTime() + settings.managerAfterMs,
        relaunchDone.getTime() + settings.managerAfterMs - settings.relaunchAfterMs);
      if (now.getTime() < managerAt) { input.onDeferredDeadline?.(managerAt); return "manager_not_due"; }
      const [manager] = addressee.reportsTo && addressee.reportsTo !== addressee.id ? await db.select().from(agents)
        .where(and(eq(agents.companyId, input.companyId), eq(agents.id, addressee.reportsTo))) : [];
      const refusal = !manager ? "no_manager"
        : !(await evaluateAgentAddressabilityFromDb(db, manager)).invokable ? "manager_not_addressable" : null;
      if (refusal) { await say(card, UNANSWERED_QUESTION_MANAGER_ACTION, { addresseeAgentId, asked: false, reason: refusal }); return "manager_not_asked"; }
      const title = titleOf(card);
      let managerCard: Awaited<ReturnType<typeof interactions.create>>;
      try {
        managerCard = await interactions.create({ id: input.issueId, companyId: input.companyId }, {
          kind: "ask_user_questions", addresseeAgentId: manager!.id, idempotencyKey: unansweredQuestionManagerKey(card.id),
          title: `No answer: ${title}`, continuationPolicy: "none",
          payload: { version: 1, questions: [{ id: "decision", selectionMode: "single", required: true,
            prompt: `${addressee.name} has not answered the question "${title}" asked on this task. What do you decide?`,
            options: [{ id: "take_over", label: "I take it from here" }, { id: "leave_waiting", label: "Leave it waiting" }] }] },
        } as never, { systemId: UNANSWERED_QUESTION_ACTOR_ID }, { supersedePendingSiblingInteractions: false });
      } catch (err) {
        logger.warn({ err, issueId: input.issueId, interactionId: card.id, managerAgentId: manager!.id },
          "the card to the manager of an unanswered question could not be written");
        await say(card, UNANSWERED_QUESTION_MANAGER_ACTION, { addresseeAgentId, managerAgentId: manager!.id, asked: false, reason: "card_refused" });
        return "manager_not_asked";
      }
      await say(card, UNANSWERED_QUESTION_MANAGER_ACTION, { addresseeAgentId, managerAgentId: manager!.id, asked: true,
        managerInteractionId: managerCard.id });
      if (managerCard.status === "pending") {
        await input.wake(manager!.id, cardWake({ id: managerCard.id, issueId: input.issueId, kind: managerCard.kind,
          sourceCommentId: null, sourceRunId: null },
          { reason: "interaction_pending", idempotencyKey: `interaction-pending:${managerCard.id}`, source: "issue.interaction.created" }))
          .catch(err => logger.warn({ err, issueId: input.issueId, interactionId: managerCard.id, agentId: manager!.id },
            "the manager of an unanswered question could not be woken"));
      }
      return "manager_asked";
    })();
    if (outcome) outcomes.push({ interactionId: card.id, outcome });
  }
  return outcomes;
}
