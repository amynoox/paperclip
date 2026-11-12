import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, ClaudePreparedProcessInput } from "@paperclipai/adapter-utils";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

// The prepared-process boundary for live steering on the Claude CLI engine,
// mirroring codexPreparedProcess: the hook receives exactly the native launch,
// and native cleanup waits for the owner's proof that the provider stopped.
const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  syncDirectoryToSsh,
  bridgeStop,
  startAdapterExecutionTargetPaperclipBridge,
} = vi.hoisted(() => {
  const bridgeStop = vi.fn(async () => {});
  return {
    runChildProcess: vi.fn(async (_runId: string, _command: string, args: string[]): Promise<RunProcessResult> => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: args.includes("--version") ? "2.1.284 (Claude Code)\n" : "",
      stderr: "",
      pid: 123,
      startedAt: new Date().toISOString(),
    })),
    ensureCommandResolvable: vi.fn(async () => undefined),
    resolveCommandForLogs: vi.fn(async () => "ssh://fixture@127.0.0.1:2222/remote/workspace :: claude"),
    prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
    restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
    runSshCommand: vi.fn(async () => ({ stdout: "", stderr: "" })),
    syncDirectoryToSsh: vi.fn(async () => undefined),
    bridgeStop,
    startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => ({
      env: {
        PAPERCLIP_API_URL: "http://127.0.0.1:4310",
        PAPERCLIP_API_KEY: "bridge-token",
        PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
      },
      runLogTail: { fixture: true },
      stop: bridgeStop,
    })),
  };
});

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return { ...actual, ensureCommandResolvable, resolveCommandForLogs, runChildProcess };
});

vi.mock("@paperclipai/adapter-utils/ssh", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/ssh")>(
    "@paperclipai/adapter-utils/ssh",
  );
  return { ...actual, prepareWorkspaceForSshExecution, restoreWorkspaceFromSshExecution, runSshCommand, syncDirectoryToSsh };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return { ...actual, startAdapterExecutionTargetPaperclipBridge };
});

import { execute } from "./execute.js";
import * as serverModule from "./index.js";
import { resetClaudeCliCapabilitiesCacheForTests } from "./cli-capabilities.js";

const SESSION = "12345678-1234-4abc-9def-123456789012";
const RUN = "run-prepared";
const REMOTE = `/remote/workspace/.paperclip-runtime/runs/${RUN}/workspace`;

// Recorded stream of one process that received two input messages.
const RECORDED_STREAM = [
  JSON.stringify({ type: "system", subtype: "init", session_id: SESSION, model: "claude-opus-5" }),
  JSON.stringify({ type: "assistant", session_id: SESSION, message: { content: [{ type: "text", text: "first" }] } }),
  JSON.stringify({ type: "result", session_id: SESSION, subtype: "success", is_error: false, result: "first",
    usage: { input_tokens: 3, cache_read_input_tokens: 0, output_tokens: 2 } }),
  JSON.stringify({ type: "assistant", session_id: SESSION, message: { content: [{ type: "text", text: "steered" }] } }),
  JSON.stringify({ type: "result", session_id: SESSION, subtype: "success", is_error: false, result: "steered",
    usage: { input_tokens: 5, cache_read_input_tokens: 0, output_tokens: 4 } }),
].join("\n");

function processResult(overrides: Partial<RunProcessResult> = {}): RunProcessResult {
  return { exitCode: 0, signal: null, timedOut: false, stdout: RECORDED_STREAM, stderr: "", pid: 321,
    startedAt: new Date().toISOString(), ...overrides };
}

