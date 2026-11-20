import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  syncDirectoryToSsh,
  startAdapterExecutionTargetPaperclipBridge,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async (_runId: string, _command: string, _args: string[]): Promise<RunProcessResult> => {
    throw new Error("no engine result was set for this case");
  }),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "claude"),
  prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  runSshCommand: vi.fn(async () => ({ stdout: "", stderr: "" })),
  syncDirectoryToSsh: vi.fn(async () => undefined),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => ({
    env: { PAPERCLIP_API_URL: "http://127.0.0.1:4310", PAPERCLIP_API_KEY: "bridge-token", PAPERCLIP_API_BRIDGE_MODE: "queue_v1" },
    stop: async () => {},
  })),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>("@paperclipai/adapter-utils/server-utils");
  return { ...actual, ensureCommandResolvable, resolveCommandForLogs, runChildProcess };
});
vi.mock("@paperclipai/adapter-utils/ssh", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/ssh")>("@paperclipai/adapter-utils/ssh");
  return { ...actual, prepareWorkspaceForSshExecution, restoreWorkspaceFromSshExecution, runSshCommand, syncDirectoryToSsh };
});
vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>("@paperclipai/adapter-utils/execution-target");
  return { ...actual, startAdapterExecutionTargetPaperclipBridge };
});

import { createPromptContextFixture } from "@paperclipai/adapter-utils/test-fixtures/prompt-context";
import { execute } from "./execute.js";
import { resetClaudeCliCapabilitiesCacheForTests } from "./cli-capabilities.js";

// STUDIO-0080 (L13). A run of `claude_local` that ends without Claude's final `result` (the engine killed by a
// pause, the ssh link to the machine lost, the run's own timeout) returned no session, so the conversation
// Claude had announced in `system`/`init` was lost and the next run started from nothing.
const NEW = "11111111-1111-4111-8111-111111111111";
const KEPT = "22222222-2222-4222-8222-222222222222";
const FRESH = "33333333-3333-4333-8333-333333333333";

const init = (sessionId: string) => JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: "claude-sonnet" });
const assistant = (sessionId: string, text: string) =>
  JSON.stringify({ type: "assistant", session_id: sessionId, message: { content: [{ type: "text", text }] } });
const result = (sessionId: string) =>
  JSON.stringify({ type: "result", session_id: sessionId, subtype: "success", is_error: false, result: "done",
    usage: { input_tokens: 3, cache_read_input_tokens: 0, output_tokens: 2 } });

type Engine = Partial<RunProcessResult> & { stdout: string };
const proc = (engine: Engine): RunProcessResult => ({
  exitCode: 0, signal: null, timedOut: false, stderr: "", pid: 123, startedAt: new Date().toISOString(), ...engine,
});
// The engine killed after it announced its session: no `result` line.
const killedAfterInit = (sessionId: string): Engine => ({ exitCode: null, signal: "SIGTERM", stdout: [init(sessionId), assistant(sessionId, "working")].join("\n") });
const linkLostAfterInit = (sessionId: string): Engine => ({ exitCode: 255, stdout: [init(sessionId), assistant(sessionId, "working")].join("\n"),
  stderr: "client_loop: send disconnect: Broken pipe\n" });
const timedOutAfterInit = (sessionId: string): Engine => ({ exitCode: null, signal: "SIGTERM", timedOut: true, stdout: [init(sessionId), assistant(sessionId, "working")].join("\n") });
const succeeded = (sessionId: string): Engine => ({ stdout: [init(sessionId), assistant(sessionId, "working"), result(sessionId)].join("\n") });

