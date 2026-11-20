import { describe, expect, it, vi } from "vitest";

// What stands for `ssh` in each case: a shell script, and the local timeout the launcher is given.
const fake = vi.hoisted(() => ({ script: "true", timeoutMs: null as number | null }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn((file: string, _args: string[], options: { timeout?: number }, callback: Parameters<typeof actual.execFile>[3]) => {
      if (file !== "ssh") throw new Error(`Unexpected subprocess ${file}`);
      return actual.execFile("sh", ["-c", fake.script], { ...options, timeout: fake.timeoutMs ?? options.timeout }, callback);
    }),
  };
});

import { ensureSshWorkspaceReady } from "./ssh.js";

const config = {
  host: "fixture.invalid", username: "fixture", port: 22, remoteWorkspacePath: "/srv/paperclip-infra/execution",
  privateKey: null, knownHosts: null, strictHostKeyChecking: true,
};

async function probe(script: string, timeoutMs: number | null = null) {
  fake.script = script;
  fake.timeoutMs = timeoutMs;
  return ensureSshWorkspaceReady(config).then(
    (value) => ({ value, error: null as (Error & { cause?: { code?: string }; killed?: boolean; code?: unknown }) | null }),
    (error) => ({ value: null, error: error as Error & { cause?: { code?: string }; killed?: boolean; code?: unknown } }),
  );
}

// STUDIO-0079: the ssh lease probe (the only command of an ssh lease acquisition) through the real launcher.
describe("ensureSshWorkspaceReady", () => {
  it("returns the folder the probe printed", async () => {
    const { value, error } = await probe("printf '/srv/paperclip-infra/execution\\n'");
    expect(error).toBeNull();
    expect(value).toEqual({ remoteCwd: "/srv/paperclip-infra/execution" });
  });

  it("TR-2093: a probe killed by the local timeout, with nothing printed, carries a timeout cause", async () => {
    const { error } = await probe("sleep 5", 300);
    expect(error).not.toBeNull();
    // The real shape of a child killed by execFile's timeout.
    expect(error).toMatchObject({ killed: true, code: null, stdout: "", stderr: "" });
    expect(error!.cause).toMatchObject({ code: "ETIMEDOUT" });
    expect(error!.message).toContain("Command failed");
  });

  it("a probe that printed its folder and then hung keeps no cause: the machine answered", async () => {
    const { error } = await probe("printf '/srv/paperclip-infra/execution\\n'; sleep 5", 300);
    expect(error).toMatchObject({ killed: true });
    expect(error!.cause).toBeUndefined();
  });

  it("a connection cut during the key exchange carries a reset cause", async () => {
    const { error } = await probe("echo 'kex_exchange_identification: read: Connection reset by peer' >&2; exit 255");
    expect(error).toMatchObject({ code: 255 });
    expect(error!.cause).toMatchObject({ code: "ECONNRESET" });
  });

  it.each([
    ["a refused key", "echo 'fixture@fixture.invalid: Permission denied (publickey).' >&2; exit 255"],
    ["a changed host key", "echo 'Host key verification failed.' >&2; exit 255"],
    ["an unknown host", "echo 'ssh: Could not resolve hostname fixture.invalid: Name or service not known' >&2; exit 255"],
    ["a folder that cannot be created", "echo 'mkdir: cannot create directory: Permission denied' >&2; exit 1"],
  ])("%s keeps no cause", async (_name, script) => {
    const { error } = await probe(script);
    expect(error).not.toBeNull();
    expect(error!.cause).toBeUndefined();
  });
});
