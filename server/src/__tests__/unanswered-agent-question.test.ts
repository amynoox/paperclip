import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issueThreadInteractions, issues,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { updateCompanySchema } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import {
  UNANSWERED_QUESTION_MANAGER_ACTION, UNANSWERED_QUESTION_RELAUNCHED_ACTION, UNANSWERED_QUESTION_RELAUNCH_REASON,
  readUnansweredQuestionSettings, relaunchUnansweredAgentQuestions, unansweredQuestionManagerKey, unansweredQuestionRelaunchKey,
} from "../services/recovery/unanswered-agent-question.js";

// STUDIO-0087: production, 22 Nov 2026, TR-2394. A card addressed to the CTO; the CTO was woken once, its run
// succeeded, it did not answer, and nothing woke it again: the card waited for hours.
describe("a question between roles left without an answer", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("unanswered-agent-question-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  type Fixture = Awaited<ReturnType<typeof seed>>;
  async function seed(opts: { governance?: Record<string, unknown>; manager?: boolean } = {}) {
    const companyId = randomUUID(), asker = randomUUID(), addressee = randomUUID(), manager = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Questions", defaultResponsibleUserId: "board",
      issuePrefix: `Q${companyId.slice(0, 6)}`, interactionResolverGovernance: (opts.governance ?? {}) as never });
    await db.insert(agents).values([
      { id: manager, companyId, name: "CEO", adapterType: "process", status: "idle", permissions: {} },
      { id: addressee, companyId, name: "CTO", adapterType: "process", status: "idle", permissions: {},
        reportsTo: opts.manager === false ? null : manager },
      { id: asker, companyId, name: "Dev Unity", adapterType: "process", status: "idle", permissions: {} },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Ship the build", status: "in_progress", assigneeAgentId: asker });
    return { companyId, asker, addressee, manager, issueId };
  }

  // The card, written by the product's own service, as one role asks another.
  async function ask(f: Fixture) {
    const card = await issueThreadInteractionService(db).create({ id: f.issueId, companyId: f.companyId }, {
      kind: "ask_user_questions", addresseeAgentId: f.addressee, title: "Which build do we ship?",
      payload: { version: 1, questions: [{ id: "build", prompt: "Which build do we ship?", selectionMode: "single",
        options: [{ id: "a", label: "3061" }, { id: "b", label: "3062" }] }] },
    } as never, { systemId: "unanswered-question-test" });
    await db.update(issueThreadInteractions).set({ createdByAgentId: f.asker }).where(eq(issueThreadInteractions.id, card.id));
    const [row] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id));
    return row;
  }
  type Card = Awaited<ReturnType<typeof ask>>;
  const after = (card: Card, minutes: number) => new Date(card.createdAt.getTime() + minutes * 60_000);

  // What the card's creation leaves: its one wake of the addressee, in the state given.
  async function firstWake(f: Fixture, card: Card, status: string) {
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.addressee, source: "automation",
      triggerDetail: "system", reason: "interaction_pending", status, idempotencyKey: `interaction-pending:${card.id}`,
      payload: { issueId: f.issueId, interactionId: card.id, interactionKind: card.kind, mutation: "interaction" } }).returning();
    return wake;
  }
  // A run of the addressee on the task, started by that wake.
  async function ran(f: Fixture, card: Card, status: string, extra: Record<string, unknown> = {}) {
    const live = ["queued", "running", "scheduled_retry"].includes(status);
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.addressee, status,
      createdAt: after(card, 0.5), finishedAt: live ? null : after(card, 1),
      contextSnapshot: { issueId: f.issueId, interactionId: card.id, wakeReason: "interaction_pending" }, ...extra } as never).returning();
    return run;
  }
  async function readAndDidNotAnswer(f: Fixture, card: Card) {
    await firstWake(f, card, "completed");
    await ran(f, card, "succeeded");
  }
  const spy = () => vi.fn().mockResolvedValue(null);
  async function pass(f: Fixture, card: Card, minutes: number, wake: ReturnType<typeof spy>, deadlines: number[] = []) {
    const outcomes = await relaunchUnansweredAgentQuestions(db, { companyId: f.companyId, issueId: f.issueId, now: after(card, minutes),
      wake: wake as never, onDeferredDeadline: at => { deadlines.push(at); } });
    return outcomes.find(outcome => outcome.interactionId === card.id)?.outcome ?? null;
  }
  const cardsOf = (f: Fixture) => db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId));
  const saidOf = async (f: Fixture, action: string) => (await db.select().from(activityLog).where(and(
    eq(activityLog.companyId, f.companyId), eq(activityLog.entityId, f.issueId), eq(activityLog.action, action)))).map(row => row.details);
  const wakesTo = (wake: ReturnType<typeof spy>, agentId: string) => wake.mock.calls.filter(call => call[0] === agentId).map(call => call[1]);

  it("the addressee read and did not answer: it is woken again once the delay is over, through the real queue", async () => {
    const f = await seed();
    const card = await ask(f);
    await readAndDidNotAnswer(f, card);
    const heartbeat = heartbeatService(db);
    const wake = vi.fn((agentId: string, request: Parameters<typeof heartbeat.wakeup>[1]) => heartbeat.wakeup(agentId, request));
    const deadlines: number[] = [];
    expect(await pass(f, card, 4, wake as never, deadlines)).toBe("not_due");
    expect(wake).not.toHaveBeenCalled();
    expect(deadlines).toEqual([after(card, 5).getTime()]);

    expect(await pass(f, card, 5, wake as never)).toBe("relaunched");
    await new Promise(resolve => setTimeout(resolve, 500));
    const relaunches = (await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.agentId, f.addressee)))).filter(row => row.idempotencyKey === unansweredQuestionRelaunchKey(card.id));
    expect(relaunches).toHaveLength(1);
    expect(relaunches[0].reason).toBe(UNANSWERED_QUESTION_RELAUNCH_REASON);
    // Not refused, and not cancelled by dispatch because the addressee does not own the task.
    expect(relaunches[0].status).not.toBe("skipped");
    expect({ error: relaunches[0].error ?? "" }).not.toMatchObject({ error: expect.stringContaining("assignee changed") });
    expect(relaunches[0].payload).toMatchObject({ issueId: f.issueId, mutation: "interaction", interactionId: card.id,
      interactionKind: "ask_user_questions" });
    expect(wake.mock.calls[0][1]).toMatchObject({ contextSnapshot: { wakeReason: "interaction_pending", interactionId: card.id, issueId: f.issueId } });
    expect(await saidOf(f, UNANSWERED_QUESTION_RELAUNCHED_ACTION)).toEqual([expect.objectContaining({ interactionId: card.id, sent: true })]);
    // The card itself is untouched.
    const [still] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id));
    expect(still).toMatchObject({ status: "pending", updatedAt: card.updatedAt, resolvedAt: null });
    await heartbeat.drainActiveRunExecutions?.();
  });

  it("still no answer after the second delay: a card to the addressee's manager, with its wake through the real queue", async () => {
    const f = await seed();
    const card = await ask(f);
    await readAndDidNotAnswer(f, card);
    const heartbeat = heartbeatService(db);
    // The addressee's relaunch is not enqueued here, so that nothing of it is alive at the second delay.
    const wake = vi.fn((agentId: string, request: Parameters<typeof heartbeat.wakeup>[1]) =>
      agentId === f.manager ? heartbeat.wakeup(agentId, request) : Promise.resolve(null));
    expect(await pass(f, card, 5, wake as never)).toBe("relaunched");
    const deadlines: number[] = [];
    expect(await pass(f, card, 14, wake as never, deadlines)).toBe("manager_not_due");
    expect(deadlines).toEqual([after(card, 15).getTime()]);
    expect(await cardsOf(f)).toHaveLength(1);

    expect(await pass(f, card, 15, wake as never)).toBe("manager_asked");
    const cards = await cardsOf(f);
    expect(cards).toHaveLength(2);
    const asked = cards.find(row => row.id !== card.id)!;
    expect(asked).toMatchObject({ kind: "ask_user_questions", status: "pending", addresseeAgentId: f.manager, addresseeUserId: null,
      createdByAgentId: null, createdByUserId: null, idempotencyKey: unansweredQuestionManagerKey(card.id),
      title: "No answer: Which build do we ship?", continuationPolicy: "none" });
    expect((asked.payload as { questions: Array<{ prompt: string; options: Array<{ label: string }> }> }).questions).toEqual([
      expect.objectContaining({ prompt: 'CTO has not answered the question "Which build do we ship?" asked on this task. What do you decide?',
        options: [expect.objectContaining({ label: "I take it from here" }), expect.objectContaining({ label: "Leave it waiting" })] })]);
    // Nobody answered in the addressee's place, and its card is not closed.
    expect(cards.find(row => row.id === card.id)).toMatchObject({ status: "pending", result: null, resolvedAt: null });
    await new Promise(resolve => setTimeout(resolve, 500));
    const managerWakes = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.agentId, f.manager)));
    expect(managerWakes).toHaveLength(1);
    expect(managerWakes[0]).toMatchObject({ idempotencyKey: `interaction-pending:${asked.id}`, reason: "interaction_pending" });
    expect(managerWakes[0].status).not.toBe("skipped");
    expect({ error: managerWakes[0].error ?? "" }).not.toMatchObject({ error: expect.stringContaining("assignee changed") });
    expect(await saidOf(f, UNANSWERED_QUESTION_MANAGER_ACTION)).toEqual([expect.objectContaining({ interactionId: card.id, asked: true,
      managerAgentId: f.manager, managerInteractionId: asked.id })]);
    await heartbeat.drainActiveRunExecutions?.();
  });

  it("ten passes give one relaunch and one card; the manager's card is relaunched once and gives no card above", async () => {
    const f = await seed();
    const card = await ask(f);
    await readAndDidNotAnswer(f, card);
    const wake = spy();
    const seen: Array<string | null> = [];
    // Well past both delays from the first pass on: the addressee still gets its relaunch before its manager is asked.
    for (let index = 0; index < 10; index += 1) seen.push(await pass(f, card, 60, wake));
    expect(seen).toEqual(["relaunched", "manager_asked", ...Array(8).fill("done")]);
    const cards = await cardsOf(f);
    expect(cards).toHaveLength(2);
    const asked = cards.find(row => row.id !== card.id)!;
    expect(wakesTo(wake, f.addressee).map(request => request.idempotencyKey)).toEqual([unansweredQuestionRelaunchKey(card.id)]);
    expect(wakesTo(wake, f.manager).map(request => request.idempotencyKey)).toEqual([
      `interaction-pending:${asked.id}`, unansweredQuestionRelaunchKey(asked.id)]);
    expect(await saidOf(f, UNANSWERED_QUESTION_MANAGER_ACTION)).toHaveLength(1);
    expect((await saidOf(f, UNANSWERED_QUESTION_RELAUNCHED_ACTION)).map(details => (details as { interactionId: string }).interactionId).sort())
      .toEqual([card.id, asked.id].sort());
  });

  it("an answered card is neither relaunched nor taken to the manager", async () => {
    const f = await seed();
    const card = await ask(f);
    await readAndDidNotAnswer(f, card);
    await db.update(issueThreadInteractions).set({ status: "answered", resolvedAt: after(card, 2) }).where(eq(issueThreadInteractions.id, card.id));
    const wake = spy();
    expect(await pass(f, card, 60, wake)).toBeNull();
    expect(await pass(f, card, 61, wake)).toBeNull();
    expect(wake).not.toHaveBeenCalled();
    expect(await cardsOf(f)).toHaveLength(1);
  });

  it("a card answered between the two delays gives no card to the manager", async () => {
    const f = await seed();
    const card = await ask(f);
    await readAndDidNotAnswer(f, card);
    const wake = spy();
    expect(await pass(f, card, 5, wake)).toBe("relaunched");
    await db.update(issueThreadInteractions).set({ status: "answered", resolvedAt: after(card, 9) }).where(eq(issueThreadInteractions.id, card.id));
    expect(await pass(f, card, 15, wake)).toBeNull();
    expect(await pass(f, card, 60, wake)).toBeNull();
    expect(wakesTo(wake, f.manager)).toHaveLength(0);
    expect(await cardsOf(f)).toHaveLength(1);
    expect(await saidOf(f, UNANSWERED_QUESTION_MANAGER_ACTION)).toHaveLength(0);
  });

  it.each(["queued", "deferred_issue_execution", "claimed"])(
    "the card's first wake is still %s when the delay is over: no relaunch; once its run is over without an answer: the relaunch", async status => {
      const f = await seed();
      const card = await ask(f);
      const first = await firstWake(f, card, status);
      const wake = spy();
      expect(await pass(f, card, 6, wake)).toBe("not_read_yet");
      expect(await pass(f, card, 60, wake)).toBe("not_read_yet");
      expect(wake).not.toHaveBeenCalled();
      expect(await saidOf(f, UNANSWERED_QUESTION_RELAUNCHED_ACTION)).toHaveLength(0);
      await db.update(agentWakeupRequests).set({ status: "completed", finishedAt: after(card, 61) }).where(eq(agentWakeupRequests.id, first.id));
      await ran(f, card, "succeeded");
      expect(await pass(f, card, 62, wake)).toBe("relaunched");
      expect(wakesTo(wake, f.addressee)).toHaveLength(1);
    });

  it.each(["queued", "running", "scheduled_retry"])(
    "a run of the addressee is %s on the task: neither the relaunch nor, later, the card to its manager", async status => {
      const f = await seed();
      const card = await ask(f);
      await firstWake(f, card, "completed");
      const run = await ran(f, card, status);
      const wake = spy();
      expect(await pass(f, card, 5, wake)).toBe("not_read_yet");
      expect(await pass(f, card, 60, wake)).toBe("not_read_yet");
      expect(wake).not.toHaveBeenCalled();
      expect(await cardsOf(f)).toHaveLength(1);
      // The run ends without an answer: the addressee first, its manager only after that relaunch is spent.
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: after(card, 61) }).where(eq(heartbeatRuns.id, run.id));
      expect(await pass(f, card, 62, wake)).toBe("relaunched");
      expect(wakesTo(wake, f.manager)).toHaveLength(0);
      expect(await pass(f, card, 63, wake)).toBe("manager_asked");
    });

  it.each([
    { label: "its run was refused or failed", prepare: async (f: Fixture, card: Card) => { await firstWake(f, card, "completed");
      await ran(f, card, "failed", { errorCode: "router_ticket_not_assigned_to_agent" }); } },
    { label: "it was refused before any run", prepare: async (f: Fixture, card: Card) => { await firstWake(f, card, "skipped"); } },
  ])("the card's first wake reached no successful run ($label): no relaunch, the manager after the second delay, and the task says why",
    async ({ prepare }) => {
      const f = await seed();
      const card = await ask(f);
      await prepare(f, card);
      const wake = spy();
      expect(await pass(f, card, 5, wake)).toBe("relaunch_not_sent");
      expect(wake).not.toHaveBeenCalled();
      expect(await saidOf(f, UNANSWERED_QUESTION_RELAUNCHED_ACTION)).toEqual([expect.objectContaining({ interactionId: card.id, sent: false,
        reason: "first_wake_reached_no_successful_run" })]);
      expect(await pass(f, card, 14, wake)).toBe("manager_not_due");
      expect(await pass(f, card, 15, wake)).toBe("manager_asked");
      expect(wakesTo(wake, f.addressee)).toHaveLength(0);
      expect(wakesTo(wake, f.manager)).toHaveLength(1);
    });

  it("a card whose first wake was lost is relaunched: the relaunch is its first wake", async () => {
    const f = await seed();
    const card = await ask(f);
    const wake = spy();
    expect(await pass(f, card, 5, wake)).toBe("relaunched");
    expect(wakesTo(wake, f.addressee)).toHaveLength(1);
  });

  it("a card addressed to a person is left alone", async () => {
    const f = await seed();
    const id = randomUUID();
    await db.insert(issueThreadInteractions).values({ id, companyId: f.companyId, issueId: f.issueId, kind: "ask_user_questions",
      status: "pending", addresseeUserId: "board", createdByAgentId: f.asker, title: "For the owner",
      createdAt: new Date(Date.now() - 24 * 60 * 60_000), payload: { version: 1, questions: [] } as never });
    const wake = spy();
    expect(await relaunchUnansweredAgentQuestions(db, { companyId: f.companyId, issueId: f.issueId, wake: wake as never })).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
    expect(await cardsOf(f)).toHaveLength(1);
  });

  it("a paused addressee is left as it is, and is relaunched once it works again", async () => {
    const f = await seed();
    const card = await ask(f);
    await readAndDidNotAnswer(f, card);
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.addressee));
    const wake = spy();
    expect(await pass(f, card, 5, wake)).toBe("addressee_held");
    expect(await pass(f, card, 60, wake)).toBe("addressee_held");
    expect(wake).not.toHaveBeenCalled();
    expect(await cardsOf(f)).toHaveLength(1);
    expect(await saidOf(f, UNANSWERED_QUESTION_RELAUNCHED_ACTION)).toHaveLength(0);
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.addressee));
    expect(await pass(f, card, 61, wake)).toBe("relaunched");
  });

  it("an addressee stopped by its budget is left as it is", async () => {
    const f = await seed();
    const card = await ask(f);
    await readAndDidNotAnswer(f, card);
    const wake = spy();
    const outcomes = await relaunchUnansweredAgentQuestions(db, { companyId: f.companyId, issueId: f.issueId, now: after(card, 60),
      wake: wake as never, invocationBlocked: async agentId => agentId === f.addressee });
    expect(outcomes).toEqual([{ interactionId: card.id, outcome: "addressee_held" }]);
    expect(wake).not.toHaveBeenCalled();
  });

  it("an addressee without a manager: the relaunch, then nothing more, said once", async () => {
    const f = await seed({ manager: false });
    const card = await ask(f);
    await readAndDidNotAnswer(f, card);
    const wake = spy();
    expect(await pass(f, card, 5, wake)).toBe("relaunched");
    expect(await pass(f, card, 15, wake)).toBe("manager_not_asked");
    expect(await pass(f, card, 16, wake)).toBe("done");
    expect(await pass(f, card, 600, wake)).toBe("done");
    expect(wake).toHaveBeenCalledTimes(1);
    expect(await cardsOf(f)).toHaveLength(1);
    expect(await saidOf(f, UNANSWERED_QUESTION_MANAGER_ACTION)).toEqual([expect.objectContaining({ interactionId: card.id, asked: false, reason: "no_manager" })]);
  });

  it("the delays are the company's, and the company can switch the piece off", async () => {
    const f = await seed({ governance: { unansweredAgentQuestion: { relaunchAfterMinutes: 30, managerAfterMinutes: 120 } } });
    const card = await ask(f);
    await readAndDidNotAnswer(f, card);
    const wake = spy();
    expect(await pass(f, card, 29, wake)).toBe("not_due");
    expect(await pass(f, card, 30, wake)).toBe("relaunched");
    expect(await pass(f, card, 119, wake)).toBe("manager_not_due");
    expect(await pass(f, card, 120, wake)).toBe("manager_asked");

    const off = await seed({ governance: { unansweredAgentQuestion: { enabled: false } } });
    const quiet = await ask(off);
    await readAndDidNotAnswer(off, quiet);
    const none = spy();
    expect(await pass(off, quiet, 600, none)).toBeNull();
    expect(none).not.toHaveBeenCalled();

    expect(readUnansweredQuestionSettings({})).toEqual({ relaunchAfterMs: 5 * 60_000, managerAfterMs: 15 * 60_000 });
    // The manager is never asked before the addressee's relaunch is due.
    expect(readUnansweredQuestionSettings({ unansweredAgentQuestion: { relaunchAfterMinutes: 20, managerAfterMinutes: 10 } }))
      .toEqual({ relaunchAfterMs: 20 * 60_000, managerAfterMs: 20 * 60_000 });
    // The company's update route takes the setting, and nothing else under that key.
    expect(updateCompanySchema.safeParse({ interactionResolverGovernance: { unansweredAgentQuestion: { enabled: true,
      relaunchAfterMinutes: 5, managerAfterMinutes: 15 } } }).success).toBe(true);
    expect(updateCompanySchema.safeParse({ interactionResolverGovernance: { unansweredAgentQuestion: { relaunchAfterMinutes: 0 } } }).success).toBe(false);
    expect(updateCompanySchema.safeParse({ interactionResolverGovernance: { unansweredAgentQuestion: { other: 1 } } }).success).toBe(false);
  });

  it("the question is answered while the manager's card still waits: the server withdraws its own card, and only that one", async () => {
    const f = await seed();
    const card = await ask(f);
    await readAndDidNotAnswer(f, card);
    const other = await ask(f);
    const wake = spy();
    expect(await pass(f, card, 5, wake)).toBe("relaunched");
    expect(await pass(f, card, 15, wake)).toBe("manager_asked");
    const asked = (await cardsOf(f)).find(row => row.idempotencyKey === unansweredQuestionManagerKey(card.id))!;
    // While the question waits, the manager's card stays.
    await pass(f, card, 16, wake);
    expect((await cardsOf(f)).find(row => row.id === asked.id)).toMatchObject({ status: "pending" });
    await db.update(issueThreadInteractions).set({ status: "answered", resolvedAt: after(card, 17) }).where(eq(issueThreadInteractions.id, card.id));
    const outcomes = await relaunchUnansweredAgentQuestions(db, { companyId: f.companyId, issueId: f.issueId, now: after(card, 18), wake: wake as never });
    expect(outcomes).toContainEqual({ interactionId: asked.id, outcome: "withdrawn" });
    const cards = await cardsOf(f);
    expect(cards.find(row => row.id === asked.id)).toMatchObject({ status: "cancelled", resolvedByAgentId: null, resolvedByUserId: null });
    expect(cards.find(row => row.id === card.id)).toMatchObject({ status: "answered" });
    // Another role's pending card on the same task is not touched.
    expect(cards.find(row => row.id === other.id)).toMatchObject({ status: "pending", result: null });
  });
});
