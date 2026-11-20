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

  it("stops the kept bridge when the run is cancelled without a provider stop receipt", async () => {
    // Production case: the operator cancels, the wrapper raises without calling
    // onProcessStopped (worker unreachable). The bridge must not keep polling.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const controller = new AbortController();
    const hook = vi.fn(async () => {
      controller.abort(new Error("operator cancel"));
      throw new Error("router_cancelled");
    });
    const ctx = { ...(await context({ hook })), signal: controller.signal };
    await expect(execute(ctx)).rejects.toThrow(/router_cancelled/);
    await vi.waitFor(() => expect(bridgeStop).toHaveBeenCalledTimes(1));
    expect(restoreWorkspaceFromSshExecution).not.toHaveBeenCalled();
  });

  it("stops the kept bridge on a provider stop receipt that arrives after the call returned", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let late: (() => void) | undefined;
    const hook = vi.fn(async (prepared: ClaudePreparedProcessInput) => {
      late = prepared.options.onProcessStopped;
      return processResult();
    });
    const ctx = { ...(await context({ hook })), signal: new AbortController().signal };
    await execute(ctx);
    expect(bridgeStop).not.toHaveBeenCalled();
    late?.();
    await vi.waitFor(() => expect(bridgeStop).toHaveBeenCalledTimes(1));
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

  // STUDIO-0075: production, 20 Nov 2026. A routed Claude run lost the link to its worker machine after Claude had
  // opened its session; the wrapper's entry point threw, nothing was returned, and the retry opened a new session in
  // the same remote folder. The adapter now tells the host the session as soon as Claude announces it.
  describe("the session of a run that is cut", () => {
    const NEW = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    type Session = { sessionId: string; sessionDisplayId: string | null; sessionParams: Record<string, unknown> };
    const init = (sessionId: string) => JSON.stringify({ type: "system", subtype: "init", session_id: sessionId });
    /** The wrapper's entry point: Claude announces its session in the stream, then the link is lost. */
    const lostLinkAfter = (lines: string[]) => vi.fn(async (prepared: ClaudePreparedProcessInput) => {
      for (const line of lines) await prepared.options.onLog?.("stdout", `${line}\n`);
      throw new Error("router_provider_stop_unverified");
    });
    const fresh = { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null };
    async function cutRun(lines = [init(NEW)]) {
      const announced: Session[] = [];
      const ctx = { ...(await context({ hook: lostLinkAfter(lines) })), runtime: fresh,
        onSessionAnnounced: async (session: Session) => { announced.push(session); } } as AdapterExecutionContext;
      await expect(execute(ctx)).rejects.toThrow(/router_provider_stop_unverified/);
      return announced;
    }
    /** The next run of the task, given a saved session: which session does it ask Claude to resume? */
    async function retryWith(session: Session) {
      const logs: string[] = [];
      let received: ClaudePreparedProcessInput | null = null;
      const hook = vi.fn(async (prepared: ClaudePreparedProcessInput) => {
        received = prepared;
        prepared.options.onProcessStopped?.();
        return processResult();
      });
      await execute({ ...(await context({ hook })),
        runtime: { sessionId: session.sessionId, sessionParams: session.sessionParams, sessionDisplayId: session.sessionId, taskKey: null },
        onLog: async (_stream: string, chunk: string) => { logs.push(chunk); } } as AdapterExecutionContext);
      const prepared = received as unknown as ClaudePreparedProcessInput;
      return { resumeSessionId: prepared.resumeSessionId, args: prepared.args, logs: logs.join("") };
    }

    it("tells the host the session as soon as Claude announces it, and still fails with the lost link", async () => {
      const announced = await cutRun();
      expect(announced).toHaveLength(1);
      expect(announced[0]).toMatchObject({ sessionId: NEW, sessionDisplayId: NEW,
        sessionParams: { sessionId: NEW, cwd: REMOTE,
          remoteExecution: { transport: "ssh", host: "127.0.0.1", port: 2222, username: "fixture", remoteCwd: REMOTE } } });
    });

    it("the retry resumes that session on the same machine and folder", async () => {
      const [session] = await cutRun();
      const retry = await retryWith(session!);
      expect(retry.resumeSessionId).toBe(NEW);
      expect(retry.args).toEqual(expect.arrayContaining(["--resume", NEW]));
    });

    it("does not resume it on another machine nor in another folder, and the run's log says so", async () => {
      const [session] = await cutRun();
      const params = session!.sessionParams as { remoteExecution: Record<string, unknown> };
      const otherMachine = await retryWith({ ...session!, sessionParams: { ...params, remoteExecution: { ...params.remoteExecution, host: "10.0.0.9" } } });
      expect(otherMachine.resumeSessionId).toBeNull();
      expect(otherMachine.args).not.toContain("--resume");
      expect(otherMachine.logs).toMatch(new RegExp(`Claude session "${NEW}" does not match the current execution target and will not be resumed`));
      const otherFolder = await retryWith({ ...session!, sessionParams: { ...params, cwd: "/remote/elsewhere",
        remoteExecution: { ...params.remoteExecution, remoteCwd: "/remote/elsewhere" } } });
      expect(otherFolder.resumeSessionId).toBeNull();
      expect(otherFolder.args).not.toContain("--resume");
      expect(otherFolder.logs).toMatch(new RegExp(`Claude session "${NEW}" .* will not be resumed`));
    });

    it("tells nothing when the link is lost before Claude announced a session, nor for an id Claude cannot resume", async () => {
      expect(await cutRun([JSON.stringify({ type: "assistant" })])).toHaveLength(0);
      expect(await cutRun([init("not-a-uuid")])).toHaveLength(0);
    });

    it("says so in the run's log when the host cannot record the session, and fails with the same error", async () => {
      const logs: string[] = [];
      const ctx = { ...(await context({ hook: lostLinkAfter([init(NEW)]) })), runtime: fresh,
        onSessionAnnounced: async () => { throw new Error("database unavailable"); },
        onLog: async (_stream: string, chunk: string) => { logs.push(chunk); } } as AdapterExecutionContext;
      await expect(execute(ctx)).rejects.toThrow(/router_provider_stop_unverified/);
      expect(logs.join("")).toMatch(new RegExp(`The session "${NEW}" announced by Claude could not be recorded before the end of the run: database unavailable`));
    });

    it("starts a new session and says so when Claude refuses to resume the saved one", async () => {
      const logs: string[] = [];
      let provider = 0;
      runChildProcess.mockImplementation(async (_runId: string, _command: string, args: string[]) => {
        if (args.includes("--version")) return processResult({ stdout: "2.1.284 (Claude Code)\n" });
        provider += 1;
        return provider === 1
          ? processResult({ exitCode: 1, stdout: JSON.stringify({ type: "result", session_id: SESSION, is_error: true,
            subtype: "error_during_execution", result: `No conversation found with session id ${SESSION}` }) })
          : processResult();
      });
      await execute({ ...(await context({})), onLog: async (_stream: string, chunk: string) => { logs.push(chunk); } } as AdapterExecutionContext);
      expect(logs.join("")).toContain(`[paperclip] Claude resume session "${SESSION}" is unavailable; retrying with a fresh session.`);
      expect(providerRuns()).toHaveLength(2);
      expect(providerRuns()[0]![2]).toEqual(expect.arrayContaining(["--resume", SESSION]));
      expect(providerRuns()[1]![2]).not.toContain("--resume");
    });
  });
});