describe("claude_local: the session of a run that failed", () => {
  const cleanupDirs: string[] = [];
  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    resetClaudeCliCapabilitiesCacheForTests();
    while (cleanupDirs.length > 0) await rm(cleanupDirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
  });

  // Each engine launch answers with the next result; `--version` probes are answered apart.
  function engineAnswers(...answers: Engine[]) {
    const queue = [...answers];
    runChildProcess.mockImplementation(async (_runId, _command, args) => {
      if (args.includes("--version")) return proc({ stdout: "2.1.284 (Claude Code)\n" });
      const next = queue.shift();
      if (!next) throw new Error("the engine was launched more often than the case allows");
      return proc(next);
    });
  }
  const launches = () => runChildProcess.mock.calls.filter((call) => !(call[2] as string[]).includes("--version"));
  const resumedIn = (call: unknown[]) => { const args = call[2] as string[]; const at = args.indexOf("--resume"); return at >= 0 ? args[at + 1] : null; };

  async function run(input: { remote?: boolean; runtime?: { sessionId: string; sessionParams: Record<string, unknown> } | null; timeoutSec?: number } = {}):
  Promise<{ result: AdapterExecutionResult; workspaceDir: string }> {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-failed-run-session-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    const result = await execute({
      runId: "run-failed-session",
      agent: { id: "agent-1", companyId: "company-1", name: "Claude Coder", adapterType: "claude_local", adapterConfig: {} },
      runtime: input.runtime
        // The working folder is this run's own: a session kept for another folder would not be resumed at all.
        ? { sessionId: input.runtime.sessionId, sessionParams: { ...input.runtime.sessionParams, cwd: workspaceDir },
          sessionDisplayId: input.runtime.sessionId, taskKey: null }
        : { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { model: "claude-opus-5", engine: "cli", command: "claude", env: { ANTHROPIC_API_KEY: "fixture-anthropic-key" },
        ...(input.timeoutSec ? { timeoutSec: input.timeoutSec } : {}) },
      context: {
        ...createPromptContextFixture(),
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary", workspaceId: "workspace-1",
          repoUrl: "https://github.com/paperclipai/paperclip.git", repoRef: "main" },
      },
      ...(input.remote ? { executionTransport: { remoteExecution: { host: "127.0.0.1", port: 2222, username: "fixture",
        remoteWorkspacePath: "/remote/workspace", remoteCwd: "/remote/workspace", privateKey: "PRIVATE KEY",
        knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA", strictHostKeyChecking: true } } } : {}),
      onLog: async () => {},
    });
    return { result, workspaceDir };
  }
  // The cumulative ledger is the one field a success adds on top of what a cut run can know.
  const withoutLedger = (params: Record<string, unknown> | null | undefined) => {
    const { claudeSessionTotals: _ledger, ...rest } = params ?? {};
    return rest;
  };

  it.each([
    ["killed by a pause", killedAfterInit],
    ["cut by a lost ssh link", linkLostAfterInit],
  ] as Array<[string, (sessionId: string) => Engine]>)("returns the session Claude announced when the engine is %s", async (_name, cut) => {
    engineAnswers(cut(NEW));
    const { result, workspaceDir } = await run();
    expect(result.timedOut).toBe(false);
    expect(result.sessionId).toBe(NEW);
    expect(result.sessionDisplayId).toBe(NEW);
    expect(result.sessionParams).toMatchObject({ sessionId: NEW, cwd: workspaceDir, workspaceId: "workspace-1",
      repoUrl: "https://github.com/paperclipai/paperclip.git", repoRef: "main" });
    expect(result.sessionParams).toHaveProperty("promptBundleKey");
    expect(result.clearSession).toBe(false);
    expect(launches()).toHaveLength(1);
  });

  it("returns the session Claude announced when the run reaches its timeout", async () => {
    engineAnswers(timedOutAfterInit(NEW));
    const { result, workspaceDir } = await run({ timeoutSec: 30 });
    expect(result).toMatchObject({ timedOut: true, errorCode: "timeout", errorMessage: "Timed out after 30s" });
    expect(result.sessionId).toBe(NEW);
    expect(result.sessionDisplayId).toBe(NEW);
    expect(result.sessionParams).toMatchObject({ sessionId: NEW, cwd: workspaceDir });
    expect(result.clearSession).toBe(false);
  });

  it.each([
    ["the engine is killed", { exitCode: null, signal: "SIGTERM", stdout: "" }],
    ["the link is lost", { exitCode: 255, stdout: "", stderr: "client_loop: send disconnect: Broken pipe\n" }],
    ["the run reaches its timeout", { exitCode: null, signal: "SIGTERM", timedOut: true, stdout: "" }],
  ] as Array<[string, Engine]>)("returns no session when Claude announced none before %s", async (_name, engine) => {
    engineAnswers(engine);
    const { result } = await run({ timeoutSec: 30 });
    expect(result.sessionId).toBeUndefined();
    expect(result.sessionParams).toBeUndefined();
    expect(result.sessionDisplayId).toBeUndefined();
    expect(result.clearSession).toBe(false);
  });

  it.each([false, true])("keeps with a cut run the same parameters as with a success (remote=%s)", async (remote) => {
    engineAnswers(succeeded(NEW));
    const success = (await run({ remote })).result;
    expect(success.sessionId).toBe(NEW);
    for (const cut of [killedAfterInit, timedOutAfterInit]) {
      vi.clearAllMocks();
      resetClaudeCliCapabilitiesCacheForTests();
      engineAnswers(cut(NEW));
      const failure = (await run({ remote, timeoutSec: 30 })).result;
      // The working folder differs from one temporary fixture to the next; every other key must be the same.
      const { cwd: successCwd, ...successRest } = withoutLedger(success.sessionParams);
      const { cwd: failureCwd, ...failureRest } = withoutLedger(failure.sessionParams);
      expect(Object.keys(failureRest).sort()).toEqual(Object.keys(successRest).sort());
      expect(failureRest).toEqual(successRest);
      expect(typeof failureCwd).toBe(typeof successCwd);
      if (remote) {
        expect(failure.sessionParams).toMatchObject({ remoteExecution: { transport: "ssh", host: "127.0.0.1", port: 2222, username: "fixture" } });
      } else {
        expect(failure.sessionParams).not.toHaveProperty("remoteExecution");
      }
    }
  });

  it("a resumed run cut after the announcement keeps the session and its ledger baseline", async () => {
    engineAnswers(killedAfterInit(KEPT));
    const baseline = { sessionId: KEPT, modelUsage: {}, totalCostUsd: 1.25 };
    const { result } = await run({ runtime: { sessionId: KEPT, sessionParams: { sessionId: KEPT, claudeSessionTotals: baseline } } });
    expect(resumedIn(launches()[0]!)).toBe(KEPT);
    expect(result.sessionId).toBe(KEPT);
    expect(result.sessionParams).toMatchObject({ sessionId: KEPT, claudeSessionTotals: { sessionId: KEPT, totalCostUsd: 1.25 } });
    expect(result.clearSession).toBe(false);
  });

  it("a resumed run cut before any announcement returns no session: the kept one is neither replaced nor cleared", async () => {
    engineAnswers({ exitCode: null, signal: "SIGTERM", stdout: "" });
    const { result } = await run({ runtime: { sessionId: KEPT, sessionParams: { sessionId: KEPT } } });
    expect(resumedIn(launches()[0]!)).toBe(KEPT);
    expect(result.sessionId).toBeUndefined();
    expect(result.clearSession).toBe(false);
  });

  // The session returned by a cut run may be one Claude cannot reopen (cut before it wrote anything). The
  // existing fallback applies at the first resume: the refusal is recognised and the same run starts fresh.
  const rejected = (sessionId: string): Engine => ({ exitCode: 1, stdout: JSON.stringify({ type: "result", session_id: sessionId,
    is_error: true, subtype: "error_during_execution", result: `No conversation found with session id ${sessionId}` }) });

  it("a session returned by a cut run that Claude refuses to reopen: the next run starts fresh, with no loop", async () => {
    engineAnswers(killedAfterInit(NEW));
    const cut = (await run()).result;
    expect(cut.sessionId).toBe(NEW);

    vi.clearAllMocks();
    resetClaudeCliCapabilitiesCacheForTests();
    engineAnswers(rejected(NEW), succeeded(FRESH));
    const next = (await run({ runtime: { sessionId: NEW, sessionParams: withoutLedger(cut.sessionParams) } })).result;
    // Two launches and no more: the refused resume, then the fresh session.
    expect(launches().map(resumedIn)).toEqual([NEW, null]);
    expect(next.exitCode).toBe(0);
    expect(next.sessionId).toBe(FRESH);
    expect(next.clearSession).toBe(false);
  });

  it("the fresh retry after a refused resume is cut too: its own session replaces the refused one", async () => {
    engineAnswers(rejected(KEPT), killedAfterInit(FRESH));
    const { result } = await run({ runtime: { sessionId: KEPT, sessionParams: { sessionId: KEPT } } });
    expect(launches().map(resumedIn)).toEqual([KEPT, null]);
    expect(result.sessionId).toBe(FRESH);
    expect(result.sessionParams).toMatchObject({ sessionId: FRESH });
    // Returning the new session replaces the refused one; clearing would drop the new one with it.
    expect(result.clearSession).toBe(false);
  });

  it("the fresh retry after a refused resume is cut before any announcement: the refused session is cleared, as before", async () => {
    engineAnswers(rejected(KEPT), { exitCode: null, signal: "SIGTERM", stdout: "" });
    const { result } = await run({ runtime: { sessionId: KEPT, sessionParams: { sessionId: KEPT } } });
    expect(launches().map(resumedIn)).toEqual([KEPT, null]);
    expect(result.sessionId).toBeUndefined();
    expect(result.clearSession).toBe(true);
  });

  it("a successful run is unchanged: its session and its parameters", async () => {
    engineAnswers(succeeded(NEW));
    const { result, workspaceDir } = await run();
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe(NEW);
    expect(result.sessionParams).toMatchObject({ sessionId: NEW, cwd: workspaceDir, workspaceId: "workspace-1" });
    expect(result.clearSession).toBe(false);
  });
});
