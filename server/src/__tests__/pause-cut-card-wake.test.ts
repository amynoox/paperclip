import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issueThreadInteractions, issues, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { PAUSE_MISSED_WAKE_REASON, replayWakesMissedDuringPause } from "../services/pause-missed-wakes.js";
import { AGENT_PAUSE_STOP_REASON } from "../services/governance-pause-stop.js";

// STUDIO-0105: production, 26 Nov 2026, TR-3106. The task's assignee (CTO) created a question card addressed to the
// Feedback Manager; the card's wake was promoted to a run (`issue_execution_promoted`), the pause route cancelled that
// run (`agent_paused`), and at the resume nothing woke the addressee: the card stayed pending. A manual wake of the
// addressee on the task was cancelled at once as `issue_assignee_changed`.
describe("a card wake whose run the pause cut", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("pause-cut-card-wake-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function cardRunCutByPause(options: { addresseeOwnsTask?: boolean } = {}) {
    const companyId = randomUUID(), addressee = randomUUID(), owner = randomUUID(), issueId = randomUUID(), interactionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Pause", defaultResponsibleUserId: "board", issuePrefix: `C${companyId.slice(0, 6)}` });
    await db.insert(agents).values([
      { id: addressee, companyId, name: "Feedback", adapterType: "process", status: "running", permissions: {} },
      { id: owner, companyId, name: "CTO", adapterType: "process", status: "idle", permissions: {} },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Feedback", status: "in_progress",
      assigneeAgentId: options.addresseeOwnsTask ? addressee : owner });
    await db.insert(issueThreadInteractions).values({ id: interactionId, companyId, issueId, kind: "ask_user_questions",
      status: "pending", continuationPolicy: "wake_assignee", addresseeAgentId: addressee, createdByAgentId: owner,
      payload: { version: 1, questions: [] } as never });
    // The card's wake, promoted to a run, as the wake queue leaves it (finalizePromotedWake: queued, runId set).
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId: addressee, source: "automation",
      triggerDetail: "system", reason: "issue_execution_promoted", status: "queued",
      payload: { issueId, mutation: "interaction", interactionId, interactionKind: "ask_user_questions" } }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: addressee, invocationSource: "automation",
      triggerDetail: "system", status: "queued", wakeupRequestId: wake.id,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "interaction_pending", interactionId, interactionKind: "ask_user_questions" } }).returning();
    await db.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, wake.id));
    // POST /api/agents/:id/pause: the agent is paused, its runs are cancelled.
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, addressee));
    await heartbeatService(db).cancelActiveForAgent(addressee);
    const [cancelledWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
    const [cancelledRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    // POST /api/agents/:id/resume.
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, addressee));
    return { companyId, addressee, owner, issueId, interactionId, wake: cancelledWake, run: cancelledRun };
  }

  it("leaves the wake cancelled with its run, as in production", async () => {
    const f = await cardRunCutByPause();
    expect(f.run).toEqual(expect.objectContaining({ status: "cancelled", errorCode: "agent_paused" }));
    expect(f.wake).toEqual(expect.objectContaining({ status: "cancelled", error: AGENT_PAUSE_STOP_REASON, runId: f.run.id }));
  });

  it("wakes the addressee once again at the resume, with the card's wake", async () => {
    const f = await cardRunCutByPause();
    const wakeup = vi.fn().mockResolvedValue(null);
    expect(await replayWakesMissedDuringPause(db, { companyId: f.companyId, agentId: f.addressee, wakeup })).toEqual({ issues: 1, woken: 1 });
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith(f.addressee, expect.objectContaining({
      reason: PAUSE_MISSED_WAKE_REASON,
      idempotencyKey: `pause-missed:${f.addressee}:${f.issueId}:${f.wake.id}`,
      payload: { issueId: f.issueId, mutation: "interaction", interactionId: f.interactionId,
        interactionKind: "ask_user_questions", missedWakeRequestId: f.wake.id },
      contextSnapshot: expect.objectContaining({ issueId: f.issueId, wakeReason: "interaction_pending", interactionId: f.interactionId }),
    }));
  });

  it("delivers it through the real queue once, not cancelled as issue_assignee_changed", async () => {
    const f = await cardRunCutByPause();
    const heartbeat = heartbeatService(db);
    const wakeup = (agentId: string, opts: Parameters<typeof heartbeat.wakeup>[1]) => heartbeat.wakeup(agentId, opts).catch(() => null);
    await replayWakesMissedDuringPause(db, { companyId: f.companyId, agentId: f.addressee, wakeup: wakeup as never });
    await replayWakesMissedDuringPause(db, { companyId: f.companyId, agentId: f.addressee, wakeup: wakeup as never });
    await new Promise(resolve => setTimeout(resolve, 500));
    const replayed = (await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.agentId, f.addressee)))).filter(w => w.reason === PAUSE_MISSED_WAKE_REASON);
    expect(replayed).toHaveLength(1);
    expect(replayed[0].status).not.toBe("skipped");
    expect(replayed[0].error ?? "").not.toContain("assignee changed");
    const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      eq(heartbeatRuns.agentId, f.addressee)));
    expect(runs.filter(run => run.errorCode === "issue_assignee_changed")).toEqual([]);
    await heartbeat.drainActiveRunExecutions?.();
  });

  it("still wakes it after a manual wake that dispatch cancelled as issue_assignee_changed", async () => {
    const f = await cardRunCutByPause();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.addressee, invocationSource: "on_demand",
      status: "cancelled", errorCode: "issue_assignee_changed", createdAt: new Date(Date.now() + 1000), finishedAt: new Date(Date.now() + 1000),
      contextSnapshot: { issueId: f.issueId } });
    const wakeup = vi.fn().mockResolvedValue(null);
    await replayWakesMissedDuringPause(db, { companyId: f.companyId, agentId: f.addressee, wakeup });
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("adds no wake when one for the task is already queued", async () => {
    const f = await cardRunCutByPause();
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.addressee, source: "automation",
      reason: "interaction_pending", status: "queued", payload: { issueId: f.issueId, interactionId: f.interactionId } });
    const wakeup = vi.fn().mockResolvedValue(null);
    await replayWakesMissedDuringPause(db, { companyId: f.companyId, agentId: f.addressee, wakeup });
    expect(wakeup).not.toHaveBeenCalled();
  });

  it.each([
    { label: "the card is answered", change: { status: "answered" } },
    { label: "the card is addressed to another agent now", change: "owner" as const },
  ])("does not wake the agent when $label", async ({ change }) => {
    const f = await cardRunCutByPause();
    await db.update(issueThreadInteractions).set(change === "owner" ? { addresseeAgentId: f.owner } : change as never)
      .where(eq(issueThreadInteractions.id, f.interactionId));
    const wakeup = vi.fn().mockResolvedValue(null);
    await replayWakesMissedDuringPause(db, { companyId: f.companyId, agentId: f.addressee, wakeup });
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("leaves a cut run on the agent's own task to the continuation of cut runs (STUDIO-0074)", async () => {
    const f = await cardRunCutByPause({ addresseeOwnsTask: true });
    const wakeup = vi.fn().mockResolvedValue(null);
    await replayWakesMissedDuringPause(db, { companyId: f.companyId, agentId: f.addressee, wakeup });
    expect(wakeup).not.toHaveBeenCalled();
  });
});
