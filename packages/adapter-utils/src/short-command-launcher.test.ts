import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  execFileText,
  execFileTextWith,
  getShortCommandLauncherStatus,
  SHORT_COMMAND_LAUNCHER_ENV,
  shortCommandLauncherEnabled,
  spawnText,
  spawnTextWith,
  startShortCommandLauncher,
  stopShortCommandLauncher,
  type ShortCommandLauncherEvent,
} from "./short-command-launcher.js";
import { runSshCommand } from "./ssh.js";

const node = process.execPath;
const ON = { [SHORT_COMMAND_LAUNCHER_ENV]: "on" };
const posixOnly = process.platform === "win32" ? it.skip : it;

async function waitFor(check: () => boolean, label: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function startReady(events?: ShortCommandLauncherEvent[]) {
  const handle = startShortCommandLauncher({ env: ON, onEvent: (event) => events?.push(event) });
  expect(handle.enabled).toBe(true);
  await waitFor(() => getShortCommandLauncherStatus().ready, "the launcher to be ready");
  return getShortCommandLauncherStatus().pid!;
}

type Outcome =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; message: string; name: string; errorClass: string; ownKeys: string[]; props: Record<string, unknown> };

async function outcome(run: () => Promise<{ stdout: string; stderr: string }>): Promise<Outcome> {
  try {
    const result = await run();
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error;
    return {
      ok: false,
      message: failure.message,
      name: failure.name,
      errorClass: failure.constructor.name,
      ownKeys: Object.keys(failure).sort(),
      props: { ...failure },
    };
  }
}

const printParent = ["-e", "process.stdout.write(String(process.ppid))"];

afterEach(async () => {
  await stopShortCommandLauncher();
});

describe("short-command launcher switch", () => {
  it("is on for Linux by default, off elsewhere, and follows the environment switch", () => {
    expect(shortCommandLauncherEnabled({}, "linux")).toBe(true);
    expect(shortCommandLauncherEnabled({}, "darwin")).toBe(false);
    expect(shortCommandLauncherEnabled({}, "win32")).toBe(false);
    expect(shortCommandLauncherEnabled({ [SHORT_COMMAND_LAUNCHER_ENV]: "off" }, "linux")).toBe(false);
    expect(shortCommandLauncherEnabled({ [SHORT_COMMAND_LAUNCHER_ENV]: " OFF " }, "linux")).toBe(false);
    expect(shortCommandLauncherEnabled({ [SHORT_COMMAND_LAUNCHER_ENV]: "on" }, "darwin")).toBe(true);
  });

  it("starts nothing and keeps every command in this process when the switch is off", async () => {
    const handle = startShortCommandLauncher({ env: { [SHORT_COMMAND_LAUNCHER_ENV]: "off" }, platform: "linux" });
    expect(handle.enabled).toBe(false);
    expect(getShortCommandLauncherStatus()).toMatchObject({ enabled: false, ready: false, pid: null });
    const result = await execFileText(node, printParent);
    expect(Number(result.stdout)).toBe(process.pid);
    const viaStdin = await spawnText(node, printParent, { stdin: "" });
    expect(Number(viaStdin.stdout)).toBe(process.pid);
  });

  it("keeps every command in this process when the launcher was never started", async () => {
    const result = await execFileText(node, printParent);
    expect(Number(result.stdout)).toBe(process.pid);
  });
});

