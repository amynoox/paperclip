// studio.25 assembly: when an agent becomes ready, the lifecycle driver runs five steps (STUDIO-0028, 0074, 0076 and
// the two of the product). Each has its own try: an error of one is logged and the next ones still run.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const calls = vi.hoisted(() => ({ done: [] as string[], failing: null as string | null, logged: [] as Array<Record<string, unknown>> }));
const step = (name: string) => async () => {
  calls.done.push(name);
  if (calls.failing === name) throw new Error(`${name} failed`);
};

vi.mock("../middleware/logger.js", () => ({ logger: {
  error: (fields: Record<string, unknown>, message: string) => { calls.logged.push({ ...fields, message }); },
  warn: () => undefined, info: () => undefined, debug: () => undefined, child: () => ({}),
} }));
vi.mock("../services/work-intent-outbox.js", () => ({ promoteDeferredWorkIntents: step("promote_deferred_work_intents") }));
vi.mock("../services/pause-missed-wakes.js", () => ({ replayWakesMissedDuringPause: step("replay_wakes_missed_during_pause") }));
vi.mock("../services/pause-resume-continuation.js", () => ({
  continueRunsCutByPause: step("continue_runs_cut_by_pause"),
  pauseLiftedOf: () => ({ readyOperationId: "op-1", pausedAt: new Date(0), requestedBy: null }),
}));
vi.mock("../services/heartbeat.js", () => ({ heartbeatService: () => ({
  resumeQueuedRunsForAgent: step("resume_queued_runs"),
  wakeDeclaredWaitsAfterPause: step("wake_declared_waits_after_pause"),
  wakeup: async () => null,
  resumeTaskRetry: async () => null,
}) }));
vi.mock("../services/agent-harness-verification.js", () => ({ agentHarnessVerificationService: () => ({ verify: async () => undefined }) }));

const STEPS = ["promote_deferred_work_intents", "resume_queued_runs", "replay_wakes_missed_during_pause",
  "wake_declared_waits_after_pause", "continue_runs_cut_by_pause"];
const agent = { id: "agent-1", companyId: "company-1", lifecycleOperation: { id: "op-1" } } as never;

describe("the steps run when an agent becomes ready", () => {
  let createLifecycleDriver: typeof import("../services/agent-lifecycle-driver.js").createLifecycleDriver;
  // The driver's module is long to load: once, before the cases.
  beforeAll(async () => { ({ createLifecycleDriver } = await import("../services/agent-lifecycle-driver.js")); }, 240_000);
  beforeEach(() => { calls.done = []; calls.failing = null; calls.logged = []; });

  async function ready() {
    const db = { transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}) } as unknown as Db;
    await createLifecycleDriver(db, {} as never).onReady!(agent);
  }

  it("runs the five steps in order, the continuation of the cut runs last, and logs nothing", async () => {
    await ready();
    expect(calls.done).toEqual(STEPS);
    expect(calls.logged).toEqual([]);
  });

  it("an error of any one step is logged with its name and the other four still run", async () => {
    for (const failing of STEPS) {
      calls.done = []; calls.logged = []; calls.failing = failing;
      await expect(ready()).resolves.toBeUndefined();
      expect(calls.done, failing).toEqual(STEPS);
      expect(calls.logged, failing).toEqual([expect.objectContaining({
        step: failing, companyId: "company-1", agentId: "agent-1", message: "agent ready: a step failed, the next steps still run",
      })]);
      expect((calls.logged[0]!.err as Error).message).toBe(`${failing} failed`);
    }
  });
});
