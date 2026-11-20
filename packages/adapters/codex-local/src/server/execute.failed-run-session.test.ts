import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";

type EngineResult = { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string; pid: number; startedAt: string };
type EngineOptions = { onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void> };

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
  runChildProcess: vi.fn(async (_runId: string, _command: string, _args: string[], _options: EngineOptions): Promise<EngineResult> => {
    throw new Error("no engine result was set for this case");
  }),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "/usr/bin/codex"),
  prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  runSshCommand: vi.fn(async () => ({ stdout: Buffer.from("{}").toString("base64"), stderr: "" })),
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

// STUDIO-0080 (L13). `codex_local` already returns the session of `thread.started` when its engine is killed or
// its link is lost; it did not when the run reached its own timeout, so that conversation was lost.
const NEW = "thread-new";
const KEPT = "thread-kept";
const FRESH = "thread-fresh";

const started = (threadId: string) => JSON.stringify({ type: "thread.started", thread_id: threadId });
const completed = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });

type Engine = Partial<EngineResult> & { stdout: string; hangMs?: number };
const proc = (engine: Engine): EngineResult => ({
  exitCode: 0, signal: null, timedOut: false, stderr: "", pid: 123, startedAt: new Date().toISOString(),
  ...engine,
});
const timedOutAfterStart = (threadId: string): Engine => ({ exitCode: null, signal: "SIGTERM", timedOut: true, stdout: `${started(threadId)}\n` });
const killedAfterStart = (threadId: string): Engine => ({ exitCode: null, signal: "SIGTERM", stdout: `${started(threadId)}\n` });
const linkLostAfterStart = (threadId: string): Engine => ({ exitCode: 255, stdout: `${started(threadId)}\n`,
  stderr: "client_loop: send disconnect: Broken pipe\n" });
const succeeded = (threadId: string): Engine => ({ stdout: `${started(threadId)}\n${completed}\n` });

