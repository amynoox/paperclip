import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns,
  issueRecoveryActions, issueThreadInteractions, issues, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { runningProcesses, type AdapterExecutionContext, type AdapterExecutionResult } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { buildHostServices } from "../services/plugin-host-services.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (_context: AdapterExecutionContext): Promise<AdapterExecutionResult> => ({
    exitCode: 0, signal: null, timedOut: false, errorMessage: null,
    summary: "Responder turn.", provider: "test", model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })) };
});

// STUDIO-0040: production, 14 Nov 2026, TR-702 (blocked, assigned to the Unity
// developer). The Board cancelled the developer's run around 01:40 UTC; its
// recovery action was resolved with `automaticRecovery.replay = "blocked"`.
// At 01:46:01 the Worker Router created an "Executor run interrupted" card
// addressed to the CTO. The CTO's wake was recorded (STUDIO-0026) but parked
// as `deferred_issue_execution` behind that hold and never started, although
// the CTO only answers the card and its answer decides the reconciliation.
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("question wake of a non-assignee responder past a recovery hold", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("addressee-wake-recovery-hold-");
    db = createDb(database.connectionString);
    heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
  });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), assignee = randomUUID(), responder = randomUUID(), issueId = randomUUID();
    const sourceRunId = randomUUID(), actionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Held task", defaultResponsibleUserId: "responsible-user",
      issuePrefix: `H${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: "responsible-user", name: "Fixture user", email: "responsible-user@example.test",
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user",
      status: "active", membershipRole: "member" });
    await db.insert(agents).values([assignee, responder].map((id, index) => ({ id, companyId,
      name: index ? "CTO" : "Dev Unity", role: "engineer", status: "active" as const, adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} })));
    await db.insert(issues).values({ id: issueId, companyId, title: "Routed task", status: "blocked", priority: "medium",
      assigneeAgentId: assignee });
    // The assignee's run the Board cancelled after it had started.
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId: assignee, runtimeMode: "legacy",
      invocationSource: "assignment", status: "cancelled", errorCode: "cancelled",
      startedAt: new Date(Date.now() - 6 * 60_000), finishedAt: new Date(Date.now() - 5 * 60_000),
      contextSnapshot: { issueId, taskId: issueId },
      resultJson: { cancellation: { source: "operator", expected: true, reason: "Cancelled by the board" } } });
    // Its recovery action: resolved, but preserved without replay.
    await db.insert(issueRecoveryActions).values({ id: actionId, companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation",
      fingerprint: `legacy-execution:${sourceRunId}`, status: "resolved", outcome: "blocked", ownerType: "board",
      nextAction: "Inspect the stopped work.",
      evidence: { runId: sourceRunId, legacyCancellationBlock: { runId: sourceRunId, statusVersion: 1, previousStatus: "in_progress" },
        automaticRecovery: { policy: "preserve_without_replay_v1", runId: sourceRunId, replay: "blocked",
          actionOutcome: "unknown", recordedAt: new Date().toISOString() } } });
    expect(await getExecutionBlocker(db, companyId, issueId))
      .toMatchObject({ recoveryActionId: actionId, cause: "legacy_execution_requires_reconciliation" });
    return { companyId, assignee, responder, issueId, sourceRunId, actionId };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;

  async function insertCard(f: Fixture, addresseeAgentId: string, status: "pending" | "accepted" = "pending") {
    const [card] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
      kind: "request_confirmation", status, continuationPolicy: "wake_assignee",
      requestedResolverPolicy: "anyone", effectiveResolverPolicy: "anyone", title: "Executor run interrupted",
      addresseeAgentId, payload: { version: 1, prompt: "Keep the reservation or organize verification?" },
      ...(status === "pending" ? {} : { resolvedAt: new Date(), result: { version: 1 as const, outcome: status } }),
    }).returning();
    return card.id;
  }

  // Same call as the issue interaction route (routes/issues.ts, interaction creation).
  function routeWake(f: Fixture, agentId: string, interactionId: string) {
    return heartbeat.wakeup(agentId, {
      source: "automation", triggerDetail: "system", reason: "interaction_pending",
      payload: { issueId: f.issueId, interactionId, interactionKind: "request_confirmation", sourceCommentId: null,
        sourceRunId: null, mutation: "interaction" },
      idempotencyKey: `interaction-pending:${interactionId}`,
      requestedByActorType: "user", requestedByActorId: "responsible-user",
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, interactionId, interactionKind: "request_confirmation",
        sourceCommentId: null, sourceRunId: null, wakeReason: "interaction_pending", source: "issue.interaction.created" },
    });
  }

  const runsOf = (f: Fixture, agentId: string) => db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, agentId)));
  const wakesOf = (f: Fixture, agentId: string) => db.select().from(agentWakeupRequests)
    .where(and(eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.agentId, agentId)));
  const executionsOf = (agentId: string) => mockAdapterExecute.mock.calls.filter(([context]) => context?.agent.id === agentId);

  async function settledResponderRun(f: Fixture) {
    await vi.waitFor(async () => {
      const runs = await runsOf(f, f.responder);
      expect(runs.map(run => run.status)).toEqual(["succeeded"]);
    }, { timeout: 15_000, interval: 100 });
    const [run] = await runsOf(f, f.responder);
    await heartbeat.waitForRunExecutionDrain(run.id);
    return run;
  }

  // What the responder's turn sees: its card, not the interrupted execution.
  async function expectAnswerOnly(f: Fixture, run: typeof heartbeatRuns.$inferSelect, interactionId: string) {
    expect(run).toMatchObject({ agentId: f.responder, retryOfRunId: null, errorCode: null,
      contextSnapshot: expect.objectContaining({ issueId: f.issueId, wakeReason: "interaction_pending", interactionId }) });
    for (const key of ["recoveryActionId", "previousRunId", "explicitUserContinuation", "workspaceReconstructionActionId",
      "forceFreshSession"]) expect(run.contextSnapshot).not.toHaveProperty(key);
    expect(executionsOf(f.responder)).toHaveLength(1);
    expect(executionsOf(f.assignee)).toHaveLength(0);
    expect(await runsOf(f, f.assignee)).toHaveLength(1);
    // The task and its hold are unchanged: reconciliation remains the Board's.
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0])
      .toMatchObject({ status: "blocked", assigneeAgentId: f.assignee, checkoutRunId: null });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ recoveryActionId: f.actionId });
  }

  it("runs the responder of a plugin-created card on a held task", async () => {
    const f = await seed();
    const host = buildHostServices(db, "worker-router-test", "worker-router-test", {
      forPlugin: () => ({ emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() }),
    } as any);
    try {
      const card = await host.issues.createInteraction({ companyId: f.companyId, issueId: f.issueId,
        interaction: { kind: "request_confirmation", addresseeAgentId: f.responder, resolverPolicy: "anyone",
          idempotencyKey: `interruption/${randomUUID()}`, title: "Executor run interrupted",
          payload: { version: 1, prompt: "The executor was interrupted. Keep the reservation or organize verification." } },
      } as any);
      const run = await settledResponderRun(f);
      const [wake] = await wakesOf(f, f.responder);
      expect(wake).toMatchObject({ reason: "interaction_pending", status: "completed", runId: run.id,
        idempotencyKey: `interaction-pending:${card.id}` });
      await expectAnswerOnly(f, run, card.id);
    } finally { host.dispose(); }
  });

  it("runs the responder of a route-created card on a held task", async () => {
    const f = await seed();
    const cardId = await insertCard(f, f.responder);
    const queued = await routeWake(f, f.responder, cardId);
    expect(queued).toMatchObject({ agentId: f.responder, status: "queued" });
    const run = await settledResponderRun(f);
    expect(run.id).toBe(queued!.id);
    expect((await wakesOf(f, f.responder)).map(wake => wake.status)).toEqual(["completed"]);
    await expectAnswerOnly(f, run, cardId);
  });

  it("runs an already queued responder turn instead of cancelling it at claim", async () => {
    const f = await seed();
    const cardId = await insertCard(f, f.responder);
    const wakeId = randomUUID(), runId = randomUUID();
    const context = { issueId: f.issueId, taskId: f.issueId, interactionId: cardId, interactionKind: "request_confirmation",
      wakeReason: "interaction_pending", mutation: "interaction", source: "issue.interaction.created" };
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: f.companyId, agentId: f.responder,
      source: "automation", triggerDetail: "system", reason: "interaction_pending", status: "queued", runId,
      requestedByActorType: "system", payload: { issueId: f.issueId, interactionId: cardId, mutation: "interaction" } });
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.responder,
      invocationSource: "automation", triggerDetail: "system", status: "queued", wakeupRequestId: wakeId,
      contextSnapshot: context });
    await heartbeat.resumeQueuedRuns();
    const run = await settledResponderRun(f);
    expect(run.id).toBe(runId);
    await expectAnswerOnly(f, run, cardId);
  });

  it("delivers a question wake already parked behind the hold, once", async () => {
    const f = await seed();
    const cardId = await insertCard(f, f.responder);
    const [parked] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.responder,
      source: "automation", triggerDetail: "system", reason: "interaction_pending", status: "deferred_issue_execution",
      requestedByActorType: "system", requestedByActorId: "worker-router-test",
      idempotencyKey: `interaction-pending:${cardId}`,
      payload: { issueId: f.issueId, interactionId: cardId, interactionKind: "request_confirmation", mutation: "interaction",
        pluginId: "worker-router-test",
        executionWait: { recoveryActionId: f.actionId, reason: "execution_recovery",
          message: "Waiting for execution recovery. Your message is saved." },
        _paperclipWakeContext: { issueId: f.issueId, taskId: f.issueId, interactionId: cardId,
          interactionKind: "request_confirmation", wakeReason: "interaction_pending", mutation: "interaction" } },
    }).returning();
    await heartbeat.resumeQueuedRuns();
    const run = await settledResponderRun(f);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, parked.id)))[0])
      .toMatchObject({ status: "coalesced", runId: run.id });
    await expectAnswerOnly(f, run, cardId);
    expect(run.contextSnapshot).not.toHaveProperty("executionWait");
    await heartbeat.resumeQueuedRuns();
    expect(await runsOf(f, f.responder)).toHaveLength(1);
    expect(executionsOf(f.responder)).toHaveLength(1);
  });

  it("keeps holding the assignee, including the assignee's own card", async () => {
    const f = await seed();
    const cardId = await insertCard(f, f.assignee);
    expect(await routeWake(f, f.assignee, cardId)).toBeNull();
    expect(await heartbeat.wakeup(f.assignee, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      requestedByActorType: "system", payload: { issueId: f.issueId } })).toBeNull();
    await heartbeat.resumeQueuedRuns();
    expect(await runsOf(f, f.assignee)).toHaveLength(1);
    expect(executionsOf(f.assignee)).toHaveLength(0);
    const [cardWake] = (await wakesOf(f, f.assignee)).filter(wake => wake.reason === "interaction_pending");
    expect(cardWake).toMatchObject({ status: "deferred_issue_execution",
      payload: expect.objectContaining({ executionWait: expect.objectContaining({ recoveryActionId: f.actionId }) }) });
  });

  it("keeps holding a responder whose card was already answered", async () => {
    const f = await seed();
    const cardId = await insertCard(f, f.responder, "accepted");
    expect(await routeWake(f, f.responder, cardId)).toBeNull();
    await heartbeat.resumeQueuedRuns();
    expect(await runsOf(f, f.responder)).toHaveLength(0);
    expect(executionsOf(f.responder)).toHaveLength(0);
    expect((await wakesOf(f, f.responder)).every(wake => wake.status !== "queued" && wake.runId === null)).toBe(true);
  });
});
