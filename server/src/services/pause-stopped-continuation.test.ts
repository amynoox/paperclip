import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, createDb, environmentLeases, heartbeatRunEvents, heartbeatRuns, issueComments, issueRecoveryActions, issues } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { heartbeatService } from "./heartbeat.js";
import { environmentService } from "./environments.js";
import { requestTaskRetry } from "./task-retry.js";

// STUDIO-0073: production, 18-19 Nov 2026. A pause cut the runs of a role (TR-1814, run 5f24df87: legacy, cancelled
// `agent_paused`, pauseStop manual, a recorded process that is gone, one local lease released). Each cut run left its
// hold, settled `resolved` with replay blocked, and after the resume no run of the role started.
// The cases below replay that run as it was read in the database. For it, a person's request (a message, or the
// Board's Retry since STUDIO-0070) already releases the hold. What stayed closed is the same run executed over an
// `ssh` lease: the built-in ssh driver gives no remote termination receipt, and the request waited for one for ever.
describe("a person's request after a run cut by a pause", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("pause-stopped-continuation-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { await temporary?.cleanup(); });

  const GONE_PID = 2_000_000_000;
  type Options = {
    lease?: "local" | "ssh" | "plugin";
    leaseReleased?: boolean;
    pid?: number | null;
    finishedMinutesAgo?: number;
    /** Replaces the pause's cancellation record. */
    resultJson?: Record<string, unknown>;
    errorCode?: string;
  };
  async function fixture(options: Options = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const cutRunId = randomUUID(), commentId = randomUUID();
    const finishedAt = new Date(Date.now() - (options.finishedMinutesAgo ?? 13 * 60) * 60_000);
    await db.insert(companies).values({ id: companyId, name: "Pause stop", issuePrefix: `P${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Dev", role: "engineer",
      adapterType: "claude_local", status: "idle", runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Cut by a pause", status: "todo", assigneeAgentId: agentId });
    const [cut] = await db.insert(heartbeatRuns).values({ id: cutRunId, companyId, agentId,
      invocationSource: "automation", triggerDetail: "system",
      status: "cancelled", runtimeMode: "legacy", executionStage: "settled", errorCode: options.errorCode ?? "agent_paused",
      error: "Cancelled due to agent pause", processPid: options.pid === undefined ? GONE_PID : options.pid,
      contextSnapshot: { issueId },
      startedAt: new Date(finishedAt.getTime() - 356_000), finishedAt,
      resultJson: options.resultJson ?? { cancellation: { reason: "Cancelled due to agent pause", source: "control_plane",
        expected: true, initiator: { type: "system" }, recordedAt: finishedAt.toISOString() },
        pauseStop: { holds: ["manual"], companyPauseReason: null }, stopReason: "paused",
        effectiveTimeoutSec: 0, timeoutConfigured: false, timeoutFired: false, timeoutSource: null } }).returning();
    const [hold] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${cutRunId}`,
      status: "resolved", outcome: "blocked", ownerType: "board", nextAction: "Automatic recovery stopped.",
      evidence: { runId: cutRunId, automaticRecovery: { policy: "preserve_without_replay_v1", runId: cutRunId, replay: "blocked", actionOutcome: "unknown" } } }).returning();
    const environment = await environmentService(db).ensureLocalEnvironment(companyId);
    const provider = options.lease ?? "local";
    await db.insert(environmentLeases).values({ companyId, environmentId: environment.id, heartbeatRunId: cutRunId, issueId,
      provider, ...(provider === "local" ? {} : { providerLeaseId: `${provider}://worker@mac-03:22/w/${cutRunId}`, cleanupStatus: "success" }),
      status: options.leaseReleased === false ? "active" : "expired", leasePolicy: "ephemeral",
      releasedAt: options.leaseReleased === false ? null : new Date(finishedAt.getTime() + 70_000),
      metadata: { agentId, driver: provider } });
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: cutRunId, seq: 1,
      eventType: "native.process_identity_recorded", stream: "system", level: "info", message: "identity" });
    await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorType: "user", authorUserId: "board",
      body: "Resume: the fleet is ready.", createdAt: new Date(Date.now() - 60_000) });
    // The agent is busy elsewhere: an admitted run stays queued instead of launching a provider.
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running" });
    return { companyId, agentId, issueId, cut: cut!, hold: hold!, commentId };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  /** The wake of a comment on the task, as the comment route asks for it. */
  const commentWake = (f: Fixture, actor: "user" | "agent" = "user", reason = "issue_commented") =>
    heartbeatService(db).wakeup(f.agentId, { source: "automation", triggerDetail: "system", reason,
      requestedByActorType: actor, requestedByActorId: actor === "user" ? "board" : f.agentId,
      payload: { issueId: f.issueId, commentId: f.commentId }, contextSnapshot: { issueId: f.issueId, wakeCommentId: f.commentId } });
  const wakes = (f: Fixture) => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))
    .orderBy(desc(agentWakeupRequests.createdAt));
  const continuations = async (f: Fixture) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
    .filter(run => run.contextSnapshot?.previousRunId === f.cut.id);
  async function expectContinued(f: Fixture) {
    const started = await continuations(f);
    expect(started, JSON.stringify((await wakes(f)).map(wake => ({ status: wake.status, wait: wake.payload?.executionWait })))).toHaveLength(1);
    expect(started[0]).toMatchObject({ agentId: f.agentId, status: "queued",
      contextSnapshot: { previousRunId: f.cut.id, explicitUserContinuation: { previousRunId: f.cut.id } } });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  }
  async function expectHeld(f: Fixture, reason: string) {
    expect(await continuations(f)).toHaveLength(0);
    const [wake] = await wakes(f);
    expect(wake).toMatchObject({ status: "deferred_issue_execution" });
    expect(wake.payload?.executionWait).toMatchObject({ reason, recoveryActionId: f.hold.id });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ recoveryActionId: f.hold.id });
  }

  describe("the run of production: a local lease, a recorded process that is gone", () => {
    it("continues on a person's message", async () => {
      const f = await fixture();
      await commentWake(f);
      await expectContinued(f);
    });

    it("keeps a person's message that arrives during the pause, and starts it at the resume", async () => {
      const f = await fixture();
      await db.update(agents).set({ status: "paused", pauseReason: "manual", pausedAt: new Date() }).where(eq(agents.id, f.agentId));
      await expect(commentWake(f, "user", "issue_reopened_via_comment")).rejects.toThrow(/not invokable/);
      expect(await continuations(f)).toHaveLength(0);
      await db.update(agents).set({ status: "idle", pauseReason: null, pausedAt: null }).where(eq(agents.id, f.agentId));
      await heartbeatService(db).resumeQueuedRuns();
      await expectContinued(f);
    });

    it("continues on the Board's Retry", async () => {
      const f = await fixture();
      const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "board",
        actorSource: "local_implicit", observedRunId: f.cut.id, idempotencyKey: randomUUID() });
      expect(receipt).toMatchObject({ accepted: true, stale: false });
      await heartbeatService(db).resumeTaskRetry(f.companyId, receipt.requestId!);
      await expectContinued(f);
    });

    it("keeps an agent's comment behind the hold", async () => {
      const f = await fixture();
      await commentWake(f, "agent");
      await expectHeld(f, "execution_recovery");
    });
  });

  describe("the same run over an ssh lease, which gets no termination receipt", () => {
    it("continues on a person's message, on the stop proof the pause itself accepted", async () => {
      const f = await fixture({ lease: "ssh" });
      await commentWake(f);
      await expectContinued(f);
    });

    it("continues on the Board's Retry", async () => {
      const f = await fixture({ lease: "ssh" });
      const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "board",
        actorSource: "local_implicit", observedRunId: f.cut.id, idempotencyKey: randomUUID() });
      expect(receipt).toMatchObject({ accepted: true, stale: false });
      await heartbeatService(db).resumeTaskRetry(f.companyId, receipt.requestId!);
      await expectContinued(f);
    });

    it("still waits for the environment while the local ssh client is alive", async () => {
      const f = await fixture({ lease: "ssh", pid: process.pid });
      await commentWake(f);
      await expectHeld(f, "remote_cleanup");
    });

    it("still waits when no ssh client was recorded", async () => {
      const f = await fixture({ lease: "ssh", pid: null });
      await commentWake(f);
      await expectHeld(f, "remote_cleanup");
    });

    it("still waits before the delay of the pause's proof has passed", async () => {
      const f = await fixture({ lease: "ssh", finishedMinutesAgo: 5 });
      await commentWake(f);
      await expectHeld(f, "remote_cleanup");
    });

    it("still waits while the lease is not released", async () => {
      const f = await fixture({ lease: "ssh", leaseReleased: false });
      await commentWake(f);
      await expectHeld(f, "remote_cleanup");
    });

    it("still waits while the agent's pause has not completed", async () => {
      const f = await fixture({ lease: "ssh" });
      await db.update(agents).set({ lifecycleState: "pausing" }).where(eq(agents.id, f.agentId));
      await commentWake(f);
      await expectHeld(f, "remote_cleanup");
    });

    it("still requires the receipt for a run that was not cut by a pause", async () => {
      const at = new Date(Date.now() - 13 * 3600_000).toISOString();
      const f = await fixture({ lease: "ssh", errorCode: "issue_reassigned",
        resultJson: { cancellation: { reason: "Cancelled because the task was reassigned", source: "control_plane",
          expected: true, initiator: { type: "system" }, recordedAt: at }, stopReason: "cancelled" } });
      await commentWake(f);
      await expectHeld(f, "remote_cleanup");
    });

    it("still requires the receipt on another remote provider", async () => {
      const f = await fixture({ lease: "plugin" });
      await commentWake(f);
      await expectHeld(f, "remote_cleanup");
    });
  });
});
