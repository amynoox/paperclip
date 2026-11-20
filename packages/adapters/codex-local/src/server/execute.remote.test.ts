import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  runChildProcess: vi.fn(async () => ({
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "remote failure",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "/usr/bin/codex"),
  prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  runSshCommand: vi.fn(async () => ({ stdout: Buffer.from("{}").toString("base64"), stderr: "" })),
  syncDirectoryToSsh: vi.fn(async () => undefined),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => ({
    env: {
      PAPERCLIP_API_URL: "http://127.0.0.1:4310",
      PAPERCLIP_API_KEY: "bridge-token",
      PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
    },
    stop: async () => {},
  })),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
  };
});

vi.mock("@paperclipai/adapter-utils/ssh", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/ssh")>(
    "@paperclipai/adapter-utils/ssh",
  );
  return {
    ...actual,
    prepareWorkspaceForSshExecution,
    restoreWorkspaceFromSshExecution,
    runSshCommand,
    syncDirectoryToSsh,
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    startAdapterExecutionTargetPaperclipBridge,
  };
});

import { createPromptContextFixture } from "@paperclipai/adapter-utils/test-fixtures/prompt-context";
import { execute } from "./execute.js";

describe("codex remote execution", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("prepares the workspace, syncs CODEX_HOME, and restores workspace changes for remote SSH execution", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-remote-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-1/workspace";
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(rootDir, "instructions.md"), "Use the remote workspace.\n", "utf8");
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");
    const alternateWorkspaceDir = path.join(rootDir, "alternate-workspace");
    await mkdir(alternateWorkspaceDir, { recursive: true });

    await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        engine: "cli",
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
          strategy: "git_worktree",
          workspaceId: "workspace-1",
          repoUrl: "https://github.com/paperclipai/paperclip.git",
          repoRef: "main",
          branchName: "feature/remote-codex",
          worktreePath: workspaceDir,
        },
        paperclipWorkspaces: [
          {
            workspaceId: "workspace-1",
            cwd: workspaceDir,
            repoUrl: "https://github.com/paperclipai/paperclip.git",
            repoRef: "main",
          },
          {
            workspaceId: "workspace-2",
            cwd: alternateWorkspaceDir,
            repoUrl: "https://github.com/paperclipai/paperclip.git",
            repoRef: "feature/other",
          },
        ],
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledTimes(1);
    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      localDir: workspaceDir,
      remoteDir: managedRemoteWorkspace,
    }));
    expect(syncDirectoryToSsh).toHaveBeenCalledTimes(1);
    // The home asset now syncs a curated *staged* allowlist dir, not the raw
    // managed CODEX_HOME, and carries no `exclude` denylist.
    const homeSyncArgs = (syncDirectoryToSsh.mock.calls[0] as unknown[])?.[0] as {
      localDir: string;
      remoteDir: string;
      followSymlinks?: boolean;
      exclude?: string[];
    };
    expect(homeSyncArgs.localDir).not.toBe(codexHomeDir);
    expect(homeSyncArgs.localDir).toContain("paperclip-codex-home-sync");
    expect(homeSyncArgs.remoteDir).toBe(`${managedRemoteWorkspace}/.paperclip-runtime/codex/home`);
    expect(homeSyncArgs.followSymlinks).toBe(true);
    expect(homeSyncArgs.exclude).toBeUndefined();

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], { env: Record<string, string>; remoteExecution?: { remoteCwd: string } | null }]
      | undefined;
    expect(call?.[2]).not.toContain("--skip-git-repo-check");
    expect(call?.[3].env.CODEX_HOME).toBe(`${managedRemoteWorkspace}/.paperclip-runtime/codex/home`);
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_CWD).toBe(managedRemoteWorkspace);
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_WORKTREE_PATH).toBeUndefined();
    expect(JSON.parse(call?.[3].env.PAPERCLIP_WORKSPACES_JSON ?? "[]")).toEqual([
      {
        workspaceId: "workspace-1",
        cwd: managedRemoteWorkspace,
        repoUrl: "https://github.com/paperclipai/paperclip.git",
        repoRef: "main",
      },
      {
        workspaceId: "workspace-2",
        repoUrl: "https://github.com/paperclipai/paperclip.git",
        repoRef: "feature/other",
      },
    ]);
    expect(call?.[3].env.PAPERCLIP_API_URL).toBe("http://127.0.0.1:4310");
    expect(call?.[3].env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");
    expect(call?.[3].remoteExecution?.remoteCwd).toBe(managedRemoteWorkspace);
    expect(startAdapterExecutionTargetPaperclipBridge).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      localDir: workspaceDir,
      remoteDir: managedRemoteWorkspace,
    }));
  });

  it("stages only the allowlist into the home asset: keeps config.toml/skills/auth, drops session+sqlite state, no exclude", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-allowlist-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });

    // Seed the managed home with the files Codex needs (config.toml carries a
    // provider-routing block; skills injected) plus large runtime decoys the
    // old 4-name denylist missed.
    await writeFile(path.join(codexHomeDir, "auth.json"), '{"tokens":{"account_id":"a","refresh_token":"r"}}', "utf8");
    await writeFile(
      path.join(codexHomeDir, "config.toml"),
      'model_provider = "bifrost"\n\n[model_providers.bifrost]\nname = "bifrost"\n',
      "utf8",
    );
    await writeFile(path.join(codexHomeDir, "instructions.md"), "hi\n", "utf8");
    await mkdir(path.join(codexHomeDir, "skills", "demo"), { recursive: true });
    await writeFile(path.join(codexHomeDir, "skills", "demo", "SKILL.md"), "# demo\n", "utf8");
    // Decoys:
    await writeFile(path.join(codexHomeDir, "logs_2.sqlite"), "x", "utf8");
    await writeFile(path.join(codexHomeDir, "state_5.sqlite"), "x", "utf8");
    await mkdir(path.join(codexHomeDir, "sessions"), { recursive: true });
    await writeFile(path.join(codexHomeDir, "sessions", "rollout.jsonl"), "x", "utf8");
    await mkdir(path.join(codexHomeDir, "tmp"), { recursive: true });
    await symlink("/usr/bin/env", path.join(codexHomeDir, "tmp", "arg0"));

    // Snapshot the staged dir contents at sync time — execute() removes the
    // staged temp dir on teardown, so we cannot read it after execute returns.
    let stagedSnapshot:
      | { localDir: string; entries: string[]; skillEntries: string[]; configToml: string; authJson: string }
      | null = null;
    (syncDirectoryToSsh as unknown as {
      mockImplementationOnce: (fn: (args: { localDir: string }) => Promise<void>) => void;
    }).mockImplementationOnce(async (args: { localDir: string }) => {
      const entries = (await readdir(args.localDir)).sort();
      const skillEntries = entries.includes("skills")
        ? (await readdir(path.join(args.localDir, "skills"))).sort()
        : [];
      const configToml = entries.includes("config.toml")
        ? await readFile(path.join(args.localDir, "config.toml"), "utf8")
        : "";
      const authJson = entries.includes("auth.json")
        ? await readFile(path.join(args.localDir, "auth.json"), "utf8")
        : "";
      stagedSnapshot = { localDir: args.localDir, entries, skillEntries, configToml, authJson };
    });

    await execute({
      runId: "run-allowlist",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        engine: "cli",
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(stagedSnapshot).not.toBeNull();
    const snap = stagedSnapshot as unknown as {
      localDir: string;
      entries: string[];
      skillEntries: string[];
      configToml: string;
      authJson: string;
    };
    // Allowlist present; decoys gone.
    expect(snap.entries).toEqual(
      ["auth.json", "config.json", "config.toml", "instructions.md", "skills"]
        .filter((e) => e !== "config.json") // no config.json was seeded
        .sort(),
    );
    for (const decoy of ["logs_2.sqlite", "state_5.sqlite", "sessions", "tmp", "plugins"]) {
      expect(snap.entries).not.toContain(decoy);
    }
    // Phase-3 behavioral invariants: provider routing + skills + auth survive staging.
    expect(snap.configToml).toContain("[model_providers.bifrost]");
    expect(snap.configToml).toContain("model_provider");
    expect(snap.skillEntries).toContain("demo");
    expect(snap.authJson).toContain("refresh_token");

    // The staged temp dir is removed after execute completes (cleanup on teardown).
    await expect(readdir(snap.localDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not resume saved Codex sessions for remote SSH execution without a matching remote identity", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-remote-resume-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");

    await execute({
      runId: "run-ssh-no-resume",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "session-123",
        sessionParams: {
          sessionId: "session-123",
          cwd: "/remote/workspace",
        },
        sessionDisplayId: "session-123",
        taskKey: null,
      },
      config: {
        engine: "cli",
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    expect(call?.[2].slice(call[2].indexOf("exec"))).toEqual([
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "-",
    ]);
  });

  it("resumes saved Codex sessions for remote SSH execution when the remote identity matches", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-remote-resume-match-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-ssh-resume/workspace";
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");

    await execute({
      runId: "run-ssh-resume",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "session-123",
        sessionParams: {
          sessionId: "session-123",
          cwd: managedRemoteWorkspace,
          remoteExecution: {
            transport: "ssh",
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteCwd: managedRemoteWorkspace,
          },
        },
        sessionDisplayId: "session-123",
        taskKey: null,
      },
      config: {
        engine: "cli",
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    expect(call?.[2].slice(call[2].indexOf("exec"))).toEqual([
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "resume",
      "session-123",
      "-",
    ]);
  });

  it("uses the provider-neutral execution target contract for remote SSH execution", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-target-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-target/workspace";
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");

    await execute({
      runId: "run-target",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "session-123",
        sessionParams: {
          sessionId: "session-123",
          cwd: managedRemoteWorkspace,
          remoteExecution: {
            transport: "ssh",
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteCwd: managedRemoteWorkspace,
          },
        },
        sessionDisplayId: "session-123",
        taskKey: null,
      },
      config: {
        engine: "cli",
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTarget: {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/remote/workspace",
        spec: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(syncDirectoryToSsh).toHaveBeenCalledTimes(1);
    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], { env: Record<string, string>; remoteExecution?: { remoteCwd: string } | null }]
      | undefined;
    expect(call?.[2].slice(call[2].indexOf("exec"))).toEqual([
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "resume",
      "session-123",
      "-",
    ]);
    expect(call?.[3].env.CODEX_HOME).toBe(`${managedRemoteWorkspace}/.paperclip-runtime/codex/home`);
    expect(call?.[3].remoteExecution?.remoteCwd).toBe(managedRemoteWorkspace);
  });

  it("runs in place at the authoritative root without archive prepare or restore", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-in-place-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");

    await execute({
      runId: "run-in-place",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { engine: "cli", command: "codex", env: { CODEX_HOME: codexHomeDir } },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "task_session",
        },
      },
      executionTarget: {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/copied/workspace",
        workspaceRealization: {
          mode: "in_place",
          authoritativeRoot: "/app",
          pathAliases: [],
          outboundRestorePaths: [],
        },
        spec: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/app",
          remoteCwd: "/app",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(prepareWorkspaceForSshExecution).not.toHaveBeenCalled();
    expect(syncDirectoryToSsh).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).not.toHaveBeenCalled();
    const homeSyncArgs = (syncDirectoryToSsh.mock.calls[0] as unknown[])?.[0] as {
      localDir: string;
      remoteDir: string;
    };
    expect(homeSyncArgs.localDir).toContain("paperclip-codex-home-sync");
    expect(homeSyncArgs.remoteDir).toBe("/app/.paperclip-runtime/codex/home");
    const call = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], { env: Record<string, string>; remoteExecution?: { remoteCwd: string } | null }]
      | undefined;
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_CWD).toBe("/app");
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_REALIZATION_MODE).toBe("in_place");
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_AUTHORITATIVE_ROOT).toBe("/app");
    expect(call?.[3].env.CODEX_HOME).toBe("/app/.paperclip-runtime/codex/home");
    expect(call?.[3].remoteExecution?.remoteCwd).toBe("/app");
  });

  it("reselects the full assignment and bootstrap guidance after a failed resume", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-cli-fallback-context-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    runChildProcess
      .mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "unknown thread id session-old",
        pid: 123,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({ type: "thread.started", thread_id: "session-fresh" }),
          JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
        ].join("\\n"),
        stderr: "",
        pid: 124,
        startedAt: new Date().toISOString(),
      });

    await execute({
      runId: "run-codex-cli-fallback-context",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Codex Coder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "session-old",
        sessionParams: { sessionId: "session-old", cwd: workspaceDir },
        sessionDisplayId: "session-old",
        taskKey: null,
      },
      config: {
        engine: "cli",
        command: "codex",
        env: { OPENAI_API_KEY: "fixture-openai-key" },
      },
      context: {
        ...createPromptContextFixture(),
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
      },
      onLog: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(2);
    const first = (runChildProcess.mock.calls[0] as unknown as [string, string, string[], { stdin?: string }])[3]?.stdin ?? "";
    const retry = (runChildProcess.mock.calls[1] as unknown as [string, string, string[], { stdin?: string }])[3]?.stdin ?? "";
    expect(first).toContain("## Compact assignment");
    expect(first).not.toContain("Explain the next step before starting work.");
    expect(retry).toContain("## Owned assignment");
    expect(retry).toContain("Explain the next step before starting work.");
    expect(retry).not.toContain("## Compact assignment");
    expect(retry.indexOf("comment-first")).toBeLessThan(retry.indexOf("comment-second"));
    expect(retry.split("Append the same ledger entry.")).toHaveLength(3);
  });


  it("stops the kept bridge when a prepared run is cancelled without a provider stop receipt", async () => {
    // Production case: the operator cancels, the wrapper raises without calling
    // onProcessStopped (worker unreachable). The bridge must not keep polling.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bridgeStop = vi.fn(async () => {});
    startAdapterExecutionTargetPaperclipBridge.mockResolvedValueOnce({
      env: {
        PAPERCLIP_API_URL: "http://127.0.0.1:4310",
        PAPERCLIP_API_KEY: "bridge-token",
        PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
      },
      stop: bridgeStop,
    });
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-remote-cancel-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");
    const controller = new AbortController();
    const codexPreparedProcess = vi.fn(async () => {
      controller.abort(new Error("operator cancel"));
      throw new Error("router_cancelled");
    });

    await expect(execute({
      runId: "run-ssh-prepared-cancel",
      agent: { id: "agent-1", companyId: "company-1", name: "CodexCoder", adapterType: "codex_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { engine: "cli", command: "codex", experimentalLiveSteering: true, env: { CODEX_HOME: codexHomeDir } },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      registerInteractiveControl: () => () => {},
      codexPreparedProcess,
      signal: controller.signal,
      onLog: async () => {},
    })).rejects.toThrow(/router_cancelled/);

    expect(codexPreparedProcess).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(bridgeStop).toHaveBeenCalledTimes(1));
    expect(restoreWorkspaceFromSshExecution).not.toHaveBeenCalled();
  });

  // STUDIO-0075: production, 20 Nov 2026. A routed Codex run lost the link to its worker machine after Codex had opened
  // its thread; the wrapper's entry point threw, nothing was returned, and the retry opened a new thread in the same
  // remote folder. The adapter now tells the host the thread as soon as Codex announces it.
  describe("the session of a run that is cut", () => {
    const REMOTE_EXECUTION = { host: "127.0.0.1", port: 2222, username: "fixture", remoteWorkspacePath: "/remote/workspace",
      remoteCwd: "/remote/workspace", privateKey: "PRIVATE KEY", knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
      strictHostKeyChecking: true };
    type Session = { sessionId: string; sessionDisplayId: string | null; sessionParams: Record<string, unknown> };
    async function runContext(overrides: Record<string, unknown>) {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-cut-"));
      cleanupDirs.push(rootDir);
      const workspaceDir = path.join(rootDir, "workspace");
      const codexHomeDir = path.join(rootDir, "codex-home");
      await mkdir(workspaceDir, { recursive: true });
      await mkdir(codexHomeDir, { recursive: true });
      await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");
      return {
        runId: "run-cut",
        agent: { id: "agent-1", companyId: "company-1", name: "CodexCoder", adapterType: "codex_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { engine: "cli", command: "codex", experimentalLiveSteering: true, env: { CODEX_HOME: codexHomeDir } },
        context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
        executionTransport: { remoteExecution: REMOTE_EXECUTION },
        registerInteractiveControl: () => () => {},
        onLog: async () => {},
        ...overrides,
      } as never;
    }
    /** The wrapper's entry point: Codex announces its thread in the stream, then the link is lost. */
    const lostLinkAfter = (lines: string[]) => vi.fn(async (prepared: { options: { onLog: (stream: "stdout", chunk: string) => Promise<void> } }) => {
      for (const line of lines) await prepared.options.onLog("stdout", `${line}\n`);
      throw new Error("router_provider_stop_unverified");
    });
    const THREAD = JSON.stringify({ type: "thread.started", thread_id: "thread-cut-1" });
    async function cutRun() {
      const announced: Session[] = [];
      await expect(execute(await runContext({ codexPreparedProcess: lostLinkAfter([THREAD]),
        onSessionAnnounced: async (session: Session) => { announced.push(session); } }))).rejects.toThrow(/router_provider_stop_unverified/);
      return announced;
    }
    /** The next run of the task, given a saved session: which thread does it ask Codex to resume? */
    async function retryWith(session: Session) {
      const logs: string[] = [];
      const codexPreparedProcess = vi.fn(async (prepared: { resumeSessionId: string | null; args: string[];
        options: { onProcessStopped?: () => void } }) => {
        prepared.options.onProcessStopped?.();
        return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: 321, startedAt: new Date().toISOString() };
      });
      await execute(await runContext({ codexPreparedProcess,
        runtime: { sessionId: session.sessionId, sessionParams: session.sessionParams, sessionDisplayId: session.sessionId, taskKey: null },
        onLog: async (_stream: string, chunk: string) => { logs.push(chunk); } }));
      const prepared = codexPreparedProcess.mock.calls[0]![0];
      return { resumeSessionId: prepared.resumeSessionId, args: prepared.args, logs: logs.join("") };
    }

    it("tells the host the session as soon as Codex announces it, and still fails with the lost link", async () => {
      const announced = await cutRun();
      expect(announced).toHaveLength(1);
      expect(announced[0]).toMatchObject({ sessionId: "thread-cut-1", sessionDisplayId: "thread-cut-1",
        sessionParams: { sessionId: "thread-cut-1", remoteExecution: { transport: "ssh", host: "127.0.0.1", port: 2222, username: "fixture" } } });
      // The folder of the task on the machine, the same one in both places.
      const params = announced[0]!.sessionParams as { cwd: string; remoteExecution: { remoteCwd: string } };
      expect(params.cwd).toMatch(/^\/remote\/workspace/);
      expect(params.remoteExecution.remoteCwd).toBe(params.cwd);
    });

    it("the retry resumes that session on the same machine and folder", async () => {
      const [session] = await cutRun();
      const retry = await retryWith(session!);
      expect(retry.resumeSessionId).toBe("thread-cut-1");
      expect(retry.args.slice(retry.args.indexOf("resume"))).toEqual(["resume", "thread-cut-1", "-"]);
    });

    it("does not resume it on another machine nor in another folder, and the run's log says so", async () => {
      const [session] = await cutRun();
      const params = session!.sessionParams as { cwd: string; remoteExecution: Record<string, unknown> };
      const otherMachine = await retryWith({ ...session!, sessionParams: { ...params, remoteExecution: { ...params.remoteExecution, host: "10.0.0.9" } } });
      expect(otherMachine.resumeSessionId).toBeNull();
      expect(otherMachine.args).not.toContain("resume");
      expect(otherMachine.logs).toMatch(/Codex session "thread-cut-1" does not match the current remote execution identity and will not be resumed/);
      const otherFolder = await retryWith({ ...session!, sessionParams: { ...params, cwd: "/remote/elsewhere",
        remoteExecution: { ...params.remoteExecution, remoteCwd: "/remote/elsewhere" } } });
      expect(otherFolder.resumeSessionId).toBeNull();
      expect(otherFolder.args).not.toContain("resume");
      expect(otherFolder.logs).toMatch(/Codex session "thread-cut-1" does not match the current remote execution identity and will not be resumed/);
    });

    it("tells nothing when the link is lost before Codex announced a session", async () => {
      const onSessionAnnounced = vi.fn(async () => {});
      await expect(execute(await runContext({ codexPreparedProcess: lostLinkAfter([JSON.stringify({ type: "turn.started" })]),
        onSessionAnnounced }))).rejects.toThrow(/router_provider_stop_unverified/);
      expect(onSessionAnnounced).not.toHaveBeenCalled();
    });

    it("says so in the run's log when the host cannot record the session, and fails with the same error", async () => {
      const logs: string[] = [];
      await expect(execute(await runContext({ codexPreparedProcess: lostLinkAfter([THREAD]),
        onSessionAnnounced: async () => { throw new Error("database unavailable"); },
        onLog: async (_stream: string, chunk: string) => { logs.push(chunk); } }))).rejects.toThrow(/router_provider_stop_unverified/);
      expect(logs.join("")).toMatch(/The session "thread-cut-1" announced by Codex could not be recorded before the end of the run: database unavailable/);
    });

    it("starts a new session and says so when Codex refuses to resume the saved one", async () => {
      const logs: string[] = [];
      const process = (overrides: Record<string, unknown>) => ({ exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "",
        pid: 123, startedAt: new Date().toISOString(), ...overrides });
      runChildProcess.mockResolvedValueOnce(process({ exitCode: 1, stderr: "Error: thread session-123 not found" }) as never);
      runChildProcess.mockResolvedValueOnce(process({ stdout: `${JSON.stringify({ type: "thread.started", thread_id: "thread-new" })}\n` }) as never);
      const folder = "/remote/workspace/.paperclip-runtime/runs/run-cut/workspace";
      const result = await execute(await runContext({ config: undefined, registerInteractiveControl: undefined,
        runtime: { sessionId: "session-123", sessionDisplayId: "session-123", taskKey: null, sessionParams: { sessionId: "session-123",
          cwd: folder, remoteExecution: { transport: "ssh", host: "127.0.0.1", port: 2222, username: "fixture", remoteCwd: folder } } },
        onLog: async (_stream: string, chunk: string) => { logs.push(chunk); } }));
      expect(logs.join("")).toContain('[paperclip] Codex resume session "session-123" is unavailable; retrying with a fresh session.');
      expect(runChildProcess).toHaveBeenCalledTimes(2);
      expect(result.sessionId).toBe("thread-new");
    });
  });
});
