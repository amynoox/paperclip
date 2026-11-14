import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSshEnvLabFixtureConfig,
  buildSshSpawnTarget,
  getSshEnvLabSupport,
  runSshCommand,
  SSH_CONNECTION_SHARING_ENV,
  sshConnectionSharingEnabled,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
  type SshConnectionConfig,
  type SshEnvLabFixtureState,
} from "./ssh.js";

const TEST_TIMEOUT_MS = 60_000;
const FAKE_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----";

const cleanupDirs: string[] = [];
const fixtures: SshEnvLabFixtureState[] = [];
const savedSwitch = process.env[SSH_CONNECTION_SHARING_ENV];
const savedPath = process.env.PATH;

function setSwitch(value: string | undefined) {
  if (value === undefined) delete process.env[SSH_CONNECTION_SHARING_ENV];
  else process.env[SSH_CONNECTION_SHARING_ENV] = value;
}

function fakeConfig(overrides: Partial<SshConnectionConfig> = {}): SshConnectionConfig {
  return {
    host: "ssh.example.test",
    port: 22,
    username: "ssh-user",
    remoteWorkspacePath: "/srv/paperclip/workspace",
    privateKey: FAKE_KEY,
    knownHosts: null,
    strictHostKeyChecking: false,
    ...overrides,
  };
}

function optionValues(args: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === "-o") values.push(args[index + 1]!);
  }
  return values;
}

function sharingOptions(args: string[]): string[] {
  return optionValues(args).filter((value) => /^(Control|ServerAlive)/.test(value));
}

