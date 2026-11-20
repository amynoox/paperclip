import { execFile as execFileCallback, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareCommandManagedRuntime } from "./command-managed-runtime.js";
import { deferOrphanedBridgeStop } from "./provider-stopped-boundary.js";
import {
  createSandboxCallbackBridgeAsset,
  createSandboxCallbackBridgeToken,
  sandboxCallbackBridgeDirectories,
  startSandboxCallbackBridgeServer,
} from "./sandbox-callback-bridge.js";
import type { RunProcessResult } from "./server-utils.js";

const execFile = promisify(execFileCallback);

// STUDIO-0082. Production, 20 Nov 2026 (TR-2030 on MAC-02 at 03:10:47, TR-2153 on MAC-01 at 09:27:19): a run ended
// without proof that its engine had stopped, so its callback bridge was kept for ten minutes. The next run of the
// same worker-router reservation launched its own bridge in the same folder. When the first bridge's timer fired, its
// stop read `server.pid` at that moment, killed the bridge of the run at work and removed its files; the role got
// ECONNREFUSED on PAPERCLIP_API_URL for the rest of its run, and the old bridge stayed alive on the machine.
//
// These cases launch the real bridge server (the real entrypoint, a real `node` process, the real shell lines), on
// this machine, through a runner that executes the commands locally.
describe("sandbox callback bridge: each bridge is known by the process its own launch started (STUDIO-0082)", () => {
  const cleanupDirs: string[] = [];
  const cleanupFns: Array<() => Promise<void>> = [];
  const strays: ChildProcess[] = [];
  const startedPids: number[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const pid of startedPids.splice(0)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    for (const child of strays.splice(0)) child.kill("SIGKILL");
    for (const fn of cleanupFns.splice(0).reverse()) await fn().catch(() => undefined);
    for (const dir of cleanupDirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  type ExecInput = { command: string; args?: string[]; cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number };
  /** Executes each command on this machine. `rewriteLaunchReport` stands in for a launch whose report differs. */
  function createExecRunner(rewriteLaunchReport?: (stdout: string) => string) {
    return {
      execute: async (input: ExecInput): Promise<RunProcessResult> => {
        const startedAt = new Date().toISOString();
        const command = input.command === "sh" ? "/bin/sh" : input.command === "bash" ? "/bin/bash" : input.command;
        const env: Record<string, string | undefined> = { ...process.env, ...input.env };
        const args = [...(input.args ?? [])];
        // The command's input, as the existing bridge tests give it to a local shell.
        if (input.stdin != null && (input.command === "sh" || input.command === "bash") && (args[0] === "-c" || args[0] === "-lc") && typeof args[1] === "string") {
          env.PAPERCLIP_TEST_STDIN = input.stdin;
          args[1] = `printf '%s' "$PAPERCLIP_TEST_STDIN" | (${args[1]})`;
        }
        try {
          const result = await execFile(command, args, { cwd: input.cwd, env, maxBuffer: 32 * 1024 * 1024, timeout: input.timeoutMs });
          const isLaunchReport = /^\{"pid":\d+,"stoppedStalePid":\d+\}\s*$/.test(result.stdout);
          return { exitCode: 0, signal: null, timedOut: false, stderr: result.stderr, pid: null, startedAt,
            stdout: isLaunchReport && rewriteLaunchReport ? rewriteLaunchReport(result.stdout) : result.stdout };
        } catch (error) {
          const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: string | number | null; signal?: NodeJS.Signals | null; killed?: boolean };
          return { exitCode: typeof err.code === "number" ? err.code : null, signal: err.signal ?? null, timedOut: Boolean(err.killed && input.timeoutMs),
            stdout: err.stdout ?? "", stderr: err.stderr ?? "", pid: null, startedAt };
        }
      },
    };
  }

  /** One task folder on the "machine": the runs of a reservation all work in it, so they share its bridge folder. */
  async function taskFolder() {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-own-process-"));
    cleanupDirs.push(rootDir);
    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    await mkdir(localWorkspaceDir, { recursive: true });
    await mkdir(remoteWorkspaceDir, { recursive: true });
    const bridgeAsset = await createSandboxCallbackBridgeAsset();
    cleanupFns.push(bridgeAsset.cleanup);
    const prepared = await prepareCommandManagedRuntime({
      runner: createExecRunner(), spec: { remoteCwd: remoteWorkspaceDir, timeoutMs: 30_000 }, adapterKey: "codex",
      workspaceLocalDir: localWorkspaceDir, assets: [{ key: "bridge", localDir: bridgeAsset.localDir }],
    });
    const queueDir = path.posix.join(prepared.runtimeRootDir, "paperclip-bridge");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    const launch = async (runner = createExecRunner()) => {
      const bridge = await startSandboxCallbackBridgeServer({
        runner, remoteCwd: remoteWorkspaceDir, assetRemoteDir: prepared.assetDirs.bridge, queueDir,
        bridgeToken: createSandboxCallbackBridgeToken(), timeoutMs: 30_000,
      });
      startedPids.push(bridge.pid);
      return bridge;
    };
    return { directories, launch };
  }

  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  /** The bridge answers on its address: a request without its token is refused by the bridge itself. */
  async function reachable(baseUrl: string): Promise<boolean> {
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(5_000) });
      return response.status === 401;
    } catch {
      return false;
    }
  }
  const pidFileOf = async (directories: { pidFile: string }) => (await readFile(directories.pidFile, "utf8").catch(() => null))?.trim() ?? null;
  const readyPidOf = async (directories: { readyFile: string }) => {
    const text = await readFile(directories.readyFile, "utf8").catch(() => null);
    return text ? (JSON.parse(text) as { pid: number }).pid : null;
  };
  /** The timer of a kept bridge, as `execute` arms it, with a delay a trial can wait for. */
  async function keptBridgeTimerFires(bridge: { stop(): Promise<void> }) {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let stopped!: () => void;
    const done = new Promise<void>((resolve) => { stopped = resolve; });
    deferOrphanedBridgeStop({ bridge: { stop: async () => { try { await bridge.stop(); } finally { stopped(); } } }, maxDelayMs: 50 });
    await done;
  }

  it("bridge A kept, bridge B launched in the same folder, A's timer fires: B stays alive and reachable, and its files stay", async () => {
    const folder = await taskFolder();
    const a = await folder.launch();
    expect(await reachable(a.baseUrl)).toBe(true);
    // The next run of the reservation: its own bridge, in the same folder.
    const b = await folder.launch();
    expect(b.pid).not.toBe(a.pid);
    expect(await pidFileOf(folder.directories)).toBe(String(b.pid));
    expect(await readyPidOf(folder.directories)).toBe(b.pid);

    await keptBridgeTimerFires(a);

    expect(alive(b.pid)).toBe(true);
    expect(await reachable(b.baseUrl)).toBe(true);
    expect(await pidFileOf(folder.directories)).toBe(String(b.pid));
    expect(await readyPidOf(folder.directories)).toBe(b.pid);
    // And the old bridge is not left on the machine.
    expect(alive(a.pid)).toBe(false);
    expect(await reachable(a.baseUrl)).toBe(false);

    // B's own stop, at the end of its run, is unchanged: its process ends and its files go.
    await b.stop();
    expect(alive(b.pid)).toBe(false);
    expect(await pidFileOf(folder.directories)).toBeNull();
    expect(await readyPidOf(folder.directories)).toBeNull();
  }, 60_000);

  it("bridge A alone: its timer stops it and removes its files, as before", async () => {
    const folder = await taskFolder();
    const a = await folder.launch();
    // On a POSIX shell the process the launch started is the bridge itself.
    expect(a.launchPid).toBe(a.pid);
    expect(a.stoppedStalePid).toBe(0);
    expect(await pidFileOf(folder.directories)).toBe(String(a.pid));
    await keptBridgeTimerFires(a);
    expect(alive(a.pid)).toBe(false);
    expect(await reachable(a.baseUrl)).toBe(false);
    expect(await pidFileOf(folder.directories)).toBeNull();
    expect(await readyPidOf(folder.directories)).toBeNull();
    // A second stop of a bridge already gone is harmless.
    await a.stop();
  }, 60_000);

  it("the bridge a previous run left in the folder is stopped at the launch of the new one, by its own number", async () => {
    const folder = await taskFolder();
    const a = await folder.launch();
    const b = await folder.launch();
    // Before any stop or timer: the launch itself ended A, and says so.
    expect(b.stoppedStalePid).toBe(a.launchPid);
    expect(alive(a.pid)).toBe(false);
    expect(await reachable(a.baseUrl)).toBe(false);
    expect(alive(b.pid)).toBe(true);
    expect(await reachable(b.baseUrl)).toBe(true);
    await b.stop();
  }, 60_000);

  it("A's stop after B's launch removes neither B's server.pid nor B's ready.json, even when A's process is already gone", async () => {
    const folder = await taskFolder();
    const a = await folder.launch();
    const b = await folder.launch();
    expect(alive(a.pid)).toBe(false);
    await a.stop();
    await a.stop();
    expect(alive(b.pid)).toBe(true);
    expect(await pidFileOf(folder.directories)).toBe(String(b.pid));
    expect(await readyPidOf(folder.directories)).toBe(b.pid);
    expect(await reachable(b.baseUrl)).toBe(true);
    await b.stop();
  }, 60_000);

  it("a launch does not end a process that is not a bridge of this folder, whatever server.pid says", async () => {
    const folder = await taskFolder();
    const other = await taskFolder();
    // A number reused after a restart of the machine: some other program.
    const stranger = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    strays.push(stranger);
    await mkdir(path.dirname(folder.directories.pidFile), { recursive: true });
    await writeFile(folder.directories.pidFile, `${stranger.pid}\n`, "utf8");
    const first = await folder.launch();
    expect(first.stoppedStalePid).toBe(0);
    expect(alive(stranger.pid!)).toBe(true);
    await first.stop();
    // The bridge of another task folder: a bridge, but not this folder's.
    const elsewhere = await other.launch();
    await writeFile(folder.directories.pidFile, `${elsewhere.pid}\n`, "utf8");
    const second = await folder.launch();
    expect(second.stoppedStalePid).toBe(0);
    expect(alive(elsewhere.pid)).toBe(true);
    expect(await reachable(elsewhere.baseUrl)).toBe(true);
    // Words that are no number at all.
    await second.stop();
    await writeFile(folder.directories.pidFile, "not a number; kill 1\n", "utf8");
    const third = await folder.launch();
    expect(third.stoppedStalePid).toBe(0);
    await third.stop();
    await elsewhere.stop();
  }, 90_000);

  it("stop() does not end a process that took the bridge's number, and leaves a server.pid that is not its own", async () => {
    const folder = await taskFolder();
    const stranger = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    strays.push(stranger);
    // The launch reports a number that the system shows, at the stop, to be another program.
    const bridge = await folder.launch(createExecRunner((stdout) => stdout.replace(/"pid":\d+/, `"pid":${stranger.pid}`)));
    expect(bridge.launchPid).toBe(stranger.pid);
    await bridge.stop();
    expect(alive(stranger.pid!)).toBe(true);
    // server.pid holds another number than the one this handle knows: it is not removed.
    expect(await pidFileOf(folder.directories)).toBe(String(bridge.pid));
    // ready.json is exactly what this bridge wrote: it is removed.
    expect(await readyPidOf(folder.directories)).toBeNull();
  }, 60_000);

  it("a launch whose report cannot be read falls back on the number the bridge wrote in ready.json", async () => {
    const folder = await taskFolder();
    const bridge = await folder.launch(createExecRunner(() => "some wrapper banner\n"));
    expect(bridge.launchPid).toBe(bridge.pid);
    expect(bridge.stoppedStalePid).toBe(0);
    await bridge.stop();
    expect(alive(bridge.pid)).toBe(false);
    expect(await pidFileOf(folder.directories)).toBeNull();
    expect(await readyPidOf(folder.directories)).toBeNull();
  }, 60_000);

  it("the launch report is read among other lines a wrapper may print", async () => {
    const folder = await taskFolder();
    const a = await folder.launch();
    const b = await folder.launch(createExecRunner((stdout) => `Warning: Permanently added host.\n${stdout}connection closed\n`));
    expect(b.launchPid).toBe(b.pid);
    expect(b.stoppedStalePid).toBe(a.launchPid);
    await b.stop();
    expect(alive(b.pid)).toBe(false);
  }, 60_000);
});
