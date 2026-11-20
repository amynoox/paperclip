import { describe, expect, it } from "vitest";
import { sshConnectFailureCode, sshLeaseProbeFailureCode, withSshConnectFailureCause, withSshLeaseProbeFailureCause } from "./ssh.js";

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
    // STUDIO-0079: the link dropped while ssh was connecting, or the name could not be resolved for now.
    ["kex_exchange_identification: read: Connection reset by peer", "ECONNRESET"],
    ["kex_exchange_identification: Connection closed by remote host", "ECONNRESET"],
    ["ssh_exchange_identification: read: Connection reset by peer", "ECONNRESET"],
    ["Connection closed by 100.124.59.108 port 22", "ECONNRESET"],
    ["Connection reset by 100.124.59.108 port 22", "ECONNRESET"],
    ["ssh: Could not resolve hostname pk-infra: Temporary failure in name resolution", "EAI_AGAIN"],
  ])("maps %s to %s", (stderr, code) => {
    expect(sshConnectFailureCode(failure(`Warning: something\n${stderr}\n`))).toBe(code);
  });

  it.each([
    "codex@100.121.114.90: Permission denied (publickey).",
    "Host key verification failed.",
    "ssh: Could not resolve hostname qa-c: Name or service not known",
    // A session that was open and then closed is not a connection that never happened.
    "Connection to 100.124.59.108 closed by remote host.",
    "client_loop: send disconnect: Broken pipe",
    "sh: 1: cd: can't cd to /srv/paperclip-infra/execution",
  ])("keeps %s non-transient", (stderr) => {
    expect(sshConnectFailureCode(failure(stderr))).toBeNull();
  });

  it("never maps a failure after the remote command printed something", () => {
    const ran = Object.assign(failure("ssh: connect to host h port 22: Connection timed out"), { stdout: "/Users/codex/paperclip-workspace\n" });
    expect(sshConnectFailureCode(ran)).toBeNull();
    expect(sshConnectFailureCode(Object.assign(failure("ssh: connect to host h port 22: Connection timed out"), { stdout: "" }))).toBe("ETIMEDOUT");
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

// STUDIO-0079 (TR-2093, 20 Nov 2026, run fa0c4bc6): the lease probe of PK-OVH-INFRA was killed by its own
// 15 s timeout, 16.25 s after the run started. The error was the command line alone, with no stderr line.
describe("sshLeaseProbeFailureCode", () => {
  const TR_2093 = "Command failed: ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes "
    + "-o UserKnownHostsFile=/tmp/paperclip-ssh-known-hosts-x/file -i /tmp/paperclip-ssh-key-x/file -p 22 pk-infra@100.124.59.108 "
    + "sh -c 'mkdir -p /srv/paperclip-infra/execution && cd /srv/paperclip-infra/execution && pwd'\n";
  // What Node's execFile gives when its timeout kills the child.
  const killedByTimeout = (patch: Record<string, unknown> = {}) =>
    Object.assign(new Error(TR_2093), { code: null, killed: true, signal: "SIGTERM", stdout: "", stderr: "", ...patch });

  it("reads the TR-2093 probe, killed by the local timeout with nothing printed, as a timeout", () => {
    expect(sshLeaseProbeFailureCode(killedByTimeout())).toBe("ETIMEDOUT");
    const error = withSshLeaseProbeFailureCause(killedByTimeout()) as Error;
    expect((error.cause as { code?: string }).code).toBe("ETIMEDOUT");
    // The message is left as it is.
    expect(error.message).toBe(TR_2093);
    // The same error is no connection failure for any other ssh command.
    expect(sshConnectFailureCode(killedByTimeout())).toBeNull();
    expect((withSshConnectFailureCause(killedByTimeout()) as Error).cause).toBeUndefined();
  });

  it("keeps a warning on stderr from hiding the timeout", () => {
    expect(sshLeaseProbeFailureCode(killedByTimeout({ stderr: "Warning: Permanently added '100.124.59.108' (ED25519) to the list of known hosts.\n" })))
      .toBe("ETIMEDOUT");
  });

  it("reads every connection failure the same way as any ssh command", () => {
    const refused = Object.assign(new Error("Command failed: ssh ..."), { code: 255, stdout: "", stderr: "ssh: connect to host h port 22: Connection refused\n" });
    expect(sshLeaseProbeFailureCode(refused)).toBe("ECONNREFUSED");
  });

  it.each([
    ["the probe answered before the timeout", { stdout: "/srv/paperclip-infra/execution\n" }],
    ["the probe was not killed by the timeout", { killed: false }],
    ["the probe exited by itself", { code: 1, killed: false, stderr: "mkdir: cannot create directory: Permission denied\n" }],
    ["the key was refused", { code: 255, killed: false, stderr: "pk-infra@100.124.59.108: Permission denied (publickey).\n" }],
    ["the host key changed", { code: 255, killed: false, stderr: "Host key verification failed.\n" }],
    ["the host is unknown", { code: 255, killed: false, stderr: "ssh: Could not resolve hostname pk-infra: Name or service not known\n" }],
    ["the launcher lost the command", { killed: false, launcherLost: true }],
  ] as Array<[string, Record<string, unknown>]>)("keeps no code when %s", (_name, patch) => {
    expect(sshLeaseProbeFailureCode(killedByTimeout(patch))).toBeNull();
    expect((withSshLeaseProbeFailureCause(killedByTimeout(patch)) as Error).cause).toBeUndefined();
  });

  it("leaves a cause that is already there", () => {
    const cause = new Error("earlier");
    const error = withSshLeaseProbeFailureCause(Object.assign(killedByTimeout(), { cause })) as Error;
    expect(error.cause).toBe(cause);
  });
});