describe("claude prepared interactive process", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    resetClaudeCliCapabilitiesCacheForTests();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function context(input: {
    hook?: AdapterExecutionContext["claudePreparedProcess"];
    liveSteering?: boolean;
    owner?: boolean;
  }): Promise<AdapterExecutionContext> {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-prepared-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    return {
      runId: RUN,
      agent: { id: "agent-1", companyId: "company-1", name: "Claude Coder", adapterType: "claude_local", adapterConfig: {} },
      runtime: {
        sessionId: SESSION,
        sessionParams: {
          sessionId: SESSION,
          cwd: REMOTE,
          remoteExecution: { transport: "ssh", host: "127.0.0.1", port: 2222, username: "fixture", remoteCwd: REMOTE },
        },
        sessionDisplayId: SESSION,
        taskKey: null,
      },
      config: { model: "claude-opus-5", engine: "cli", command: "claude", experimentalLiveSteering: input.liveSteering ?? Boolean(input.hook) },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1", port: 2222, username: "fixture",
          remoteWorkspacePath: "/remote/workspace", remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY", knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA", strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
      ...(input.owner ?? Boolean(input.hook) ? { registerInteractiveControl: () => () => {} } : {}),
      ...(input.hook ? { claudePreparedProcess: input.hook } : {}),
    } as AdapterExecutionContext;
  }

  const providerRuns = () => runChildProcess.mock.calls.filter(call => !call[2].includes("--version"));

  it("advertises the prepared-process boundary to the host", () => {
    expect(serverModule.supportsPreparedInteractiveProcess).toBe(true);
  });

  it("keeps the native launch and cleanup when no hook is installed", async () => {
    runChildProcess.mockImplementation(async (_runId: string, _command: string, args: string[]) =>
      args.includes("--version") ? processResult({ stdout: "2.1.284 (Claude Code)\n" }) : processResult());
    const result = await execute(await context({}));
    expect(result.exitCode).toBe(0);
    expect(providerRuns()).toHaveLength(1);
    expect(bridgeStop).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledTimes(1);
  });

  it("hands the hook the unchanged native launch and cleans up after the proven provider stop", async () => {
    let received: ClaudePreparedProcessInput | null = null;
    const hook = vi.fn(async (prepared: ClaudePreparedProcessInput) => {
      received = prepared;
      prepared.options.onProcessStopped?.();
      return processResult();
    });
    const ctx = await context({ hook });
    const result = await execute(ctx);

    expect(hook).toHaveBeenCalledTimes(1);
    expect(providerRuns()).toHaveLength(0);
    const prepared = received as unknown as ClaudePreparedProcessInput;
    expect(prepared.runId).toBe(RUN);
    expect(prepared.command).toBe("claude");
    expect(prepared.args).toEqual(expect.arrayContaining(["--resume", SESSION, "--model", "claude-opus-5"]));
    expect(prepared.args).toEqual(expect.arrayContaining(["--output-format", "stream-json"]));
    expect(prepared.resumeSessionId).toBe(SESSION);
    expect(prepared.model).toBe("claude-opus-5");
    expect(prepared.target).toMatchObject({ kind: "remote", transport: "ssh" });
    expect(typeof prepared.options.stdin).toBe("string");
    expect(prepared.options.stdin?.length).toBeGreaterThan(0);
    expect(prepared.options.cwd).toBeTruthy();
    expect(prepared.options.env).toMatchObject({ PAPERCLIP_API_BRIDGE_MODE: "queue_v1" });
    expect(prepared.options.terminalResultCleanup).toMatchObject({ graceMs: expect.any(Number) });
    expect(prepared.options.runLogTail).toEqual({ fixture: true });

    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe(SESSION);
    expect(result.summary).toBe("steered");
    expect(bridgeStop).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledTimes(1);
  });

  it("keeps the bridge and the remote workspace when the hook fails with an unknown provider state", async () => {
    const hook = vi.fn(async () => { throw new Error("SSH lost; provider status unknown"); });
    await expect(execute(await context({ hook }))).rejects.toThrow(/provider status unknown/);
    expect(bridgeStop).not.toHaveBeenCalled();
    expect(restoreWorkspaceFromSshExecution).not.toHaveBeenCalled();
  });

  it("does not clean up after a success-looking result without the provider stop proof", async () => {
    const hook = vi.fn(async () => processResult());
    await execute(await context({ hook }));
    expect(bridgeStop).not.toHaveBeenCalled();
    expect(restoreWorkspaceFromSshExecution).not.toHaveBeenCalled();
  });

  it.each([
    ["live steering is off", { liveSteering: false, owner: true }],
    ["the host owner is missing", { liveSteering: true, owner: false }],
  ] as const)("refuses the hook before launch when %s", async (_label, flags) => {
    const hook = vi.fn(async () => processResult());
    await expect(execute(await context({ hook, ...flags }))).rejects.toThrow(/requires host opt-in/);
    expect(hook).not.toHaveBeenCalled();
    expect(providerRuns()).toHaveLength(0);
    expect(bridgeStop).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledTimes(1);
  });

  it("does not retry an unknown session with a fresh launch when the hook owns the process", async () => {
    const hook = vi.fn(async (prepared: ClaudePreparedProcessInput) => {
      prepared.options.onProcessStopped?.();
      return processResult({
        exitCode: 1,
        stdout: JSON.stringify({ type: "result", session_id: SESSION, is_error: true, subtype: "error_during_execution",
          result: `No conversation found with session id ${SESSION}` }),
      });
    });
    const result = await execute(await context({ hook }));
    expect(hook).toHaveBeenCalledTimes(1);
    expect(providerRuns()).toHaveLength(0);
    expect(result.exitCode).toBe(1);
  });
});
