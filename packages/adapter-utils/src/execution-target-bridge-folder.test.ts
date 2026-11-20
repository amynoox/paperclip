import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startAdapterExecutionTargetPaperclipBridge, type AdapterSandboxExecutionTarget } from "./execution-target.js";
import { deferOrphanedBridgeStop } from "./provider-stopped-boundary.js";
import { runChildProcess } from "./server-utils.js";

// STUDIO-0082, the proof before the install. The test bench cannot keep a bridge (it has no pinned engine), so
// this file is where the defect and its correction are shown, on the whole bridge as a run uses it:
// `startAdapterExecutionTargetPaperclipBridge` starts the real bridge server on the "machine" (a real `node`
// process, through a runner that executes the commands on this machine) and the real worker in this process, which
// relays each request to a Paperclip API (here a local HTTP server that records what it receives).
//
// The folder is the one of the steered path: the runs of one worker-router reservation work in the same task
// folder, so their bridges live in `<task folder>/.paperclip-runtime/codex/paperclip-bridge`.
describe("two bridges of one task folder, as two runs of one reservation start them (STUDIO-0082)", () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => undefined);
  });

  type Received = { method: string; url: string; runId: string | null; body: string };

  /** The Paperclip API: records each call, and takes a moment to answer, as a real write does. */
  async function paperclipApi() {
    const received: Received[] = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const runId = typeof req.headers["x-paperclip-run-id"] === "string" ? req.headers["x-paperclip-run-id"] : null;
        received.push({ method: req.method ?? "GET", url: req.url ?? "/", runId, body: Buffer.concat(chunks).toString("utf8") });
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, relayedFor: runId }));
        }, 400);
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("the API stand-in did not listen");
    return { url: `http://127.0.0.1:${address.port}`, received };
  }

  function localRunner() {
    let counter = 0;
    return {
      execute: async (input: { command: string; args?: string[]; cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number;
        onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>; onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void> }) => {
        counter += 1;
        return runChildProcess(`bridge-folder-${counter}`, input.command === "bash" ? "/bin/bash" : input.command, input.args ?? [], {
          cwd: input.cwd ?? process.cwd(), env: input.env ?? {}, stdin: input.stdin,
          timeoutSec: Math.max(1, Math.ceil((input.timeoutMs ?? 30_000) / 1000)), graceSec: 5,
          onLog: input.onLog ?? (async () => {}),
          onSpawn: input.onSpawn ? async (meta) => input.onSpawn?.({ pid: meta.pid, startedAt: meta.startedAt }) : undefined,
        });
      },
    };
  }

  /** One reservation: its task folder on the machine, and the bridges its runs start there. */
  async function reservation(api: { url: string }) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-reservation-"));
    cleanup.push(() => rm(rootDir, { recursive: true, force: true }));
    const taskFolder = path.join(rootDir, "tasks", "TR-2153");
    await mkdir(taskFolder, { recursive: true });
    const bridgeFolder = path.join(taskFolder, ".paperclip-runtime", "codex", "paperclip-bridge");
    const target = (): AdapterSandboxExecutionTarget => ({
      kind: "remote", transport: "sandbox", providerKey: "e2b", environmentId: "env-1", leaseId: "lease-1",
      remoteCwd: taskFolder, runner: localRunner(), timeoutMs: 30_000,
    });
    const logs: string[] = [];
    const startBridge = async (runId: string) => {
      // No runtime folder is given: the bridge takes the default one of the task folder, as on the steered path.
      const bridge = await startAdapterExecutionTargetPaperclipBridge({
        runId, target: target(), runtimeRootDir: null, adapterKey: "codex", hostApiToken: `token-of-${runId}`, hostApiUrl: api.url,
        onLog: async (_stream, chunk) => { logs.push(chunk); },
      });
      if (!bridge) throw new Error("no bridge was started");
      cleanup.push(() => bridge.stop());
      return bridge;
    };
    const pidFile = () => readFile(path.join(bridgeFolder, "queue", "server.pid"), "utf8").then((text) => text.trim()).catch(() => null);
    const readyPid = () => readFile(path.join(bridgeFolder, "queue", "ready.json"), "utf8").then((text) => (JSON.parse(text) as { pid: number }).pid).catch(() => null);
    return { startBridge, bridgeFolder, pidFile, readyPid, logs };
  }

  type Bridge = { env: Record<string, string> };
  /** What a role does: one write to Paperclip through the address its run was given. */
  async function roleWrites(bridge: Bridge, text: string) {
    try {
      const response = await fetch(`${bridge.env.PAPERCLIP_API_URL}/api/companies/company-1/agent-commentary`, {
        method: "POST", headers: { authorization: `Bearer ${bridge.env.PAPERCLIP_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ text }), signal: AbortSignal.timeout(20_000),
      });
      return { status: response.status, body: await response.text() };
    } catch (error) {
      return { status: 0, body: String((error as { cause?: { code?: string } }).cause?.code ?? error) };
    }
  }
  const alive = (pid: number | null) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
  /** The timer of a kept bridge, as `execute` arms it, with a delay a trial can wait for. */
  async function keptBridgeTimerFires(bridge: { stop(): Promise<void> }) {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let stopped!: () => void;
    const done = new Promise<void>((resolve) => { stopped = resolve; });
    deferOrphanedBridgeStop({ bridge: { stop: async () => { try { await bridge.stop(); } finally { stopped(); } } }, maxDelayMs: 50 });
    await done;
  }

  it("the timer of the kept bridge spares the bridge of the next run, which still relays a real write", async () => {
    const api = await paperclipApi();
    const folder = await reservation(api);
    // The first run ends without proof that its engine stopped: its bridge is kept.
    const kept = await folder.startBridge("run-65663cf0");
    // The next run of the reservation starts its own bridge in the same folder.
    const next = await folder.startBridge("run-0e7e0a7e");
    const nextPid = await folder.readyPid();
    expect(alive(nextPid)).toBe(true);

    await keptBridgeTimerFires(kept);

    // Past the kept bridge's timer, the role of the run at work still reaches Paperclip.
    expect(alive(nextPid)).toBe(true);
    expect(await folder.readyPid()).toBe(nextPid);
    expect(await folder.pidFile()).toBe(String(nextPid));
    const write = await roleWrites(next, "after the tenth minute");
    expect(write.status).toBe(200);
    expect(JSON.parse(write.body)).toEqual({ ok: true, relayedFor: "run-0e7e0a7e" });
    expect(api.received.filter((call) => call.body.includes("after the tenth minute")).map((call) => [call.method, call.runId]))
      .toEqual([["POST", "run-0e7e0a7e"]]);
  }, 90_000);

  it("a write of the run at work is relayed once: one response, one write, under its own run", async () => {
    const api = await paperclipApi();
    const folder = await reservation(api);
    await folder.startBridge("run-65663cf0");
    const next = await folder.startBridge("run-0e7e0a7e");
    // While the first bridge would still be kept: before any timer.
    const write = await roleWrites(next, "one comment");
    expect(write.status).toBe(200);
    // Leave a second relay, if there were one, the time to make its call.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(api.received.map((call) => [call.method, call.url, call.runId, JSON.parse(call.body).text]))
      .toEqual([["POST", "/api/companies/company-1/agent-commentary", "run-0e7e0a7e", "one comment"]]);
    expect(JSON.parse(write.body)).toEqual({ ok: true, relayedFor: "run-0e7e0a7e" });
  }, 90_000);

  it("the bridge an earlier run kept is stopped whole at the launch of the next one: its address refuses, and the launch says so", async () => {
    const api = await paperclipApi();
    const folder = await reservation(api);
    const kept = await folder.startBridge("run-65663cf0");
    const keptPid = await folder.readyPid();
    expect((await roleWrites(kept, "from the first run")).status).toBe(200);
    const next = await folder.startBridge("run-0e7e0a7e");
    // The machine half: its process is gone and its address refuses.
    expect(alive(keptPid)).toBe(false);
    expect((await roleWrites(kept, "from the engine of the finished run")).status).toBe(0);
    expect(folder.logs.join("")).toContain("Stopping the callback bridge an earlier run kept in this folder before starting a new one.");
    // The new bridge is the folder's, and works.
    expect(await folder.readyPid()).not.toBe(keptPid);
    expect((await roleWrites(next, "from the second run")).status).toBe(200);
    expect(api.received.map((call) => call.runId)).toEqual(["run-65663cf0", "run-0e7e0a7e"]);
    // The kept bridge's own stop, when its timer or its run asks for it later, does nothing more.
    await kept.stop();
    expect((await roleWrites(next, "after the late stop")).status).toBe(200);
  }, 90_000);

  it("two launches one after the other in the same run (the tools refresh): the second bridge stays alive", async () => {
    const api = await paperclipApi();
    const folder = await reservation(api);
    // The first launch of the run ends and stops its bridge, then the engine is launched again.
    const first = await folder.startBridge("run-5282b80d");
    expect((await roleWrites(first, "first launch")).status).toBe(200);
    await first.stop();
    expect(await folder.pidFile()).toBeNull();
    const second = await folder.startBridge("run-5282b80d");
    expect(second.env.PAPERCLIP_API_URL).not.toBe(first.env.PAPERCLIP_API_URL);
    expect(folder.logs.join("")).not.toContain("Stopping the callback bridge an earlier run kept");
    expect(folder.logs.join("")).not.toContain("Stopped the callback bridge an earlier run had left");
    // A late or repeated stop of the first launch does not touch the second.
    await first.stop();
    const secondPid = await folder.readyPid();
    expect(alive(secondPid)).toBe(true);
    expect(await folder.pidFile()).toBe(String(secondPid));
    expect((await roleWrites(second, "second launch")).status).toBe(200);
    expect(api.received.map((call) => JSON.parse(call.body).text)).toEqual(["first launch", "second launch"]);
  }, 90_000);

  it("the bridges of two task folders do not touch each other", async () => {
    const api = await paperclipApi();
    const one = await reservation(api);
    const other = await reservation(api);
    const a = await one.startBridge("run-a");
    const b = await other.startBridge("run-b");
    expect((await roleWrites(a, "in one folder")).status).toBe(200);
    expect((await roleWrites(b, "in the other")).status).toBe(200);
    await a.stop();
    expect((await roleWrites(b, "after the other stopped")).status).toBe(200);
    expect(api.received.map((call) => call.runId)).toEqual(["run-a", "run-b", "run-b"]);
  }, 90_000);
});
