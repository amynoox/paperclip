import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn((file: string, args: string[], options: object, callback: Parameters<typeof actual.execFile>[3]) => {
      if (file !== "ssh") throw new Error(`Unexpected subprocess ${file}`);
      return actual.execFile("sh", ["-c", args.at(-1)!], options, callback);
    }),
    spawn: vi.fn((file: string, args: string[], options: Parameters<typeof actual.spawn>[2]) => {
      if (file !== "ssh") throw new Error(`Unexpected subprocess ${file}`);
      return actual.spawn("sh", ["-c", args.at(-1)!], options);
    }),
  };
});

import * as childProcess from "node:child_process";
import { createSshCommandManagedRuntimeRunner, runSshCommand } from "./ssh.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function runner() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ssh-managed-argv-"));
  roots.push(cwd);
  return createSshCommandManagedRuntimeRunner({
    spec: {
      host: "fixture.invalid", username: "fixture", port: 22,
      remoteCwd: cwd, remoteWorkspacePath: cwd,
      privateKey: null, knownHosts: null, strictHostKeyChecking: true,
    },
  });
}

describe("SSH command-managed argv", () => {
  it.each([false, true])("leaves the caller's locale to the remote command (stdin=%s)", async (withStdin) => {
    // STUDIO-0052: ssh receives the server's environment unchanged, so what the
    // client config forwards (SendEnv LANG LC_*) is what it forwarded before.
    const saved = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG };
    process.env.LC_ALL = "fr_FR.UTF-8";
    process.env.LANG = "fr_FR.UTF-8";
    try {
      const cwd = await mkdtemp(path.join(os.tmpdir(), "ssh-locale-"));
      roots.push(cwd);
      const result = await runSshCommand({ host: "fixture.invalid", username: "fixture", port: 22,
        remoteWorkspacePath: cwd, privateKey: null, knownHosts: null, strictHostKeyChecking: true },
        "printf done", { ...(withStdin ? { stdin: "" } : {}), timeoutMs: 5000 });
      expect(result.stdout).toBe("done");
      const launcher = vi.mocked(withStdin ? childProcess.spawn : childProcess.execFile);
      const options = launcher.mock.calls.at(-1)![2] as { env?: NodeJS.ProcessEnv };
      const env = options.env ?? process.env;
      expect([env.LC_ALL, env.LANG]).toEqual(["fr_FR.UTF-8", "fr_FR.UTF-8"]);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("rejects environment keys that could be interpreted as env options", async () => {
    await expect((await runner()).execute({ command: "true", env: { "-u": "PATH" } }))
      .rejects.toThrow("Invalid SSH environment variable key");
  });

  it.each([[false, false], [true, false], [false, true], [true, true]])(
    "preserves shell positional arguments with environment=%s and stdin=%s",
    async (withEnvironment, withStdin) => {
      const value = "literal 'quote' $(printf unsafe) `printf unsafe`";
      const result = await (await runner()).execute({
        command: "sh",
        args: ["-c", 'set -eu; printf "%s\\n" "$0" "$1" "$2" "${SENTINEL_TEXT-unset}"', "named-probe", "two words", value],
        ...(withEnvironment ? { env: { SENTINEL_TEXT: value } } : {}),
        ...(withStdin ? { stdin: "" } : {}),
        timeoutMs: 5000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(["named-probe", "two words", value, withEnvironment ? value : "unset"].join("\n") + "\n");
    },
  );

  it("applies environment to a non-shell command", async () => {
    const result = await (await runner()).execute({
      command: "printenv", args: ["SENTINEL_TEXT"],
      env: { SENTINEL_TEXT: "two words" }, timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("two words\n");
  });
});
