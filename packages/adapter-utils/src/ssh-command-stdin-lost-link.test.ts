import { afterEach, describe, expect, it, vi } from "vitest";

// Reproduces the 2026-11-11 production crash: a sandbox callback bridge
// response write rides `runSshCommand` with the response body on stdin. When
// the worker link drops, the remote side stops reading stdin, the local pipe
// buffer fills, the host-side timeout kills the ssh child, and the pending
// stdin write then fails with EPIPE. Without an `error` listener on
// `child.stdin`, Node throws that EPIPE as an unhandled 'error' event and the
// whole server process exits.

const children = vi.hoisted(() => [] as import("node:child_process").ChildProcess[]);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((file: string, args: string[], options: Parameters<typeof actual.spawn>[2]) => {
      if (file !== "ssh") throw new Error(`Unexpected subprocess ${file}`);
      // A lost link: the remote never reads stdin and never exits on its own.
      const child = actual.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);
      children.push(child);
      return child;
    }),
  };
});

import { createSshCommandManagedRuntimeRunner, runSshCommand } from "./ssh.js";
import { createCommandManagedSandboxCallbackBridgeQueueClient } from "./sandbox-callback-bridge.js";

const config = {
  host: "fixture.invalid",
  username: "fixture",
  port: 22,
  remoteWorkspacePath: "/tmp/fixture",
  remoteCwd: "/tmp/fixture",
  privateKey: null,
  knownHosts: null,
  strictHostKeyChecking: true,
};

// Far larger than any OS pipe buffer, so part of the write is still pending
// when the child dies, like the large issue document of the incident.
const LARGE_BODY = "x".repeat(4 * 1024 * 1024);

describe("SSH stdin write when the worker link is lost", () => {
  afterEach(async () => {
    await Promise.all(children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.kill("SIGKILL");
      await closed;
    }));
  });

  it("rejects the command instead of crashing the process when the timeout kills a stalled ssh child", async () => {
    await expect(
      runSshCommand(config, "cat > /dev/null", { stdin: LARGE_BODY, timeoutMs: 300 }),
    ).rejects.toBeInstanceOf(Error);
    // Give a late EPIPE time to surface; vitest fails the run on any
    // unhandled 'error' event.
    await new Promise((resolve) => setTimeout(resolve, 300));
  }, 15_000);

  it("rejects a callback bridge response write instead of crashing the process", async () => {
    const client = createCommandManagedSandboxCallbackBridgeQueueClient({
      runner: createSshCommandManagedRuntimeRunner({ spec: config, defaultCwd: "/tmp/fixture" }),
      remoteCwd: "/tmp/fixture",
      timeoutMs: 300,
      shellCommand: "sh",
    });
    await expect(
      client.writeResponseFile!(
        "/tmp/fixture/queue/responses/lost-link.json",
        LARGE_BODY,
        { requestPath: "/tmp/fixture/queue/requests/lost-link.json" },
      ),
    ).rejects.toBeInstanceOf(Error);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }, 15_000);
});
