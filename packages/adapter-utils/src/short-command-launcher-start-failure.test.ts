import { afterEach, describe, expect, it, vi } from "vitest";

// The helper itself cannot start. Every other process start is real.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((file: string, args: string[], options: object) => {
      if (file === process.execPath && args[0] === "-") throw new Error("spawn EAGAIN");
      return actual.spawn(file, args, options);
    }),
  };
});

const {
  execFileText,
  getShortCommandLauncherStatus,
  SHORT_COMMAND_LAUNCHER_ENV,
  spawnText,
  startShortCommandLauncher,
  stopShortCommandLauncher,
} = await import("./short-command-launcher.js");

afterEach(async () => {
  await stopShortCommandLauncher();
});

describe("short-command launcher that cannot start", () => {
  it("reports the failure, schedules a restart, and starts commands from this process", async () => {
    const events: Array<Record<string, unknown>> = [];
    const handle = startShortCommandLauncher({
      env: { [SHORT_COMMAND_LAUNCHER_ENV]: "on" },
      onEvent: (event) => events.push(event),
    });
    expect(handle.enabled).toBe(true);
    expect(events).toEqual([
      { type: "exited", pid: null, code: null, signal: null, reason: "spawn EAGAIN", lostCommands: 0, restartInMs: 1000 },
    ]);
    expect(getShortCommandLauncherStatus()).toMatchObject({ enabled: true, ready: false, pid: null });

    const printParent = ["-e", "process.stdout.write(String(process.ppid))"];
    expect(Number((await execFileText(process.execPath, printParent)).stdout)).toBe(process.pid);
    expect(Number((await spawnText(process.execPath, printParent, { stdin: "" })).stdout)).toBe(process.pid);
    expect(getShortCommandLauncherStatus()).toMatchObject({ direct: 2, served: 0, lost: 0 });
  });
});
