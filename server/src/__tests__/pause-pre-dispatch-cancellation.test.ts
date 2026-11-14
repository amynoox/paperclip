import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentExecutionsHaveStopped } from "../services/agent-execution-stop.js";
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
});
