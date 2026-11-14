import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentExecutionsHaveStopped, SSH_CLIENT_STOP_PAUSE_PROOF_DELAY_MS } from "../services/agent-execution-stop.js";
import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import { preDispatchCancellationResult } from "../services/pre-dispatch-cancellation.js";

// STUDIO-0043: production, 14 Nov 2026. After a pause, three agents stayed
// `pausing`: five runs had been cancelled by the server before their adapter
// was entered (stale execution continuation, stale queued-run gate), yet the
// stop proof waited for a process acknowledgement (conversation adapter, no
// process id) or a remote termination receipt (an ssh lease taken for the run)
// that could never come, since nothing had been dispatched.
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("agent stop proof and runs cancelled before dispatch", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-pre-dispatch-stop-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });

  async function seed(run: Partial<typeof heartbeatRuns.$inferInsert>) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Pre-dispatch stop", issuePrefix: `P${companyId.slice(0, 7)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Executor", adapterType: "codex_local", status: "paused", adapterConfig: {} }).returning();
    const at = new Date(Date.now() - 60_000);
    const [row] = await db.insert(heartbeatRuns).values({
      companyId, agentId: agent.id, invocationSource: "automation", triggerDetail: "system", status: "cancelled",
      runtimeMode: "legacy", executionStage: "settled", startedAt: at, finishedAt: new Date(at.getTime() + 500),
      errorCode: "continuation_task_ownership_changed",
      // A conversation adapter run: without acknowledgement its stop is unproven.
      resultJson: { conversationContinuation: "continue_conversation_v1" },
      ...run,
    }).returning();
    return { companyId, agentId: agent.id, run: row };
  }
  const mark = (run: typeof heartbeatRuns.$inferSelect, source: "stale_queued_run_gate" | "stale_execution_continuation") =>
    db.update(heartbeatRuns).set({ resultJson: { ...(run.resultJson ?? {}), ...preDispatchCancellationResult(source, new Date()) } })
      .where(eq(heartbeatRuns.id, run.id));
  async function sshLease(f: { companyId: string; agentId: string; run: typeof heartbeatRuns.$inferSelect }) {
    await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.run.id, provider: "ssh",
      providerLeaseId: `ssh://worker@mac-01:22/w/${f.run.id}`, status: "expired", cleanupStatus: "success",
      leasePolicy: "ephemeral", releasedAt: new Date(), metadata: { agentId: f.agentId, driver: "ssh" } });
  }

  it("proves the stop of a conversation run cancelled before its adapter was entered", async () => {
    const f = await seed({});
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
    await mark(f.run, "stale_execution_continuation");
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(true);
  });

  it("needs no remote termination receipt for an ssh lease of a run cancelled before dispatch", async () => {
    const f = await seed({ errorCode: "issue_not_in_progress" });
    await sshLease(f);
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
    await mark(f.run, "stale_queued_run_gate");
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(true);
  });

  it("never accepts the marker for a run that recorded a process, nor for a remote run that did", async () => {
    // A live process stays a live process.
    const live = await seed({ processPid: process.pid });
    await mark(live.run, "stale_execution_continuation");
    expect(await agentExecutionsHaveStopped(db, [live.agentId])).toBe(false);
    // A run with a recorded (dead) process on an ssh lease still needs the
    // remote termination receipt: the remote command may outlive the local client.
    const remote = await seed({ processPid: 2_000_000_000, errorCode: "issue_reassigned" });
    await sshLease(remote);
    await mark(remote.run, "stale_execution_continuation");
    expect(await agentExecutionsHaveStopped(db, [remote.agentId])).toBe(false);
  });

  it("ignores a malformed marker", async () => {
    const f = await seed({});
    await db.update(heartbeatRuns).set({ resultJson: { ...(f.run.resultJson ?? {}), preDispatchCancellation: { version: 1, providerWorkStarted: true } } })
      .where(eq(heartbeatRuns.id, f.run.id));
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
  });

  // Production, 14 Nov 2026: the CTO's runs a6d718c3 (04:09:25) and f33b3f00
  // (07:47:34), cancelled `issue_reassigned` after running over the built-in
  // ssh environment driver. The local ssh client was gone, the lease expired,
  // and no termination receipt could ever come: the CTO stayed `pausing`.
  async function cutSshRun(input: { minutesAgo: number; processPid?: number; processStartedAt?: Date | null }) {
    const finishedAt = new Date(Date.now() - input.minutesAgo * 60_000);
    const f = await seed({ errorCode: "issue_reassigned", processPid: input.processPid ?? 2_000_000_000,
      processStartedAt: input.processStartedAt ?? null, startedAt: new Date(finishedAt.getTime() - 5 * 60_000), finishedAt,
      resultJson: { conversationContinuation: "continue_conversation_v1", executionCancellation: { state: "requested", requestedAt: finishedAt.toISOString() } } });
    await sshLease(f);
    return f;
  }

  it("proves a pause past the delay once the local ssh client of a cut run is gone, and only for a pause", async () => {
    expect(SSH_CLIENT_STOP_PAUSE_PROOF_DELAY_MS).toBe(10 * 60_000);
    const f = await cutSshRun({ minutesAgo: 15 });
    expect(await agentExecutionsHaveStopped(db, [f.agentId], { pauseStop: true })).toBe(true);
    // Termination and cleanup keep the receipt requirement.
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
    // A pid now used by another program counts as gone.
    const reused = await cutSshRun({ minutesAgo: 15, processPid: process.pid, processStartedAt: new Date("2020-01-01T00:00:00.000Z") });
    expect(await agentExecutionsHaveStopped(db, [reused.agentId], { pauseStop: true })).toBe(true);
  });

  it("gives no proof while the local ssh client lives, before the delay, or on another provider", async () => {
    const alive = await cutSshRun({ minutesAgo: 15, processPid: process.pid });
    expect(await agentExecutionsHaveStopped(db, [alive.agentId], { pauseStop: true })).toBe(false);
    const early = await cutSshRun({ minutesAgo: 5 });
    expect(await agentExecutionsHaveStopped(db, [early.agentId], { pauseStop: true })).toBe(false);
    const noPid = await seed({ errorCode: "issue_reassigned", finishedAt: new Date(Date.now() - 15 * 60_000) });
    await sshLease(noPid);
    expect(await agentExecutionsHaveStopped(db, [noPid.agentId], { pauseStop: true })).toBe(false);
    const plugin = await cutSshRun({ minutesAgo: 15 });
    await db.update(environmentLeases).set({ provider: "daytona" }).where(eq(environmentLeases.heartbeatRunId, plugin.run.id));
    expect(await agentExecutionsHaveStopped(db, [plugin.agentId], { pauseStop: true })).toBe(false);
  });

  it("completes the pause of an agent held by the CTO's two cut runs, without any gesture", async () => {
    const f = await cutSshRun({ minutesAgo: 300 });
    const second = await seed({});
    // Second cut run of the same agent (f33b3f00).
    const finishedAt = new Date(Date.now() - 80 * 60_000);
    const [run2] = await db.update(heartbeatRuns).set({ agentId: f.agentId, companyId: f.companyId, errorCode: "issue_reassigned",
      processPid: 2_000_000_001, finishedAt, startedAt: new Date(finishedAt.getTime() - 300_000) })
      .where(eq(heartbeatRuns.id, second.run.id)).returning();
    await sshLease({ companyId: f.companyId, agentId: f.agentId, run: run2 });
    await db.update(agents).set({ status: "paused", lifecycleState: "pausing" }).where(eq(agents.id, f.agentId));
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    const driver = createLifecycleDriver(db, {} as never);
    expect(await driver.runHost(agent as never)).toBe("complete");
    // The same runs keep a termination pending.
    expect(await driver.runHost({ ...agent, lifecycleState: "terminating" } as never)).toBe("pending");
  });
});
