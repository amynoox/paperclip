import { describe, expect, it } from "vitest";
import { sshConnectFailureCode, withSshConnectFailureCause } from "./ssh.js";

// STUDIO-0052: the exact stderr of the TR-999 lease probe (15 Nov 2026), and the other
// connection failures ssh reports with exit 255.
const failure = (stderr: string, code: unknown = 255) => Object.assign(new Error("Command failed: ssh ..."), { code, stderr });

describe("sshConnectFailureCode", () => {
  it.each([
    ["ssh: connect to host 100.121.114.90 port 22: Connection timed out", "ETIMEDOUT"],
    ["ssh: connect to host qa-c port 22: Operation timed out", "ETIMEDOUT"],
    ["Connection timed out during banner exchange", "ETIMEDOUT"],
    ["ssh: connect to host 10.0.0.5 port 2222: Connection refused", "ECONNREFUSED"],
    ["ssh: connect to host 10.0.0.5 port 22: No route to host", "ENETUNREACH"],
    ["ssh: connect to host 10.0.0.5 port 22: Network is unreachable", "ENETUNREACH"],
  ])("maps %s to %s", (stderr, code) => {
    expect(sshConnectFailureCode(failure(`Warning: something\n${stderr}\n`))).toBe(code);
  });

  it.each([
    "codex@100.121.114.90: Permission denied (publickey).",
    "Host key verification failed.",
    "ssh: Could not resolve hostname qa-c: Name or service not known",
    "kex_exchange_identification: read: Connection reset by peer",
  ])("keeps %s non-transient", (stderr) => {
    expect(sshConnectFailureCode(failure(stderr))).toBeNull();
  });

  it("needs ssh's own exit code 255", () => {
    expect(sshConnectFailureCode(failure("ssh: connect to host h port 22: Connection timed out", 1))).toBeNull();
    expect(sshConnectFailureCode(failure("ssh: connect to host h port 22: Connection timed out", "ETIMEDOUT"))).toBeNull();
  });
});

describe("withSshConnectFailureCause", () => {
  it("attaches a cause with the network code, once, and leaves other failures alone", () => {
    const timedOut = withSshConnectFailureCause(failure("ssh: connect to host 100.121.114.90 port 22: Connection timed out")) as Error;
    expect((timedOut.cause as { code?: string }).code).toBe("ETIMEDOUT");
    expect(timedOut.message).toBe("Command failed: ssh ...");
    const denied = withSshConnectFailureCause(failure("Permission denied (publickey).")) as Error;
    expect(denied.cause).toBeUndefined();
  });
});
