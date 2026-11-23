// STUDIO-0095: a wake that waits behind a scheduled retry is not left an orphan when that retry is cancelled.
//
// Production, 22 Nov 2026, TR-2562. A role ended two runs on its task without a disposition; the server scheduled a
// disposition repair (`scheduled_retry`). A card of the Board then named that task for its wake (STUDIO-0087): the
// wake waited behind the scheduled retry (`deferred_issue_execution`). When the retry came due, its gate cancelled it
// as superseded — by that very wake — and nothing promoted the wake: the task had no run and no lock left, the role
// was idle, and the wake waited for ever. The periodic pass over waiting wakes selected it and then left it, because
// it looked for the card on the wake's task and the card is on another one.
//
// The cases play it on real heartbeat runs with a stand-in adapter.
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueThreadInteractions,
  issues, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { addresseeWakeTarget } from "../services/addressee-wake-issue.js";
import { heartbeatService } from "../services/heartbeat.js";
import { recoveryService } from "../services/recovery/service.js";
import { scheduledRetrySuppressionReceipt } from "../services/suppressed-scheduled-retry.js";

const adapterType = "codex_local";
const support = await getEmbeddedPostgresTestSupport();
vi.setConfig({ testTimeout: 120_000 });

(support.supported ? describe : describe.skip)("a wake that waits behind a scheduled retry the gate cancels", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  type Launch = { issueId: string; runId: string; context: Record<string, unknown> };
  const launches: Launch[] = [];
  const SUCCESS = { exitCode: 0, signal: null, timedOut: false, resultJson: {} };

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("orphan-deferred-wake-");
    db = createDb(database.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: adapterType, supportsLocalAgentJwt: false,
      // The role ends each run well and sets no disposition on its task, as in production.
      execute: async (input) => {
        launches.push({ issueId: String(input.context.issueId), runId: input.runId, context: input.context as Record<string, unknown> });
        return SUCCESS as never;
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(async () => {
    // Nothing is left to start by itself after a case: the retries the product schedules for a task without a
    // disposition are cancelled.
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.status, "scheduled_retry"));
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    launches.length = 0;
  });
  afterAll(async () => {
    unregisterServerAdapter(adapterType);
    await database?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), otherAgentId = randomUUID(), ownIssueId = randomUUID(), cardIssueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Orphan wake", issuePrefix: `O${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user" });
    await db.insert(authUsers).values({ id: "responsible-user", name: "Fixture user", email: "responsible-user@example.test",
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user",
      status: "active", membershipRole: "member" }).onConflictDoNothing();
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Game Designer", role: "engineer", status: "idle", adapterType, adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} },
      { id: otherAgentId, companyId, name: "Super RH", role: "engineer", status: "paused", adapterType, adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} },
    ]);
    await db.insert(issues).values([
      { id: ownIssueId, companyId, title: "The addressee's own task", status: "in_progress", priority: "medium", assigneeAgentId: agentId },
      { id: cardIssueId, companyId, title: "The task the card is on", status: "in_progress", priority: "medium", assigneeAgentId: otherAgentId },
    ]);
    return { companyId, agentId, otherAgentId, ownIssueId, cardIssueId };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;
  const runsOf = (f: Fixture) => db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, f.agentId))).orderBy(asc(heartbeatRuns.createdAt));
  const wakesOf = (f: Fixture) => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))
    .orderBy(asc(agentWakeupRequests.requestedAt));
  const state = async (f: Fixture) => JSON.stringify({
    launches: launches.filter((launch) => launch.issueId === f.ownIssueId).map((launch) => launch.context.wakeReason ?? null),
    runs: (await runsOf(f)).map((run) => [run.status, run.errorCode, (run.contextSnapshot as Record<string, unknown> | null)?.wakeReason ?? null]),
    wakes: (await wakesOf(f)).map((wake) => [wake.status, wake.reason, wake.error]),
    task: (await db.select().from(issues).where(eq(issues.id, f.ownIssueId))).map((issue) => [issue.status, issue.executionRunId]),
  });

  /**
   * The role ended a run on its task without a disposition, and again the repair run the product gave it: the product
   * then schedules the next repair (`scheduled_retry`, `issue_disposition_repair`). The product's own recovery service
   * decides it, and its wakes go through the real queue.
   */
  async function repairScheduled(f: Fixture) {
    const recovery = recoveryService(db, { enqueueWakeup: (agentId, opts) => heartbeat.wakeup(agentId, opts as never) as never });
    const [ended] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "on_demand",
      status: "succeeded", runtimeMode: "legacy", finishedAt: new Date(), contextSnapshot: { issueId: f.ownIssueId },
      livenessState: "blocked", resultJson: { summary: "All done. Need approval. I will continue." } } as never).returning();
    await recovery.reconcileLegacyContinuation(ended!.id);
    // The first repair run really runs, and ends without a disposition too.
    let first: typeof heartbeatRuns.$inferSelect | undefined;
    await vi.waitFor(async () => {
      first = (await runsOf(f)).find((run) => run.id !== ended!.id
        && (run.contextSnapshot as Record<string, unknown> | null)?.wakeReason === "issue_disposition_repair");
      expect(first?.status, await state(f)).toBe("succeeded");
    }, { timeout: 30_000, interval: 250 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    if (!(await runsOf(f)).some((run) => run.status === "scheduled_retry")) await recovery.reconcileLegacyContinuation(first!.id);
    const scheduled = (await runsOf(f)).find((run) => run.status === "scheduled_retry");
    expect(scheduled, await state(f)).toBeDefined();
    expect(scheduled!.contextSnapshot).toMatchObject({ issueId: f.ownIssueId, wakeReason: "issue_disposition_repair" });
    return scheduled!;
  }
  /** A card of the Board on another task, addressed to the role, whose wake names the role's own task (STUDIO-0087). */
  async function cardNamingOwnTask(f: Fixture) {
    const [card] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.cardIssueId,
      kind: "ask_user_questions", status: "pending", addresseeAgentId: f.agentId, createdByUserId: "responsible-user",
      title: "Which build do we ship?", continuationPolicy: "none",
      payload: { version: 1, questions: [{ id: "build", prompt: "Which build do we ship?", selectionMode: "single",
        options: [{ id: "a", label: "3061" }, { id: "b", label: "3062" }] }] } as never }).returning();
    // The wake, as the card's creation route writes it.
    const target = addresseeWakeTarget(f.cardIssueId, f.ownIssueId);
    await heartbeat.wakeup(f.agentId, {
      source: "automation", triggerDetail: "system", reason: "interaction_pending",
      payload: { issueId: target.issueId, interactionId: card!.id, interactionKind: card!.kind, sourceCommentId: null, sourceRunId: null,
        mutation: "interaction" },
      idempotencyKey: `interaction-pending:${card!.id}`, requestedByActorType: "user", requestedByActorId: "responsible-user",
      contextSnapshot: { issueId: target.issueId, taskId: target.issueId, ...target.context, interactionId: card!.id,
        interactionKind: card!.kind, sourceCommentId: null, sourceRunId: null, wakeReason: "interaction_pending",
        source: "issue.interaction.created" },
    });
    const wake = (await wakesOf(f)).find((row) => row.idempotencyKey === `interaction-pending:${card!.id}`);
    return { card: card!, wake: wake! };
  }
  const wakeNow = async (id: string) => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0]!;
  const cardLaunches = (f: Fixture, cardId: string) => launches.filter((launch) => launch.issueId === f.ownIssueId
    && launch.context.interactionId === cardId);
  const due = (runId: string) => db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(Date.now() - 60_000) }).where(eq(heartbeatRuns.id, runId));

  it("the retry comes due and its gate cancels it as superseded by the waiting wake: that wake starts", async () => {
    const f = await seed();
    const retry = await repairScheduled(f);
    const { card, wake } = await cardNamingOwnTask(f);
    // The card's wake waits behind the scheduled retry.
    expect(wake, await state(f)).toMatchObject({ status: "deferred_issue_execution" });
    expect(cardLaunches(f, card.id)).toHaveLength(0);

    await due(retry.id);
    await heartbeat.promoteDueScheduledRetries();
    const [cancelled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retry.id));
    expect(cancelled, await state(f)).toMatchObject({ status: "cancelled", errorCode: "issue_disposition_repair_superseded" });

    // The wake that superseded the retry is promoted by that cancellation: no other pass is called here.
    await vi.waitFor(async () => expect(cardLaunches(f, card.id).length, await state(f)).toBe(1), { timeout: 30_000, interval: 100 });
    expect(cardLaunches(f, card.id)[0]!.context).toMatchObject({ issueId: f.ownIssueId, interactionId: card.id,
      interactionIssueId: f.cardIssueId, wakeReason: "interaction_pending" });
    expect((await wakeNow(wake.id)).status).not.toBe("deferred_issue_execution");
  });

  it("the same when a person asks for the scheduled retry now: the waiting wake starts", async () => {
    const f = await seed();
    const retry = await repairScheduled(f);
    const { card, wake } = await cardNamingOwnTask(f);
    expect(wake, await state(f)).toMatchObject({ status: "deferred_issue_execution" });

    expect(await heartbeat.retryScheduledRetryNow({ issueId: f.ownIssueId, actor: { actorType: "user", actorId: "responsible-user" } }))
      .toMatchObject({ outcome: "gate_suppressed" });
    const [cancelled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retry.id));
    expect(cancelled, await state(f)).toMatchObject({ status: "cancelled", errorCode: "issue_disposition_repair_superseded" });
    await vi.waitFor(async () => expect(cardLaunches(f, card.id).length, await state(f)).toBe(1), { timeout: 30_000, interval: 100 });
    expect((await wakeNow(wake.id)).status).not.toBe("deferred_issue_execution");
  });

  it("a card's wake left waiting on the addressee's own task with no run left in front of it is taken up by the periodic pass", async () => {
    const f = await seed();
    const retry = await repairScheduled(f);
    const { card, wake } = await cardNamingOwnTask(f);
    expect(wake, await state(f)).toMatchObject({ status: "deferred_issue_execution" });
    // The run in front is gone without the release that promotes what waited behind it (the state production was
    // left in on 22 Nov 2026; a server stopped between the two writes leaves the same).
    const now = new Date();
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: now, errorCode: "issue_disposition_repair_superseded",
      error: "Scheduled disposition repair suppressed because the source state changed or gained a durable path",
      resultJson: scheduledRetrySuppressionReceipt("issue_disposition_repair_superseded") })
      .where(eq(heartbeatRuns.id, retry.id));
    await db.update(issues).set({ executionRunId: null, executionAgentNameKey: null, executionLockedAt: null })
      .where(and(eq(issues.id, f.ownIssueId), eq(issues.executionRunId, retry.id)));
    expect(cardLaunches(f, card.id)).toHaveLength(0);
    expect((await wakeNow(wake.id)).status).toBe("deferred_issue_execution");

    await vi.waitFor(async () => {
      await heartbeat.resumeQueuedRuns();
      expect(cardLaunches(f, card.id).length, await state(f)).toBe(1);
    }, { timeout: 30_000, interval: 500 });
    expect(cardLaunches(f, card.id)[0]!.context).toMatchObject({ issueId: f.ownIssueId, interactionId: card.id, interactionIssueId: f.cardIssueId });
    expect((await wakeNow(wake.id)).status).not.toBe("deferred_issue_execution");
  });

  it("a card that is no longer pending is not started by the pass: its waiting wake is left as it was", async () => {
    const f = await seed();
    const retry = await repairScheduled(f);
    const { card, wake } = await cardNamingOwnTask(f);
    await db.update(issueThreadInteractions).set({ status: "cancelled", resolvedAt: new Date() }).where(eq(issueThreadInteractions.id, card.id));
    const now = new Date();
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: now, errorCode: "issue_disposition_repair_superseded",
      resultJson: scheduledRetrySuppressionReceipt("issue_disposition_repair_superseded") })
      .where(eq(heartbeatRuns.id, retry.id));
    await db.update(issues).set({ executionRunId: null, executionAgentNameKey: null, executionLockedAt: null })
      .where(and(eq(issues.id, f.ownIssueId), eq(issues.executionRunId, retry.id)));
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await heartbeat.resumeQueuedRuns();
    expect(cardLaunches(f, card.id), await state(f)).toHaveLength(0);
    expect((await wakeNow(wake.id)).status).toBe("deferred_issue_execution");
  });
});
