import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, plugins, pluginJobRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { ABANDONED_PLUGIN_JOB_RUN_ERROR, createPluginJobScheduler } from "../services/plugin-job-scheduler.js";
import { pluginJobStore } from "../services/plugin-job-store.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

// STUDIO-0069: production, 18 Nov 2026. The server died in a loop; three periodic plugin jobs (worker-router
// retry_waiting, prompt-memory settle_cards, chat-closer sweep) were left with a run `running` in the database. After
// the server was back, no periodic job of these plugins ran: the scheduler skips a job that has an outstanding run,
// nothing ever settled those runs, and with every job skipped it had no deadline left. It took two gestures by hand.
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("a plugin job run left by a stopped server process", () => {
  // The scheduler's default bound: the call timeout (5 min) and twice the settlement timeout (30 s).
  const ABANDONED_AFTER_MS = 5 * 60_000 + 2 * 30_000;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>, pluginId: string;
  let scheduler: ReturnType<typeof createPluginJobScheduler> | undefined;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  const rpc = vi.fn<(...args: unknown[]) => Promise<unknown>>();
  const errors: unknown[] = [];
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("plugin-abandoned-run-");
    db = createDb(temporary.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 60_000);
  beforeEach(async () => {
    pluginId = randomUUID(); errors.length = 0;
    rpc.mockReset(); rpc.mockResolvedValue({});
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: pluginId, version: "1.0.0", manifestJson: {} as never });
    await Promise.all(Array.from({ length: 6 }, () => db.execute(sql`select pg_sleep(0.01)`)));
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-11-18T11:05:00Z"));
  });
  afterEach(async () => {
    await scheduler?.stop(); await coordinator?.stop(); scheduler = undefined; coordinator = undefined;
    vi.useRealTimers(); vi.restoreAllMocks();
    await db.delete(plugins).where(eq(plugins.id, pluginId));
    expect(errors).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  /** The server starts: the scheduler is created and started as app.ts does, then the plugin registers. */
  async function start() {
    const workerManager = { isRunning: () => true, call: rpc, getWorker: () => new EventEmitter() } as unknown as PluginWorkerManager;
    scheduler = createPluginJobScheduler({ db, jobStore: pluginJobStore(db), workerManager, isBackgroundWorkEnabled: () => true });
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true,
      onError: error => errors.push(error) });
    await scheduler.start(coordinator);
    await scheduler.registerPlugin(pluginId);
  }
  /** A periodic job whose deadline has passed, as after an outage. */
  async function dueJob(key: string) {
    const row = await pluginRegistryService(db).upsertJob(pluginId, key, { schedule: "*/5 * * * *" });
    await pluginJobStore(db).updateRunTimestamps(row.id, new Date(0), new Date(Date.now() - 60_000));
    return row;
  }
  /** A run another server process created and never settled. */
  async function leftRun(jobId: string, status: "pending" | "queued" | "running", ageMs: number) {
    const at = new Date(Date.now() - ageMs);
    const [row] = await db.insert(pluginJobRuns).values({ jobId, pluginId, trigger: "schedule", status,
      createdAt: at, startedAt: status === "running" ? at : null }).returning();
    return row;
  }
  const runs = () => db.select().from(pluginJobRuns).where(eq(pluginJobRuns.pluginId, pluginId));
  const run = async (id: string) => (await runs()).find(row => row.id === id)!;
  async function settled() {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(idleWorkSnapshot().active).toBe(0);
    }, { timeout: 5000 });
  }
  async function succeeded(count: number) {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect((await runs()).filter(row => row.status === "succeeded")).toHaveLength(count);
    }, { timeout: 8000 });
  }

  it("runs every periodic job again at start when the runs a dead process left are past the bound", async () => {
    const left = [];
    for (const status of ["running", "queued", "pending"] as const) {
      const job = await dueJob(`job-${status}`);
      left.push(await leftRun(job.id, status, ABANDONED_AFTER_MS + 60_000));
    }
    await start();
    await succeeded(3);
    expect(rpc).toHaveBeenCalledTimes(3);
    for (const row of left) {
      expect(await run(row.id)).toMatchObject({ status: "failed", error: ABANDONED_PLUGIN_JOB_RUN_ERROR });
      const job = await pluginJobStore(db).getJobById(row.jobId);
      // The job is back on its rhythm.
      expect(job!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    }
    expect((await run(left[0].id)).finishedAt).not.toBeNull();
  }, 30_000);

  it("waits while the left run may still have an owner, then recovers by itself at the bound, with no other event", async () => {
    const job = await dueJob("retry_waiting");
    const left = await leftRun(job.id, "running", 60_000);
    await start();
    await settled();
    expect(rpc).not.toHaveBeenCalled();
    // One deadline: the moment the run is abandoned.
    expect(coordinator!.nextWakeAt()).not.toBeNull();
    expect(coordinator!.nextWakeAt()!).toBeLessThanOrEqual(left.startedAt!.getTime() + ABANDONED_AFTER_MS + 1000);
    await vi.advanceTimersByTimeAsync(ABANDONED_AFTER_MS - 60_000 - 30_000);
    await settled();
    expect(rpc).not.toHaveBeenCalled();
    expect((await run(left.id)).status).toBe("running");
    await vi.advanceTimersByTimeAsync(31_000);
    await succeeded(1);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(await run(left.id)).toMatchObject({ status: "failed", error: ABANDONED_PLUGIN_JOB_RUN_ERROR });
  }, 30_000);

  it("leaves a young run to its owner: its completion releases the job and nothing is marked abandoned", async () => {
    const job = await dueJob("settle_cards");
    const left = await leftRun(job.id, "queued", 10_000);
    await start();
    await settled();
    expect(rpc).not.toHaveBeenCalled();
    // The owner, another process, settles its run.
    await pluginJobStore(db).completeRun(left.id, { status: "succeeded" });
    await succeeded(2);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect((await run(left.id)).error).toBeNull();
    expect((await runs()).filter(row => row.error === ABANDONED_PLUGIN_JOB_RUN_ERROR)).toHaveLength(0);
  }, 30_000);

  it("never abandons a run this process is executing, however long it takes", async () => {
    await dueJob("sweep");
    let release!: () => void;
    rpc.mockImplementationOnce(() => new Promise<void>(resolve => { release = () => resolve(); }));
    await start();
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(ABANDONED_AFTER_MS * 2);
    const [own] = await runs();
    expect(own.status).toBe("running");
    release();
    await succeeded(1);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect((await runs()).filter(row => row.error === ABANDONED_PLUGIN_JOB_RUN_ERROR)).toHaveLength(0);
  }, 30_000);
});
