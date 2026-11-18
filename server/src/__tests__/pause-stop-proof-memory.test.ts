import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentExecutionsHaveStopped } from "../services/agent-execution-stop.js";
import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import { preDispatchCancellationResult } from "../services/pre-dispatch-cancellation.js";

// STUDIO-0068: production, 18 Nov 2026. Eleven roles were paused. The stop proof of a pausing role read every run
// the role ever had, whole rows, twice (heartbeat.ts stopInvocationsForAgents, then agentExecutionsHaveStopped), for
// four roles at once and again every 2 s: the Quality Manager's 1 568 runs were 864 MB compressed in the database.
// The server died of heap exhaustion (4 288 MB) at every start and the four roles stayed `pausing`.
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("the stop proof of a pause and the size of a role's runs", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-stop-proof-memory-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });

  async function seedAgent() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stop proof memory", issuePrefix: `M${companyId.slice(0, 7)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Long-lived role", adapterType: "codex_local",
      status: "paused", adapterConfig: {} }).returning();
    return { companyId, agentId: agent.id };
  }
  async function seedRun(f: { companyId: string; agentId: string }, run: Partial<typeof heartbeatRuns.$inferInsert>) {
    const at = new Date(Date.now() - 3_600_000);
    const [row] = await db.insert(heartbeatRuns).values({
      companyId: f.companyId, agentId: f.agentId, invocationSource: "automation", triggerDetail: "system",
      status: "succeeded", runtimeMode: "legacy", executionStage: "settled", startedAt: at,
      finishedAt: new Date(at.getTime() + 60_000), ...run,
    }).returning({ id: heartbeatRuns.id });
    return row.id;
  }
  /** Make the payload columns of the agent's runs heavy, in the database: nothing of it passes through this process. */
  async function weighDown(agentId: string, megabytesPerRun: number) {
    const repeats = Math.round(megabytesPerRun * 1_000_000 / 32 / 3);
    await db.execute(sql`update heartbeat_runs set
      result_json = coalesce(result_json, '{}'::jsonb) || jsonb_build_object('stdout', repeat(md5(id::text), ${repeats}::int)),
      usage_json = jsonb_build_object('raw', repeat(md5(id::text || 'u'), ${repeats}::int)),
      context_snapshot = coalesce(context_snapshot, '{}'::jsonb) || jsonb_build_object('transcript', repeat(md5(id::text || 'c'), ${repeats}::int))
      where agent_id = ${agentId}::uuid`);
  }
  /** The highest heap seen while `work` runs, above the heap at its start. Sampled between its database reads. */
  async function heapGrowthDuring<T>(work: () => Promise<T>) {
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed); }, 2);
    try { return { result: await work(), growthMb: (peak - before) / 1_000_000 }; }
    finally { clearInterval(timer); }
  }

  it("pauses a long-lived role without loading the payloads of its runs", async () => {
    const f = await seedAgent();
    const RUNS = 60, MB_PER_RUN = 6;
    for (let index = 0; index < RUNS; index++) await seedRun(f, {});
    await weighDown(f.agentId, MB_PER_RUN);
    const [stored] = await db.execute<{ megabytes: number }>(sql`select (sum(octet_length(result_json::text)
      + octet_length(usage_json::text) + octet_length(context_snapshot::text)) / 1000000)::int as megabytes
      from heartbeat_runs where agent_id = ${f.agentId}::uuid`);
    expect(Number(stored.megabytes)).toBeGreaterThanOrEqual(RUNS * MB_PER_RUN - 5);

    await db.update(agents).set({ status: "paused", lifecycleState: "pausing" }).where(eq(agents.id, f.agentId));
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    const driver = createLifecycleDriver(db, {} as never);
    // The real path of a pause: the lifecycle worker's host step.
    const paused = await heapGrowthDuring(() => driver.runHost(agent as never));
    expect(paused.result).toBe("complete");
    // 360 MB of payload are stored; whole rows cost at least that, twice. The proof needs a few kilobytes.
    expect(paused.growthMb).toBeLessThan(120);
    const proof = await heapGrowthDuring(() => agentExecutionsHaveStopped(db, [f.agentId], { pauseStop: true }));
    expect(proof.result).toBe(true);
    expect(proof.growthMb).toBeLessThan(120);
  }, 300_000);

  it("gives the same verdicts when the payload around the fragments it reads is large", async () => {
    const cancelled = { status: "cancelled" as const, errorCode: "cancelled" };
    const conversation = { conversationContinuation: "continue_conversation_v1" };
    const verdict = async (run: Partial<typeof heartbeatRuns.$inferInsert>) => {
      const f = await seedAgent();
      await seedRun(f, run);
      await seedRun(f, {});
      await weighDown(f.agentId, 1);
      return agentExecutionsHaveStopped(db, [f.agentId]);
    };
    // Finished runs only: stopped.
    expect(await verdict({})).toBe(true);
    // A run that is not finished: not stopped.
    expect(await verdict({ status: "running", finishedAt: null })).toBe(false);
    // A controller lease still held: not stopped.
    expect(await verdict({ controllerLeaseExpiresAt: new Date(Date.now() + 600_000) })).toBe(false);
    // A cancelled conversation run: stopped only once its cancellation is acknowledged.
    expect(await verdict({ ...cancelled, resultJson: { ...conversation, executionCancellation: { state: "requested" } } })).toBe(false);
    expect(await verdict({ ...cancelled, resultJson: { ...conversation, executionCancellation: { state: "acknowledged" } } })).toBe(true);
    // Cancelled before its adapter was entered: the marker proves it; a malformed marker does not.
    expect(await verdict({ ...cancelled, resultJson: { ...conversation, ...preDispatchCancellationResult("stale_queued_run_gate", new Date()) } })).toBe(true);
    expect(await verdict({ ...cancelled, resultJson: { ...conversation, preDispatchCancellation: { version: 2, providerWorkStarted: false } } })).toBe(false);
    expect(await verdict({ ...cancelled, resultJson: { ...conversation, preDispatchCancellation: { version: 1, providerWorkStarted: true } } })).toBe(false);
    // A settled cancelled run of an adapter that keeps no conversation: read whole, then proven stopped.
    expect(await verdict({ ...cancelled, resultJson: { executionCancellation: { state: "requested" } } })).toBe(true);
    // A recorded process that is alive: not stopped.
    expect(await verdict({ ...cancelled, processPid: process.pid })).toBe(false);
  }, 300_000);
});
