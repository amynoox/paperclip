import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentExecutionsHaveStopped, SSH_CLIENT_STOP_PAUSE_PROOF_DELAY_MS } from "../services/agent-execution-stop.js";
import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import { markCancelledBeforeProcessLaunch, preDispatchCancellationResult, SETTLED_STOP_MARK_DELAY_MS } from "../services/pre-dispatch-cancellation.js";

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

  // STUDIO-0053: production, 15 Nov 2026. d1389345 (no lease) and f410e11a (ssh lease, expired) were stopped by the
  // Board during their preparation: started, no process identity, no execution event, cancellation "requested".
  async function boardStopBeforeAdapter(input: { ssh: boolean; minutesAgo?: number }) {
    const finishedAt = new Date(Date.now() - (input.minutesAgo ?? 1) * 60_000);
    const f = await seed({ errorCode: "cancelled", startedAt: new Date(finishedAt.getTime() - 37_000), finishedAt,
      resultJson: { conversationContinuation: "continue_conversation_v1", executionCancellation: { state: "requested", requestedAt: finishedAt.toISOString() } } });
    if (input.ssh) await sshLease(f);
    return f;
  }

  it("proves the stop of a run stopped before any process was launched, with or without an ssh lease", async () => {
    for (const ssh of [false, true]) {
      const f = await boardStopBeforeAdapter({ ssh });
      expect(await agentExecutionsHaveStopped(db, [f.agentId], { pauseStop: true })).toBe(false);
      expect(await markCancelledBeforeProcessLaunch(db, f.run.id)).toBe(true);
      expect(await markCancelledBeforeProcessLaunch(db, f.run.id)).toBe(false);
      expect(await agentExecutionsHaveStopped(db, [f.agentId], { pauseStop: true })).toBe(true);
      expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(true);
    }
  });

  it("writes no marker once the adapter was invoked or a process was asked for or recorded", async () => {
    for (const eventType of ["adapter.invoke", "native.process_start_requested", "native.process_identity_recorded", "tool.execution.started",
      "harness.ready", "session.started", "session.resumed", "turn.started", "provider.event", "provider.rpc_result"]) {
      const f = await boardStopBeforeAdapter({ ssh: true });
      await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: f.run.id, agentId: f.agentId, seq: 1, eventType,
        stream: "system", level: "info", message: eventType });
      expect(await markCancelledBeforeProcessLaunch(db, f.run.id)).toBe(false);
      expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
    }
    const withPid = await boardStopBeforeAdapter({ ssh: true });
    await db.update(heartbeatRuns).set({ processPid: 2_000_000_002 }).where(eq(heartbeatRuns.id, withPid.run.id));
    expect(await markCancelledBeforeProcessLaunch(db, withPid.run.id)).toBe(false);
    const withGroup = await boardStopBeforeAdapter({ ssh: true });
    await db.update(heartbeatRuns).set({ processGroupId: 2_000_000_003 }).where(eq(heartbeatRuns.id, withGroup.run.id));
    expect(await markCancelledBeforeProcessLaunch(db, withGroup.run.id)).toBe(false);
    const withSession = await boardStopBeforeAdapter({ ssh: true });
    await db.update(heartbeatRuns).set({ sessionIdAfter: "session-1" }).where(eq(heartbeatRuns.id, withSession.run.id));
    expect(await markCancelledBeforeProcessLaunch(db, withSession.run.id)).toBe(false);
  });

  it("writes no marker for a run that is not a requested legacy cancellation", async () => {
    const acknowledged = await seed({ resultJson: { executionCancellation: { state: "acknowledged", acknowledgedAt: new Date().toISOString() } } });
    expect(await markCancelledBeforeProcessLaunch(db, acknowledged.run.id)).toBe(false);
    const nativeRun = await boardStopBeforeAdapter({ ssh: false });
    await db.update(heartbeatRuns).set({ runtimeMode: "native" }).where(eq(heartbeatRuns.id, nativeRun.run.id));
    expect(await markCancelledBeforeProcessLaunch(db, nativeRun.run.id)).toBe(false);
    const stillRunning = await boardStopBeforeAdapter({ ssh: false });
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, stillRunning.run.id));
    expect(await markCancelledBeforeProcessLaunch(db, stillRunning.run.id)).toBe(false);
  });

  it("records at pause time the stop of a run that settled late or across a restart", async () => {
    expect(SETTLED_STOP_MARK_DELAY_MS).toBe(2 * 60_000);
    const settled = await boardStopBeforeAdapter({ ssh: true, minutesAgo: 5 });
    expect(await agentExecutionsHaveStopped(db, [settled.agentId])).toBe(false);
    expect(await agentExecutionsHaveStopped(db, [settled.agentId], { pauseStop: true })).toBe(true);
    const [marked] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, settled.run.id));
    expect(marked!.resultJson).toMatchObject({ preDispatchCancellation: { source: "stopped_before_process_launch" } });
    // Settled a few seconds ago: the adapter may still be writing; nothing is recorded yet.
    const fresh = await boardStopBeforeAdapter({ ssh: true, minutesAgo: 0.1 });
    expect(await agentExecutionsHaveStopped(db, [fresh.agentId], { pauseStop: true })).toBe(false);
  });

  // STUDIO-0061: production 15 Nov 2026, run 998a6dc0 (* Game Tester): cancelled at 07:25:29 by another path than a
  // stop request (no executionCancellation; conversationContinuation set; local lease released), legacy, settled,
  // no process, no session, no execution-start event. The pause stayed `pausing` until a database write.
  it("completes a pause held by a settled run cancelled without a stop request and never started", async () => {
    const finishedAt = new Date(Date.now() - 5 * 60_000);
    const f = await seed({ errorCode: "legacy_disposition_repair_suppressed", startedAt: new Date(finishedAt.getTime() - 4_500), finishedAt,
      resultJson: { conversationContinuation: "continue_conversation_v1" } });
    await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.run.id, provider: "local",
      status: "expired", leasePolicy: "ephemeral", releasedAt: new Date(finishedAt.getTime() + 1_000), metadata: { agentId: f.agentId } });
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: f.run.id, agentId: f.agentId, seq: 1,
      eventType: "lifecycle", stream: "system", level: "info", message: "run cancelled" });
    // Outside a pause nothing changes: the run is not proven stopped and no marker is written.
    expect(await markCancelledBeforeProcessLaunch(db, f.run.id)).toBe(false);
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
    // The pause records the stop and completes.
    expect(await agentExecutionsHaveStopped(db, [f.agentId], { pauseStop: true })).toBe(true);
    const [marked] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    expect(marked!.resultJson).toMatchObject({ preDispatchCancellation: { source: "stopped_before_process_launch", providerWorkStarted: false } });

    // Not for a run whose adapter control had not settled, nor once an execution started, nor with a remote lease.
    const remote = await seed({ finishedAt, resultJson: { conversationContinuation: "continue_conversation_v1" } });
    await sshLease(remote);
    expect(await agentExecutionsHaveStopped(db, [remote.agentId], { pauseStop: true })).toBe(false);
    const unsettled = await seed({ executionStage: "running", finishedAt, resultJson: { conversationContinuation: "continue_conversation_v1" } });
    expect(await agentExecutionsHaveStopped(db, [unsettled.agentId], { pauseStop: true })).toBe(false);
    const started = await seed({ finishedAt, resultJson: { conversationContinuation: "continue_conversation_v1" } });
    await db.insert(heartbeatRunEvents).values({ companyId: started.companyId, runId: started.run.id, agentId: started.agentId, seq: 1,
      eventType: "adapter.invoke", stream: "system", level: "info", message: "adapter.invoke" });
    expect(await agentExecutionsHaveStopped(db, [started.agentId], { pauseStop: true })).toBe(false);
  });

  it("marks at pause time only the paused agent's cancelled runs without any process, session or execution event", async () => {
    const stamp = async (f: { run: typeof heartbeatRuns.$inferSelect }, values: Partial<typeof heartbeatRuns.$inferInsert>) =>
      db.update(heartbeatRuns).set(values).where(eq(heartbeatRuns.id, f.run.id));
    const marker = async (f: { run: typeof heartbeatRuns.$inferSelect }) =>
      ((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0]!.resultJson as Record<string, any> | null)?.preDispatchCancellation;
    const target = await boardStopBeforeAdapter({ ssh: false, minutesAgo: 5 });
    const others = {
      pid: await boardStopBeforeAdapter({ ssh: false, minutesAgo: 5 }),
      group: await boardStopBeforeAdapter({ ssh: false, minutesAgo: 5 }),
      session: await boardStopBeforeAdapter({ ssh: false, minutesAgo: 5 }),
      event: await boardStopBeforeAdapter({ ssh: false, minutesAgo: 5 }),
      failed: await boardStopBeforeAdapter({ ssh: false, minutesAgo: 5 }),
      timedOut: await boardStopBeforeAdapter({ ssh: false, minutesAgo: 5 }),
      succeeded: await boardStopBeforeAdapter({ ssh: false, minutesAgo: 5 }),
    };
    // Every run belongs to the target's agent, except one left on its own agent below.
    for (const f of Object.values(others)) await stamp(f, { agentId: target.agentId, companyId: target.companyId });
    await stamp(others.pid, { processPid: 2_000_000_010 });
    await stamp(others.group, { processGroupId: 2_000_000_011 });
    await stamp(others.session, { sessionIdAfter: "session-2" });
    await db.insert(heartbeatRunEvents).values({ companyId: target.companyId, runId: others.event.run.id, agentId: target.agentId, seq: 1,
      eventType: "provider.event", stream: "system", level: "info", message: "provider.event" });
    await stamp(others.failed, { status: "failed" });
    await stamp(others.timedOut, { status: "timed_out" });
    await stamp(others.succeeded, { status: "succeeded" });
    const elsewhere = await boardStopBeforeAdapter({ ssh: false, minutesAgo: 5 });
    await agentExecutionsHaveStopped(db, [target.agentId], { pauseStop: true });
    const marked = await marker(target);
    expect(marked).toMatchObject({ source: "stopped_before_process_launch", providerWorkStarted: false });
    expect(new Date(marked.cancelledAt).getTime()).toBe(target.run.finishedAt!.getTime());
    for (const f of Object.values(others)) expect(await marker(f)).toBeUndefined();
    expect(await marker(elsewhere)).toBeUndefined();
  });
});