describe("short-command launcher", () => {
  it("starts commands from the helper process, not from this process", async () => {
    const helperPid = await startReady();
    expect(helperPid).not.toBe(process.pid);
    const viaExecFile = await execFileText(node, printParent);
    expect(Number(viaExecFile.stdout)).toBe(helperPid);
    const viaSpawn = await spawnText(node, printParent, { stdin: "" });
    expect(Number(viaSpawn.stdout)).toBe(helperPid);
    expect(getShortCommandLauncherStatus()).toMatchObject({ enabled: true, ready: true, served: 2, direct: 0, lost: 0 });
  });

  const execFileCases: Array<{ name: string; args: string[]; options?: Parameters<typeof execFileText>[2]; file?: string }> = [
    { name: "success with both streams", args: ["-e", "process.stdout.write('out');process.stderr.write('err')"] },
    { name: "non-zero exit with output", args: ["-e", "process.stdout.write('o');process.stderr.write('e');process.exit(3)"] },
    { name: "timeout", args: ["-e", "setTimeout(()=>{},30000)"], options: { timeout: 400 } },
    { name: "output over maxBuffer", args: ["-e", "process.stdout.write('x'.repeat(5000))"], options: { maxBuffer: 1024 } },
    { name: "missing program", file: "paperclip-no-such-program", args: ["a"] },
    { name: "working directory", args: ["-e", "process.stdout.write(process.cwd())"], options: { cwd: os.tmpdir() } },
    {
      name: "one mebibyte of output",
      args: ["-e", "process.stdout.write('y'.repeat(1024*1024))"],
      options: { maxBuffer: 2 * 1024 * 1024 },
    },
  ];

  for (const testCase of execFileCases) {
    it(`execFileText gives the same outcome through the helper: ${testCase.name}`, async () => {
      const file = testCase.file ?? node;
      const direct = await outcome(() => execFileText(file, testCase.args, testCase.options));
      const helperPid = await startReady();
      const through = await outcome(() => execFileText(file, testCase.args, testCase.options));
      expect(through).toEqual(direct);
      expect(getShortCommandLauncherStatus()).toMatchObject({ served: 1, direct: 0, pid: helperPid });
      if (testCase.name === "timeout") {
        expect(direct).toMatchObject({ ok: false, props: { killed: true, signal: "SIGTERM" } });
      }
      if (testCase.name === "one mebibyte of output") {
        expect(direct).toMatchObject({ ok: true });
        expect((through as { stdout: string }).stdout.length).toBe(1024 * 1024);
      }
    });
  }

  const spawnCases: Array<{ name: string; args: string[]; options?: Parameters<typeof spawnText>[2]; file?: string }> = [
    {
      name: "stdin is delivered and closed",
      args: ["-e", "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(s.toUpperCase()))"],
      options: { stdin: "payload\nline two" },
    },
    { name: "non-zero exit reports stderr", args: ["-e", "process.stderr.write('bad thing\\n');process.exit(2)"], options: { stdin: "" } },
    { name: "timeout", args: ["-e", "setTimeout(()=>{},30000)"], options: { stdin: "", timeout: 400 } },
    { name: "output over maxBuffer", args: ["-e", "process.stdout.write('x'.repeat(5000))"], options: { stdin: "", maxBuffer: 1024 } },
    { name: "missing program", file: "paperclip-no-such-program", args: ["a"], options: { stdin: "x" } },
  ];

  for (const testCase of spawnCases) {
    it(`spawnText gives the same outcome through the helper: ${testCase.name}`, async () => {
      const file = testCase.file ?? node;
      const direct = await outcome(() => spawnText(file, testCase.args, testCase.options));
      await startReady();
      const through = await outcome(() => spawnText(file, testCase.args, testCase.options));
      expect(through).toEqual(direct);
      expect(getShortCommandLauncherStatus()).toMatchObject({ served: 1, direct: 0 });
      if (testCase.name === "timeout") expect(direct).toMatchObject({ ok: false, props: { killed: true } });
    });
  }

  it("keeps the direct functions identical to an in-process start", async () => {
    const viaExecFile = await execFileTextWith(execFile as never, node, printParent);
    expect(Number(viaExecFile.stdout)).toBe(process.pid);
    const viaSpawn = await spawnTextWith(spawn as never, node, printParent, { stdin: "" });
    expect(Number(viaSpawn.stdout)).toBe(process.pid);
  });

  it("answers many commands at once, each with its own result", async () => {
    await startReady();
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        execFileText(node, ["-e", `setTimeout(()=>process.stdout.write(String(${index})),${(index % 5) * 20})`])),
    );
    expect(results.map((result) => Number(result.stdout))).toEqual(Array.from({ length: 40 }, (_, index) => index));
    expect(getShortCommandLauncherStatus().served).toBe(40);
  });

  it("gives commands the environment and working directory of this process as they are now", async () => {
    const key = "PAPERCLIP_SHORT_COMMAND_LAUNCHER_TEST_VALUE";
    const helperPid = await startReady();
    process.env[key] = "set-after-start";
    try {
      const result = await execFileText(node, [
        "-e",
        `process.stdout.write(JSON.stringify([process.env.${key},process.cwd(),process.ppid]))`,
      ]);
      expect(JSON.parse(result.stdout)).toEqual(["set-after-start", process.cwd(), helperPid]);
    } finally {
      delete process.env[key];
    }
    const after = await execFileText(node, ["-e", `process.stdout.write(String(process.env.${key}))`]);
    expect(after.stdout).toBe("undefined");
  });

  it("rejects commands in flight when the helper dies, starts the next ones directly, then restarts", async () => {
    const events: ShortCommandLauncherEvent[] = [];
    const firstPid = await startReady(events);
    const inFlight = outcome(() => execFileText(node, ["-e", "setTimeout(()=>{},30000)"], { timeout: 60_000 }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    process.kill(firstPid, "SIGKILL");
    expect(await inFlight).toMatchObject({
      ok: false,
      props: { launcherLost: true, code: null, killed: false },
    });

    // The helper is down: the command starts from this process.
    const direct = await execFileText(node, printParent);
    expect(Number(direct.stdout)).toBe(process.pid);
    expect(getShortCommandLauncherStatus()).toMatchObject({ enabled: true, ready: false, lost: 1, direct: 1 });

    await waitFor(() => getShortCommandLauncherStatus().ready, "the launcher to restart");
    const secondPid = getShortCommandLauncherStatus().pid!;
    expect(secondPid).not.toBe(firstPid);
    const through = await execFileText(node, printParent);
    expect(Number(through.stdout)).toBe(secondPid);
    expect(getShortCommandLauncherStatus()).toMatchObject({ restarts: 1, lost: 1, direct: 1 });
    expect(events.map((event) => event.type)).toEqual(["started", "exited", "started"]);
    expect(events[1]).toMatchObject({ type: "exited", pid: firstPid, signal: "SIGKILL", lostCommands: 1, restartInMs: 1000 });
  });

  it("stops the helper and returns to direct starts", async () => {
    const helperPid = await startReady();
    await stopShortCommandLauncher();
    expect(getShortCommandLauncherStatus()).toMatchObject({ enabled: false, ready: false, pid: null });
    await waitFor(() => {
      try {
        process.kill(helperPid, 0);
        return false;
      } catch {
        return true;
      }
    }, "the helper process to exit");
    const result = await execFileText(node, printParent);
    expect(Number(result.stdout)).toBe(process.pid);
  });

  posixOnly("is the path runSshCommand takes, with and without stdin", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pc-fake-ssh-"));
    const originalPath = process.env.PATH;
    const config = {
      host: "127.0.0.1",
      port: 22,
      username: "nobody",
      remoteWorkspacePath: "/tmp",
      privateKey: null,
      knownHosts: null,
      strictHostKeyChecking: false,
    };
    try {
      // Stands in for ssh: prints the pid of the process that started it, then its stdin when asked.
      await fs.writeFile(
        path.join(directory, "ssh"),
        '#!/bin/sh\nprintf "%s " "$PPID"\nif [ "$FAKE_SSH_READ_STDIN" = "1" ]; then cat; fi\n',
        { mode: 0o755 },
      );
      process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ""}`;

      const directResult = await runSshCommand(config, "true");
      expect(Number(directResult.stdout.trim())).toBe(process.pid);

      const helperPid = await startReady();
      const result = await runSshCommand(config, "true");
      expect(Number(result.stdout.trim())).toBe(helperPid);

      process.env.FAKE_SSH_READ_STDIN = "1";
      const withStdin = await runSshCommand(config, "cat", { stdin: "body" });
      expect(withStdin.stdout).toBe(`${helperPid} body`);
    } finally {
      delete process.env.FAKE_SSH_READ_STDIN;
      process.env.PATH = originalPath;
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
