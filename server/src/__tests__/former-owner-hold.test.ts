import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, environmentLeases, heartbeatRuns,
  issueComments, issueRecoveryActions, issues, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { runningProcesses, type AdapterExecutionContext, type AdapterExecutionResult } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { getExecutionBlocker, legacyHoldReleasedForNewOwnerPredicate } from "../services/execution-blocker.js";
import { listExecutionHolds } from "../services/execution-hold.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (_context: AdapterExecutionContext): Promise<AdapterExecutionResult> => ({
    exitCode: 0, signal: null, timedOut: false, errorMessage: null,
    summary: "Assignee turn.", provider: "test", model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })) };
});

// STUDIO-0100: production, 23 Nov 2026, TR-165. The task had been reassigned on 22 Nov from the CTO to the Feedback
// Manager; the CTO's legacy run was cancelled ("Cancelled before issue reassignment") and its reconciliation action
// was settled as no longer current, with `automaticRecovery.replay = "blocked"`. On 23 Nov the Board put the task to
// work and wrote on it twice: every wake of the new assignee was saved `deferred_issue_execution` and nothing ever
// started. A person's message was refused because the stopped run is not the assignee's, and the Board's
// reconciliation is refused for the same reason: no route could release the task.
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("the hold a former assignee's cut run left on a task", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("former-owner-hold-");
    db = createDb(database.connectionString);
    heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
  });
  afterAll(async () => { await database?.cleanup(); });

  const CLOSED = "Recovery closed because the task's owner, execution, or status changed. No work was replayed.";
  /** The state of TR-165: the task is the Feedback Manager's; the CTO's cut run and its settled hold are still there. */
  async function seed(change: {
    run?: Partial<typeof heartbeatRuns.$inferInsert>; evidence?: Record<string, unknown>; cause?: string;
    action?: Partial<typeof issueRecoveryActions.$inferInsert>; task?: Partial<typeof issues.$inferInsert>;
    lease?: Partial<typeof environmentLeases.$inferInsert> | null; assignee?: "manager" | "cto";
  } = {}) {
    const companyId = randomUUID(), cto = randomUUID(), manager = randomUUID(), issueId = randomUUID(), ctoRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Former owner", defaultResponsibleUserId: "responsible-user",
      issuePrefix: `F${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: "responsible-user", name: "Fixture user", email: "responsible-user@example.test",
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user",
      status: "active", membershipRole: "member" });
    await db.insert(agents).values([cto, manager].map((id, index) => ({ id, companyId,
      name: index ? "Feedback Manager" : "CTO", role: "engineer", status: "active" as const, adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} })));
    await db.insert(issues).values({ id: issueId, companyId, title: "A bug of the list", status: "in_progress", priority: "medium",
      assigneeAgentId: change.assignee === "cto" ? cto : manager, ...change.task });
    // The CTO's legacy run, cancelled by the reassignment a day before; its process is gone.
    await db.insert(heartbeatRuns).values({ id: ctoRunId, companyId, agentId: cto, runtimeMode: "legacy",
      invocationSource: "assignment", status: "cancelled", errorCode: "issue_reassigned",
      startedAt: new Date(Date.now() - 26 * 3_600_000), finishedAt: new Date(Date.now() - 25 * 3_600_000),
      contextSnapshot: { issueId, taskId: issueId }, runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } },
      error: "Cancelled before issue reassignment", resultJson: { reassignmentStopConfirmed: true }, ...change.run });
    // The lease that run took, released.
    if (change.lease !== null) await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: ctoRunId,
      provider: "ssh", status: "released", releasedAt: new Date(Date.now() - 25 * 3_600_000), ...change.lease });
    // Its reconciliation action, settled as no longer current: nothing is replayed.
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      cause: change.cause ?? "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${ctoRunId}`,
      status: "resolved", outcome: "cancelled", resolvedAt: new Date(Date.now() - 25 * 3_600_000), ownerType: "board", nextAction: CLOSED,
      evidence: { runId: ctoRunId, automaticRecovery: { replay: "blocked" }, ...change.evidence }, ...change.action }).returning();
    return { companyId, cto, manager, issueId, ctoRunId, actionId: action!.id };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;

  /** The Board writes on the task: the wake of the comment route. */
  async function boardComment(f: Fixture, body = "Go on with this one.") {
    const commentId = randomUUID();
    await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId, authorType: "user",
      authorUserId: "responsible-user", body });
    await heartbeat.wakeup(f.manager, { source: "automation", triggerDetail: "system", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: "responsible-user",
      payload: { issueId: f.issueId, commentId }, contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeCommentId: commentId } }).catch(() => undefined);
    return commentId;
  }
  const runsOf = (f: Fixture, agentId: string) => db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, agentId),
      sql`${heartbeatRuns.id} <> ${f.ctoRunId}`));
  const heldWakes = async (f: Fixture) => (await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.agentId, f.manager),
    eq(agentWakeupRequests.status, "deferred_issue_execution"))));
  const waitOf = (wake: { payload: Record<string, unknown> | null }) => wake.payload?.executionWait as Record<string, unknown> | undefined;
  const executionsOf = (agentId: string) => mockAdapterExecute.mock.calls.filter(([context]) => context?.agent.id === agentId);
  async function managerStarts(f: Fixture, wakeCommentId?: string) {
    await vi.waitFor(async () => {
      expect((await runsOf(f, f.manager)).some(run => run.status === "succeeded")).toBe(true);
    }, { timeout: 20_000, interval: 100 });
    const started = (await runsOf(f, f.manager)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0]!;
    await heartbeat.waitForRunExecutionDrain(started.id);
    expect(started.contextSnapshot).toMatchObject({ issueId: f.issueId, ...(wakeCommentId ? { wakeCommentId } : {}) });
    expect(executionsOf(f.cto)).toHaveLength(0);
    return started;
  }

  it("does not hold the new assignee: nothing blocks the task, and a person's message starts the assignee", async () => {
    const f = await seed();
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    // Nothing is listed as holding the task either.
    expect((await listExecutionHolds(db, f.companyId, [f.issueId], () => null)).size).toBe(0);
    const commentId = await boardComment(f);
    expect(await heldWakes(f)).toEqual([]);
    await managerStarts(f, commentId);
  });

  it("the wakes that hold had deferred before the patch are re-admitted by the sweep, and the assignee starts", async () => {
    // While something still makes the hold the task's (here, a recovery the system has not finished), the Board's two
    // comments are deferred behind it, as on TR-165: a person's message refused because the run is not the assignee's.
    const f = await seed({ evidence: { systemRecovery: { state: "pending" } } });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ recoveryActionId: f.actionId,
      cause: "legacy_execution_requires_reconciliation", runId: f.ctoRunId });
    const first = await boardComment(f, "First note of the Board.");
    await boardComment(f, "Second note of the Board.");
    const held = await heldWakes(f);
    expect(held.map(wake => [wake.reason, waitOf(wake)?.recoveryActionId, waitOf(wake)?.reason]).sort()).toEqual([
      ["issue_commented", f.actionId, "source_unavailable"], ["issue_commented", f.actionId, "source_unavailable"]]);
    // The sweep leaves them while the hold is the task's.
    await heartbeat.resumeQueuedRuns();
    expect(await runsOf(f, f.manager)).toHaveLength(0);
    expect(await heldWakes(f)).toHaveLength(2);
    // The state of TR-165 when this patch is installed: the same hold, with nothing left to repair.
    await db.update(issueRecoveryActions).set({ evidence: { runId: f.ctoRunId, automaticRecovery: { replay: "blocked" } } })
      .where(eq(issueRecoveryActions.id, f.actionId));
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    await heartbeat.resumeQueuedRuns();
    const started = await managerStarts(f);
    expect(started.contextSnapshot).not.toHaveProperty("executionWait");
    expect([first, started.contextSnapshot?.wakeCommentId]).toContain(started.contextSnapshot?.wakeCommentId);
    // Each held wake is re-admitted in its turn, once: after the sweeps nothing is left waiting, and nothing starts twice.
    await vi.waitFor(async () => {
      await heartbeat.resumeQueuedRuns();
      expect(await heldWakes(f)).toEqual([]);
    }, { timeout: 30_000, interval: 300 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    // What became of the two held rows: the first was retired and re-admitted through ordinary admission; the other
    // was re-admitted in its turn, or folded into the wake of the same task that was already on its way.
    const after = (await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.agentId, f.manager)))).filter(wake => held.some(row => row.id === wake.id));
    expect(after).toHaveLength(2);
    for (const wake of after) expect(["skipped", "coalesced"], `${wake.status}: ${wake.error}`).toContain(wake.status);
    expect(after.filter(wake => wake.status === "skipped" && wake.error === "Re-admitted after the previous execution owner stopped").length)
      .toBeGreaterThanOrEqual(1);
    const runsAfter = (await runsOf(f, f.manager)).length;
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect((await runsOf(f, f.manager)).length).toBe(runsAfter);
    expect(executionsOf(f.cto)).toHaveLength(0);
  });

  it("still holds the task when the cut run is the assignee's own", async () => {
    const f = await seed({ assignee: "cto" });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ recoveryActionId: f.actionId,
      cause: "legacy_execution_requires_reconciliation", runId: f.ctoRunId });
    expect((await listExecutionHolds(db, f.companyId, [f.issueId], () => null)).get(f.issueId)).toMatchObject({ recoveryActionId: f.actionId });
  });

  it.each<[string, Parameters<typeof seed>[0]]>([
    ["the action says a folder is to be repaired (a restore failure)", { evidence: { workspaceRestoreFailure: "restore_unsafe_archive" } }],
    ["the action carries a workspace restore recovery", { evidence: { workspaceRestoreRecovery: { schema: "other" } } }],
    ["the action carries a system recovery", { evidence: { systemRecovery: { state: "pending" } } }],
    ["the run's result says a folder is to be repaired", { run: { resultJson: { workspaceRestoreFailure: "restore_failed" } } }],
    ["the run has no end recorded", { run: { finishedAt: null } }],
    ["a lease of the run is not released", { lease: { status: "active", releasedAt: null } }],
    ["the cleanup of a lease of the run failed", { lease: { cleanupStatus: "failed" } }],
    ["the run is a native run", { run: { runtimeMode: "native" } }],
    ["the hold is of another cause", { cause: "native_continuation_requires_reconciliation" }],
    ["the task has no agent assignee", { task: { assigneeAgentId: null } }],
  ])("still holds the task when %s", async (_name, change) => {
    const f = await seed(change);
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker, JSON.stringify(blocker)).not.toBeNull();
    // Whatever names the blocker gives it, the task is not free.
    expect(blocker).toMatchObject({ runId: f.ctoRunId });
  });

  // A lease the run still holds also holds the task by itself (the ownership blocker), which hides this rule's own
  // reading of the leases: it is read here on the rule itself, as the deferred-wake sweep reads it.
  it("the rule itself reads the run's leases: not released while one is held or its cleanup failed", async () => {
    const released = async (f: Fixture) => (await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.id, f.actionId), legacyHoldReleasedForNewOwnerPredicate()))).length === 1;
    expect(await released(await seed())).toBe(true);
    expect(await released(await seed({ lease: null }))).toBe(true);
    expect(await released(await seed({ lease: { status: "active", releasedAt: null } }))).toBe(false);
    expect(await released(await seed({ lease: { status: "pending_cleanup" } }))).toBe(false);
    expect(await released(await seed({ lease: { cleanupStatus: "failed" } }))).toBe(false);
    expect(await released(await seed({ assignee: "cto" }))).toBe(false);
  });

  it("still holds the task when the cut run's agent is the participant a pending review waits on", async () => {
    const companyOf = await seed();
    await db.update(issues).set({ status: "in_review", executionState: { status: "pending",
      currentParticipant: { type: "agent", agentId: companyOf.cto } } }).where(eq(issues.id, companyOf.issueId));
    expect(await getExecutionBlocker(db, companyOf.companyId, companyOf.issueId)).toMatchObject({ recoveryActionId: companyOf.actionId });
    // The review over, the same hold is a former participant's: released.
    await db.update(issues).set({ status: "in_progress", executionState: null }).where(eq(issues.id, companyOf.issueId));
    expect(await getExecutionBlocker(db, companyOf.companyId, companyOf.issueId)).toBeNull();
  });

  // TR-149, read in service on 23 Nov 2026: the same hold after a cut run, on a task that waits in backlog.
  it("a task in backlog that carries a former assignee's hold is free, and starts when a person takes it out of backlog", async () => {
    const f = await seed({ task: { status: "backlog" } });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    expect((await listExecutionHolds(db, f.companyId, [f.issueId], () => null)).size).toBe(0);
    // A person takes the task out of backlog: the wake the issue update route sends for that change.
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.issueId));
    await heartbeat.wakeup(f.manager, { source: "automation", triggerDetail: "system", reason: "issue_status_changed",
      payload: { issueId: f.issueId, mutation: "update" }, requestedByActorType: "user", requestedByActorId: "responsible-user",
      contextSnapshot: { issueId: f.issueId, source: "issue.status_change" } });
    expect(await heldWakes(f)).toEqual([]);
    await managerStarts(f);
  });

  it("a task in backlog whose cut run is the assignee's OWN stays held: that run's outcome is its agent's to settle", async () => {
    const f = await seed({ assignee: "cto", task: { status: "backlog" } });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ recoveryActionId: f.actionId,
      cause: "legacy_execution_requires_reconciliation", runId: f.ctoRunId });
  });

  it("is released as well when a person now owns the task", async () => {
    const f = await seed({ task: { assigneeAgentId: null, assigneeUserId: "responsible-user" } });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  });

  it("an ACTIVE hold of a former assignee's run is released the same way", async () => {
    const f = await seed({ action: { status: "active", outcome: null, resolvedAt: null }, evidence: { automaticRecovery: undefined } });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  });
});
