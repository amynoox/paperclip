import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issueThreadInteractions, issues, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { PAUSE_MISSED_WAKE_REASON, replayWakesMissedDuringPause } from "../services/pause-missed-wakes.js";
import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import { AGENT_LIFECYCLE_STOP_REASON } from "../services/governance-pause-stop.js";

// STUDIO-0028: production, 13 Nov 2026. During the 19:20–20:08 pause the
// Quality Manager received three wakes on TR-29 (another agent's comments, a
// resolved dependency); each was recorded as skipped and none was replayed,
// so the task waited until an operator note. Only people's comments were saved.
describe("wakes missed during an agent pause", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("pause-missed-wakes-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed(status = "in_progress") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Pause", defaultResponsibleUserId: "board", issuePrefix: `P${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Quality", adapterType: "process", status: "paused", permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "QA", status, assigneeAgentId: agentId });
    return { companyId, agentId, issueId };
  }

  // A real system wake refused by the pause, as the dependency reconciler sends it.
  async function refuseDuringPause(f: { companyId: string; agentId: string; issueId: string }) {
    await heartbeatService(db).wakeup(f.agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_blockers_resolved",
      payload: { issueId: f.issueId, mutation: "blocker_done" },
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_blockers_resolved", source: "issue.blockers_resolved" },
      requestedByActorType: "system", requestedByActorId: "dependency-test",
    }).catch(() => null);
    return db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.agentId, f.agentId)));
  }

  it("records the refused wake as skipped, then wakes the agent once per task when the pause lifts", async () => {
    const f = await seed();
    const refused = await refuseDuringPause(f);
    expect(refused).toEqual([expect.objectContaining({ status: "skipped", reason: "agent.not_invokable" })]);
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
    const wakeup = vi.fn().mockResolvedValue(null);
    expect(await replayWakesMissedDuringPause(db, { companyId: f.companyId, agentId: f.agentId, wakeup })).toEqual({ issues: 1, woken: 1 });
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith(f.agentId, expect.objectContaining({
      reason: PAUSE_MISSED_WAKE_REASON,
      idempotencyKey: `pause-missed:${f.agentId}:${f.issueId}:${refused[0].id}`,
      payload: expect.objectContaining({ issueId: f.issueId, missedWakeRequestId: refused[0].id }),
    }));
  });

  it("delivers the replayed wake through the real queue exactly once across repeated resumes", async () => {
    const f = await seed();
    await refuseDuringPause(f);
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
    const heartbeat = heartbeatService(db);
    const wakeup = (agentId: string, opts: Parameters<typeof heartbeat.wakeup>[1]) => heartbeat.wakeup(agentId, opts).catch(() => null);
    await replayWakesMissedDuringPause(db, { companyId: f.companyId, agentId: f.agentId, wakeup: wakeup as never });
    await replayWakesMissedDuringPause(db, { companyId: f.companyId, agentId: f.agentId, wakeup: wakeup as never });
    const replayed = (await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.agentId, f.agentId)))).filter(w => w.reason === PAUSE_MISSED_WAKE_REASON);
    expect(replayed).toHaveLength(1);
    expect(replayed[0].status).not.toBe("skipped");
    await heartbeat.drainActiveRunExecutions?.();
  });

  it("replays the missed wake when the lifecycle driver reports the agent ready again", async () => {
    const f = await seed();
    await refuseDuringPause(f);
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
    const driver = createLifecycleDriver(db, {} as never);
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    await driver.onReady(agent as never);
    const replayed = (await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.agentId, f.agentId)))).filter(w => w.reason === PAUSE_MISSED_WAKE_REASON);
    expect(replayed).toHaveLength(1);
  });

  // Production, 14 Nov 2026, TR-699: the tester's task, a question card addressed to the Quality
  // Manager; its wake waited behind the tester's run (deferred) and the pause stop cancelled it.
  async function cardWakeCancelledByPause(cardStatus = "pending") {
    const f = await seed();
    const tester = randomUUID(), interactionId = randomUUID();
    await db.insert(agents).values({ id: tester, companyId: f.companyId, name: "Tester", adapterType: "process", status: "idle", permissions: {} });
    await db.update(issues).set({ assigneeAgentId: tester }).where(eq(issues.id, f.issueId));
    await db.insert(issueThreadInteractions).values({ id: interactionId, companyId: f.companyId, issueId: f.issueId,
      kind: "ask_user_questions", status: cardStatus, addresseeAgentId: f.agentId, createdByAgentId: tester,
      payload: { version: 1, questions: [] } as never });
    const [deferred] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "automation", triggerDetail: "system", reason: "issue_execution_deferred", status: "deferred_issue_execution",
      payload: { issueId: f.issueId, mutation: "interaction", interactionId, interactionKind: "ask_user_questions" } }).returning();
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
    await heartbeatService(db).stopInvocationsForAgents([f.agentId], AGENT_LIFECYCLE_STOP_REASON, { preservePauseDeferred: true });
    const [cancelled] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, deferred.id));
    return { ...f, tester, interactionId, cancelled };
  }

  it("wakes the addressee of a pending card whose deferred wake the pause stop cancelled", async () => {
    const f = await cardWakeCancelledByPause();
    expect(f.cancelled).toEqual(expect.objectContaining({ status: "cancelled", error: AGENT_LIFECYCLE_STOP_REASON, runId: null }));
    const wakeup = vi.fn().mockResolvedValue(null);
    expect(await replayWakesMissedDuringPause(db, { companyId: f.companyId, agentId: f.agentId, wakeup })).toEqual({ issues: 1, woken: 1 });
    expect(wakeup).toHaveBeenCalledWith(f.agentId, expect.objectContaining({
      idempotencyKey: `pause-missed:${f.agentId}:${f.issueId}:${f.cancelled.id}`,
      payload: expect.objectContaining({ issueId: f.issueId, interactionId: f.interactionId, missedWakeRequestId: f.cancelled.id }),
    }));
  });

  it("delivers the replayed card wake through the real queue to the addressee of another agent's task", async () => {
    const f = await cardWakeCancelledByPause();
    const heartbeat = heartbeatService(db);
    const wakeup = (agentId: string, opts: Parameters<typeof heartbeat.wakeup>[1]) => heartbeat.wakeup(agentId, opts).catch(() => null);
    await replayWakesMissedDuringPause(db, { companyId: f.companyId, agentId: f.agentId, wakeup: wakeup as never });
    await new Promise(resolve => setTimeout(resolve, 500));
    const replayed = (await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.agentId, f.agentId)))).filter(w => w.reason === PAUSE_MISSED_WAKE_REASON);
    expect(replayed).toHaveLength(1);
    // Not refused, and not cancelled by dispatch because the addressee does not own the task.
    expect({ status: replayed[0].status, error: replayed[0].error ?? "" }).not.toMatchObject({ error: expect.stringContaining("assignee changed") });
    expect(replayed[0].status).not.toBe("skipped");
    expect(replayed[0].payload).toMatchObject({ issueId: f.issueId, mutation: "interaction", interactionId: f.interactionId,
      interactionKind: "ask_user_questions", missedWakeRequestId: f.cancelled.id });
    await heartbeat.drainActiveRunExecutions?.();
  });

  it("does not wake the addressee once the card is answered", async () => {
    const f = await cardWakeCancelledByPause("answered");
    const wakeup = vi.fn().mockResolvedValue(null);
    await replayWakesMissedDuringPause(db, { companyId: f.companyId, agentId: f.agentId, wakeup });
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("does not add a wake when one for the task is still live", async () => {
    const f = await cardWakeCancelledByPause();
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
      reason: "interaction_pending", status: "queued", payload: { issueId: f.issueId, interactionId: f.interactionId } });
    const wakeup = vi.fn().mockResolvedValue(null);
    await replayWakesMissedDuringPause(db, { companyId: f.companyId, agentId: f.agentId, wakeup });
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("replays a queued wake of the agent's own task cancelled by the pause stop, not one cancelled by an operator", async () => {
    const f = await seed();
    const [byPause] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
      reason: "issue_commented", status: "queued", payload: { issueId: f.issueId, mutation: "comment" } }).returning();
    await heartbeatService(db).stopInvocationsForAgents([f.agentId], AGENT_LIFECYCLE_STOP_REASON, { preservePauseDeferred: true });
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
    const wakeup = vi.fn().mockResolvedValue(null);
    await replayWakesMissedDuringPause(db, { companyId: f.companyId, agentId: f.agentId, wakeup });
    expect(wakeup).toHaveBeenCalledWith(f.agentId, expect.objectContaining({ idempotencyKey: `pause-missed:${f.agentId}:${f.issueId}:${byPause.id}` }));

    const g = await seed();
    await db.insert(agentWakeupRequests).values({ companyId: g.companyId, agentId: g.agentId, source: "automation", reason: "issue_commented",
      status: "cancelled", error: "Cancelled by a board operator", finishedAt: new Date(), payload: { issueId: g.issueId } });
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, g.agentId));
    const other = vi.fn().mockResolvedValue(null);
    await replayWakesMissedDuringPause(db, { companyId: g.companyId, agentId: g.agentId, wakeup: other });
    expect(other).not.toHaveBeenCalled();
  });

  it.each([
    { label: "a finished task", prepare: (f: { issueId: string }) => db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId)) },
    { label: "a task given to someone else", prepare: (f: { issueId: string }) => db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issueId)) },
    { label: "a task the agent already ran after the refusal", prepare: (f: { companyId: string; agentId: string; issueId: string }) =>
      db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "succeeded", finishedAt: new Date(Date.now() + 1000),
        createdAt: new Date(Date.now() + 1000), contextSnapshot: { issueId: f.issueId } }) },
  ])("does not wake the agent for $label", async ({ prepare }) => {
    const f = await seed();
    await refuseDuringPause(f);
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
    await prepare(f as never);
    const wakeup = vi.fn().mockResolvedValue(null);
    await replayWakesMissedDuringPause(db, { companyId: f.companyId, agentId: f.agentId, wakeup });
    expect(wakeup).not.toHaveBeenCalled();
  });
});