// A program named `ssh`, first on PATH, that records its arguments and exits 0.
async function installRecordingSsh(): Promise<{ readArgs: () => Promise<string[][]> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-fake-ssh-"));
  cleanupDirs.push(dir);
  const recordPath = path.join(dir, "calls.jsonl");
  const scriptPath = path.join(dir, "ssh");
  await writeFile(
    scriptPath,
    [
      `#!${process.execPath}`,
      'const fs = require("node:fs");',
      `fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
      "",
    ].join("\n"),
  );
  await chmod(scriptPath, 0o755);
  process.env.PATH = `${dir}${path.delimiter}${savedPath ?? ""}`;
  return {
    readArgs: async () =>
      (await readFile(recordPath, "utf8"))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as string[]),
  };
}

async function startFixture(label: string): Promise<{ state: SshEnvLabFixtureState; config: SshConnectionConfig } | null> {
  const support = await getSshEnvLabSupport();
  if (!support.supported) {
    console.warn(`Skipping ${label}: ${support.reason ?? "unsupported environment"}`);
    return null;
  }
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-sharing-"));
  cleanupDirs.push(rootDir);
  const state = await startSshEnvLabFixture({ statePath: path.join(rootDir, "state.json") });
  fixtures.push(state);
  return { state, config: await buildSshEnvLabFixtureConfig(state) };
}

async function connectionCount(state: SshEnvLabFixtureState): Promise<number> {
  // sshd writes one "Connection from" line per accepted TCP connection.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const log = await readFile(state.sshdLogPath, "utf8").catch(() => "");
  return (log.match(/Connection from /g) ?? []).length;
}

// The background process that holds a shared connection names itself
// "ssh: <control socket path> [mux]". Only this test file creates such
// processes under a "pcssh-" directory.
function killSharedConnectionMasters(): Promise<void> {
  return new Promise((resolve) => {
    execFile("pkill", ["-f", "^ssh: .*/pcssh-[^/]*/[0-9a-f]{16}-[0-9a-f]{40} \\[mux\\]"], () => resolve());
  });
}

beforeEach(() => {
  setSwitch(undefined);
});

afterEach(async () => {
  setSwitch(savedSwitch);
  process.env.PATH = savedPath;
  while (fixtures.length > 0) {
    const state = fixtures.pop()!;
    await killSharedConnectionMasters();
    await stopSshEnvLabFixture(state).catch(() => undefined);
  }
});

afterAll(async () => {
  await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
});

describe("ssh connection sharing switch", () => {
  it("is off when the variable is not set, and on only for an explicit on value", () => {
    expect(sshConnectionSharingEnabled({}, "linux")).toBe(false);
    expect(sshConnectionSharingEnabled({ [SSH_CONNECTION_SHARING_ENV]: "" }, "linux")).toBe(false);
    expect(sshConnectionSharingEnabled({ [SSH_CONNECTION_SHARING_ENV]: "off" }, "linux")).toBe(false);
    expect(sshConnectionSharingEnabled({ [SSH_CONNECTION_SHARING_ENV]: "0" }, "linux")).toBe(false);
    expect(sshConnectionSharingEnabled({ [SSH_CONNECTION_SHARING_ENV]: "on" }, "linux")).toBe(true);
    expect(sshConnectionSharingEnabled({ [SSH_CONNECTION_SHARING_ENV]: " ON " }, "darwin")).toBe(true);
    expect(sshConnectionSharingEnabled({ [SSH_CONNECTION_SHARING_ENV]: "true" }, "linux")).toBe(true);
    expect(sshConnectionSharingEnabled({ [SSH_CONNECTION_SHARING_ENV]: "1" }, "linux")).toBe(true);
  });

  it("is always off on Windows", () => {
    expect(sshConnectionSharingEnabled({ [SSH_CONNECTION_SHARING_ENV]: "on" }, "win32")).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("ssh connection sharing arguments", () => {
  it("adds no option when the switch is off (same arguments as before the change)", async () => {
    const recorder = await installRecordingSsh();
    for (const value of [undefined, "off"]) {
      setSwitch(value);
      await runSshCommand(fakeConfig(), "true");
    }
    const calls = await recorder.readArgs();
    expect(calls).toHaveLength(2);
    for (const args of calls) {
      expect(sharingOptions(args)).toEqual([]);
      expect(optionValues(args)).toEqual([
        "BatchMode=yes",
        "ConnectTimeout=10",
        "StrictHostKeyChecking=no",
        "UserKnownHostsFile=/dev/null",
      ]);
    }
  });

  it("adds the shared connection options to a short command when the switch is on", async () => {
    const recorder = await installRecordingSsh();
    setSwitch("on");
    await runSshCommand(fakeConfig(), "true");
    const [args] = await recorder.readArgs();
    const options = sharingOptions(args!);
    const controlPath = options.find((value) => value.startsWith("ControlPath="))!.slice("ControlPath=".length);
    expect(options).toEqual([
      "ControlMaster=auto",
      `ControlPath=${controlPath}`,
      "ControlPersist=60",
      "ServerAliveInterval=5",
      "ServerAliveCountMax=3",
    ]);
    expect(path.isAbsolute(controlPath)).toBe(true);
    expect(path.basename(controlPath)).toMatch(/^[0-9a-f]{16}-%C$/);
    // The socket path, with the 40 characters of %C and the 17 characters ssh
    // adds while it creates the socket, fits the smallest limit (104 on macOS).
    expect(controlPath.length - 2 + 40 + 17).toBeLessThan(104);
    // The control directory is private to this user.
    const directory = await stat(path.dirname(controlPath));
    expect(directory.isDirectory()).toBe(true);
    expect(directory.mode & 0o077).toBe(0);
    // The options that were there before the change are still there, in order.
    expect(optionValues(args!).filter((value) => !/^(Control|ServerAlive)/.test(value))).toEqual([
      "BatchMode=yes",
      "ConnectTimeout=10",
      "StrictHostKeyChecking=no",
      "UserKnownHostsFile=/dev/null",
    ]);
  });

  it("gives one control socket per identity", async () => {
    const recorder = await installRecordingSsh();
    setSwitch("on");
    await runSshCommand(fakeConfig(), "true");
    await runSshCommand(fakeConfig(), "true");
    await runSshCommand(fakeConfig({ privateKey: `${FAKE_KEY}\nother` }), "true");
    await runSshCommand(fakeConfig({ strictHostKeyChecking: true, knownHosts: "ssh.example.test ssh-ed25519 AAAA" }), "true");
    const paths = (await recorder.readArgs()).map(
      (args) => sharingOptions(args).find((value) => value.startsWith("ControlPath="))!,
    );
    expect(paths[0]).toBe(paths[1]);
    expect(paths[2]).not.toBe(paths[0]);
    expect(paths[3]).not.toBe(paths[0]);
    expect(paths[3]).not.toBe(paths[2]);
  });

  it("never shares the connection of the long-lived agent session", async () => {
    setSwitch("on");
    const target = await buildSshSpawnTarget({
      spec: { ...fakeConfig(), remoteCwd: "/srv/paperclip/workspace" },
      command: "true",
      args: [],
      env: {},
    });
    try {
      expect(sharingOptions(target.args)).toEqual([]);
    } finally {
      await target.cleanup();
    }
  });
});

describe.skipIf(process.platform === "win32")("ssh connection sharing against a real sshd", () => {
  it("opens one connection per command when the switch is off", async () => {
    const fixture = await startFixture("connection count with the switch off");
    if (!fixture) return;
    const before = await connectionCount(fixture.state);
    for (let index = 0; index < 6; index += 1) {
      expect((await runSshCommand(fixture.config, `echo run-${index}`)).stdout.trim()).toBe(`run-${index}`);
    }
    expect((await connectionCount(fixture.state)) - before).toBe(6);
  }, TEST_TIMEOUT_MS);

  it("opens one connection for sequential commands when the switch is on", async () => {
    const fixture = await startFixture("connection count with the switch on");
    if (!fixture) return;
    setSwitch("on");
    const before = await connectionCount(fixture.state);
    for (let index = 0; index < 6; index += 1) {
      expect((await runSshCommand(fixture.config, `echo run-${index}`)).stdout.trim()).toBe(`run-${index}`);
    }
    expect((await connectionCount(fixture.state)) - before).toBe(1);
  }, TEST_TIMEOUT_MS);

  it("keeps stdin, large output, exit codes and timeouts the same on a shared connection", async () => {
    const fixture = await startFixture("command contract on a shared connection");
    if (!fixture) return;
    for (const value of ["off", "on"]) {
      setSwitch(value);
      // First command of the "on" pass creates the shared connection.
      await runSshCommand(fixture.config, "true");

      const stdin = `${"line of input\n".repeat(2000)}end`;
      const echoed = await runSshCommand(fixture.config, "cat", { stdin, maxBuffer: 1024 * 1024 });
      expect(echoed.stdout).toBe(stdin);

      const large = await runSshCommand(fixture.config, "head -c 300000 /dev/zero | tr '\\0' 'x'", {
        maxBuffer: 1024 * 1024,
      });
      expect(large.stdout.length).toBe(300000);

      await expect(runSshCommand(fixture.config, "echo to-stderr >&2; exit 7")).rejects.toMatchObject({
        code: 7,
        stderr: expect.stringContaining("to-stderr"),
      });

      const startedAt = Date.now();
      await expect(runSshCommand(fixture.config, "sleep 20", { timeoutMs: 700 })).rejects.toMatchObject({
        killed: true,
      });
      expect(Date.now() - startedAt).toBeLessThan(10_000);

      // The connection still serves commands after a failure and a timeout.
      expect((await runSshCommand(fixture.config, "echo still-here")).stdout.trim()).toBe("still-here");
    }
  }, TEST_TIMEOUT_MS);

  it("serves concurrent first commands, and recovers when the shared connection process is killed", async () => {
    const fixture = await startFixture("recovery of a shared connection");
    if (!fixture) return;
    setSwitch("on");

    // No shared connection exists yet: the commands that lose the race open
    // their own connection, and every command succeeds.
    const results = await Promise.all(
      Array.from({ length: 8 }, (_unused, index) => runSshCommand(fixture.config, `echo concurrent-${index}`)),
    );
    expect(results.map((result) => result.stdout.trim()).sort()).toEqual(
      Array.from({ length: 8 }, (_unused, index) => `concurrent-${index}`).sort(),
    );

    const before = await connectionCount(fixture.state);
    await killSharedConnectionMasters();
    expect((await runSshCommand(fixture.config, "echo after-kill")).stdout.trim()).toBe("after-kill");
    expect((await runSshCommand(fixture.config, "echo after-kill-2")).stdout.trim()).toBe("after-kill-2");
    // One new connection replaced the killed one; the second command reused it.
    expect((await connectionCount(fixture.state)) - before).toBe(1);
  }, TEST_TIMEOUT_MS);
});
