import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issues, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { PAUSE_MISSED_WAKE_REASON, replayWakesMissedDuringPause } from "../services/pause-missed-wakes.js";

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