describe("codex_local: the session of a run that failed", () => {
  const cleanupDirs: string[] = [];
  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    while (cleanupDirs.length > 0) await rm(cleanupDirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
  });

  function engineAnswers(...answers: Engine[]) {
    const queue = [...answers];
    runChildProcess.mockImplementation(async (_runId, _command, _args, options) => {
      const next = queue.shift();
      if (!next) throw new Error("the engine was launched more often than the case allows");
      const { hangMs, ...engine } = next;
      // The engine's output reaches the adapter as it is written, then the engine may stay silent.
      if (engine.stdout) await options.onLog?.("stdout", engine.stdout);
      if (hangMs) await new Promise((resolve) => setTimeout(resolve, hangMs));
      return proc(engine);
    });
  }
  const resumedIn = (call: unknown[]) => { const args = call[2] as string[]; const at = args.indexOf("resume"); return at >= 0 ? args[at + 1] : null; };
  const launches = () => runChildProcess.mock.calls as unknown[][];

  async function run(input: { remote?: boolean; runtime?: { sessionId: string; sessionParams: Record<string, unknown> } | null;
    timeoutSec?: number; outputInactivityTimeoutMs?: number | null } = {}): Promise<{ result: AdapterExecutionResult; workspaceDir: string }> {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-failed-run-session-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    const result = await execute({
      runId: "run-failed-session",
      agent: { id: "agent-1", companyId: "company-1", name: "Codex Coder", adapterType: "codex_local", adapterConfig: {} },
      runtime: input.runtime
        // The working folder is this run's own: a session kept for another folder would not be resumed at all.
        ? { sessionId: input.runtime.sessionId, sessionParams: { ...input.runtime.sessionParams, cwd: workspaceDir },
          sessionDisplayId: input.runtime.sessionId, taskKey: null }
        : { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { engine: "cli", command: "codex", env: { CODEX_HOME: codexHomeDir, OPENAI_API_KEY: "fixture-openai-key" },
        ...(input.timeoutSec ? { timeoutSec: input.timeoutSec } : {}),
        ...(input.outputInactivityTimeoutMs !== undefined ? { outputInactivityTimeoutMs: input.outputInactivityTimeoutMs } : {}) },
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

  it("returns the session Codex announced when the run reaches its timeout", async () => {
    engineAnswers(timedOutAfterStart(NEW));
    const { result, workspaceDir } = await run({ timeoutSec: 30 });
    expect(result).toMatchObject({ timedOut: true, errorMessage: "Timed out after 30s" });
    expect(result.sessionId).toBe(NEW);
    expect(result.sessionDisplayId).toBe(NEW);
    expect(result.sessionParams).toEqual({ sessionId: NEW, cwd: workspaceDir, workspaceId: "workspace-1",
      repoUrl: "https://github.com/paperclipai/paperclip.git", repoRef: "main" });
    expect(result.clearSession).toBe(false);
    expect(launches()).toHaveLength(1);
  });

  it("returns no session when the run reaches its timeout before Codex announced one", async () => {
    engineAnswers({ exitCode: null, signal: "SIGTERM", timedOut: true, stdout: "" });
    const { result } = await run({ timeoutSec: 30 });
    expect(result.timedOut).toBe(true);
    expect(result.sessionId).toBeUndefined();
    expect(result.sessionParams).toBeUndefined();
    expect(result.sessionDisplayId).toBeUndefined();
    expect(result.clearSession).toBe(false);
  });

  it.each([
    ["killed by a pause", killedAfterStart],
    ["cut by a lost ssh link", linkLostAfterStart],
  ] as Array<[string, (threadId: string) => Engine]>)("still returns the announced session when the engine is %s, as before", async (_name, cut) => {
    engineAnswers(cut(NEW));
    const { result, workspaceDir } = await run();
    expect(result.timedOut).toBe(false);
    expect(result.sessionId).toBe(NEW);
    expect(result.sessionParams).toMatchObject({ sessionId: NEW, cwd: workspaceDir });
  });

  it.each([false, true])("keeps with a timed-out run the same parameters as with a success (remote=%s)", async (remote) => {
    engineAnswers(succeeded(NEW));
    const success = (await run({ remote })).result;
    expect(success.sessionId).toBe(NEW);
    vi.clearAllMocks();
    engineAnswers(timedOutAfterStart(NEW));
    const failure = (await run({ remote, timeoutSec: 30 })).result;
    // The working folder differs from one temporary fixture to the next; every other key must be the same.
    const { cwd: successCwd, ...successRest } = success.sessionParams ?? {};
    const { cwd: failureCwd, ...failureRest } = failure.sessionParams ?? {};
    expect(failureRest).toEqual(successRest);
    expect(typeof failureCwd).toBe(typeof successCwd);
    if (remote) {
      expect(failure.sessionParams).toMatchObject({ remoteExecution: { transport: "ssh", host: "127.0.0.1", port: 2222, username: "fixture" } });
    } else {
      expect(failure.sessionParams).not.toHaveProperty("remoteExecution");
    }
  });

  // Codex reports its tokens at the end of a turn only. On a timeout, what it last said is the one sign the host
  // has that it was at work: a role that says what it starts, then compiles in silence until its timeout.
  const said = (text: string) => JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });
  const commandStarted = JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "unity -batchmode -buildTarget StandaloneWindows64" } });

  it("a run that reaches its timeout after Codex said something returns what it last said", async () => {
    engineAnswers({ exitCode: null, signal: "SIGTERM", timedOut: true,
      stdout: [started(NEW), said("Reading the build settings."), said("Starting the player build; this takes a while."), commandStarted].join("\n") });
    const { result } = await run({ timeoutSec: 30 });
    expect(result.timedOut).toBe(true);
    expect(result.summary).toBe("Starting the player build; this takes a while.");
    expect(result.sessionId).toBe(NEW);
  });

  it("a run that reaches its timeout before Codex said anything returns an empty summary", async () => {
    // The session announced, then silence: the shape of a session that no longer answers.
    engineAnswers(timedOutAfterStart(NEW));
    const { result } = await run({ timeoutSec: 30 });
    expect(result.timedOut).toBe(true);
    expect(result.summary).toBe("");
    expect(result.sessionId).toBe(NEW);
  });

  // The owner, 20 Nov 2026: a role under Codex keeps its conversation when its run is stopped after thirty
  // minutes without output. The monitor returned no session, on purpose; it returns the announced one now.
  const silentAfterStart = (threadId: string): Engine => ({ exitCode: null, signal: "SIGTERM", stdout: `${started(threadId)}\n`, hangMs: 400 });

  it("the output-inactivity monitor stops the engine and returns the session Codex announced, with its parameters", async () => {
    // Codex announces its session, then stays silent longer than the monitor allows.
    engineAnswers(silentAfterStart(NEW));
    const { result, workspaceDir } = await run({ outputInactivityTimeoutMs: 100 });
    expect(result.errorCode).toBe("codex_output_inactivity_monitor");
    expect(result.timedOut).toBe(false);
    expect(result.sessionId).toBe(NEW);
    expect(result.sessionDisplayId).toBe(NEW);
    expect(result.sessionParams).toEqual({ sessionId: NEW, cwd: workspaceDir, workspaceId: "workspace-1",
      repoUrl: "https://github.com/paperclipai/paperclip.git", repoRef: "main" });
    expect(result.clearSession).toBe(false);
  });

  it("the session the monitor returned is the one the next run resumes", async () => {
    engineAnswers(silentAfterStart(NEW), succeeded(NEW));
    const stopped = (await run({ outputInactivityTimeoutMs: 100 })).result;
    expect(stopped.errorCode).toBe("codex_output_inactivity_monitor");
    const next = (await run({ runtime: { sessionId: stopped.sessionId!, sessionParams: stopped.sessionParams ?? {} } })).result;
    // Two launches: the one the monitor stopped, opened on nothing, then the resume of its session.
    expect(launches().map(resumedIn)).toEqual([null, NEW]);
    expect(next.exitCode).toBe(0);
    expect(next.sessionId).toBe(NEW);
  });

  it("the monitor stops an engine that announced nothing: no session, and nothing cleared", async () => {
    engineAnswers({ exitCode: null, signal: "SIGTERM", stdout: "", hangMs: 400 });
    const { result } = await run({ outputInactivityTimeoutMs: 100 });
    expect(result.errorCode).toBe("codex_output_inactivity_monitor");
    expect(result.sessionId).toBeNull();
    expect(result.sessionParams).toBeNull();
    expect(result.sessionDisplayId).toBeNull();
    expect(result.clearSession).toBe(false);
    // A resumed run that announced nothing: no session is made up from the kept one.
    vi.clearAllMocks();
    engineAnswers({ exitCode: null, signal: "SIGTERM", stdout: "", hangMs: 400 });
    const resumed = (await run({ outputInactivityTimeoutMs: 100, runtime: { sessionId: KEPT, sessionParams: { sessionId: KEPT } } })).result;
    expect(resumedIn(launches()[0]!)).toBe(KEPT);
    expect(resumed.sessionId).toBeNull();
    expect(resumed.clearSession).toBe(false);
  });

  it("a resumed run the monitor stops keeps its session", async () => {
    engineAnswers(silentAfterStart(KEPT));
    const { result } = await run({ outputInactivityTimeoutMs: 100, runtime: { sessionId: KEPT, sessionParams: { sessionId: KEPT } } });
    expect(resumedIn(launches()[0]!)).toBe(KEPT);
    expect(result.errorCode).toBe("codex_output_inactivity_monitor");
    expect(result.sessionId).toBe(KEPT);
    expect(result.clearSession).toBe(false);
  });

  it("the fresh retry after a refused resume is stopped by the monitor: its own session replaces the refused one, or the refused one is cleared", async () => {
    engineAnswers(rejected(KEPT), silentAfterStart(FRESH));
    const announced = (await run({ outputInactivityTimeoutMs: 100, runtime: { sessionId: KEPT, sessionParams: { sessionId: KEPT } } })).result;
    expect(launches().map(resumedIn)).toEqual([KEPT, null]);
    expect(announced.errorCode).toBe("codex_output_inactivity_monitor");
    expect(announced.sessionId).toBe(FRESH);
    expect(announced.clearSession).toBe(false);
    // Stopped before any announcement: the refused session is cleared, as before.
    vi.clearAllMocks();
    engineAnswers(rejected(KEPT), { exitCode: null, signal: "SIGTERM", stdout: "", hangMs: 400 });
    const silent = (await run({ outputInactivityTimeoutMs: 100, runtime: { sessionId: KEPT, sessionParams: { sessionId: KEPT } } })).result;
    expect(silent.sessionId).toBeNull();
    expect(silent.clearSession).toBe(true);
  });

  it("the monitor wins over the timeout when both ended the run: the session is returned under the monitor's code", async () => {
    engineAnswers({ exitCode: null, signal: "SIGTERM", timedOut: true, stdout: `${started(NEW)}\n`, hangMs: 400 });
    const { result } = await run({ outputInactivityTimeoutMs: 100, timeoutSec: 30 });
    expect(result.errorCode).toBe("codex_output_inactivity_monitor");
    expect(result.timedOut).toBe(false);
    expect(result.sessionId).toBe(NEW);
  });

  it("a resumed run that reaches its timeout after the announcement keeps the session", async () => {
    engineAnswers(timedOutAfterStart(KEPT));
    const { result } = await run({ timeoutSec: 30, runtime: { sessionId: KEPT, sessionParams: { sessionId: KEPT } } });
    expect(resumedIn(launches()[0]!)).toBe(KEPT);
    expect(result.sessionId).toBe(KEPT);
    expect(result.clearSession).toBe(false);
  });

  it("a resumed run that reaches its timeout before any announcement returns no session: the kept one is neither replaced nor cleared", async () => {
    engineAnswers({ exitCode: null, signal: "SIGTERM", timedOut: true, stdout: "" });
    const { result } = await run({ timeoutSec: 30, runtime: { sessionId: KEPT, sessionParams: { sessionId: KEPT } } });
    expect(resumedIn(launches()[0]!)).toBe(KEPT);
    expect(result.sessionId).toBeUndefined();
    expect(result.clearSession).toBe(false);
  });

  // A session returned by a timed-out run may be one Codex cannot reopen. The existing fallback applies at the
  // first resume: the refusal is recognised and the same run starts fresh.
  const rejected = (threadId: string): Engine => ({ exitCode: 1, stdout: "", stderr: `unknown thread id ${threadId}` });

  it("a session returned by a timed-out run that Codex refuses to reopen: the next run starts fresh, with no loop", async () => {
    engineAnswers(timedOutAfterStart(NEW));
    const cut = (await run({ timeoutSec: 30 })).result;
    expect(cut.sessionId).toBe(NEW);

    vi.clearAllMocks();
    engineAnswers(rejected(NEW), succeeded(FRESH));
    const next = (await run({ runtime: { sessionId: NEW, sessionParams: cut.sessionParams ?? {} } })).result;
    // Two launches and no more: the refused resume, then the fresh session.
    expect(launches().map(resumedIn)).toEqual([NEW, null]);
    expect(next.exitCode).toBe(0);
    expect(next.sessionId).toBe(FRESH);
    expect(next.clearSession).toBe(false);
  });

  it("the fresh retry after a refused resume reaches its timeout: its own session replaces the refused one", async () => {
    engineAnswers(rejected(KEPT), timedOutAfterStart(FRESH));
    const { result } = await run({ timeoutSec: 30, runtime: { sessionId: KEPT, sessionParams: { sessionId: KEPT } } });
    expect(launches().map(resumedIn)).toEqual([KEPT, null]);
    expect(result.sessionId).toBe(FRESH);
    // Returning the new session replaces the refused one; clearing would drop the new one with it.
    expect(result.clearSession).toBe(false);
  });

  it("the fresh retry after a refused resume reaches its timeout before any announcement: the refused session is cleared, as before", async () => {
    engineAnswers(rejected(KEPT), { exitCode: null, signal: "SIGTERM", timedOut: true, stdout: "" });
    const { result } = await run({ timeoutSec: 30, runtime: { sessionId: KEPT, sessionParams: { sessionId: KEPT } } });
    expect(launches().map(resumedIn)).toEqual([KEPT, null]);
    expect(result.sessionId).toBeUndefined();
    expect(result.clearSession).toBe(true);
  });

  it("a successful run is unchanged: its session and its parameters", async () => {
    engineAnswers(succeeded(NEW));
    const { result, workspaceDir } = await run();
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe(NEW);
    expect(result.sessionParams).toEqual({ sessionId: NEW, cwd: workspaceDir, workspaceId: "workspace-1",
      repoUrl: "https://github.com/paperclipai/paperclip.git", repoRef: "main" });
  });
});
