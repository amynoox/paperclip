import { execFile, spawn, type ChildProcess } from "node:child_process";

/**
 * Short commands (`ssh`, `git`, `ps`, ...) started from the server process.
 *
 * On Linux, Node starts a child with `fork`. The kernel copies the page tables
 * of the calling process on every `fork`, on the calling thread. For a server
 * process of 1.5 GiB this costs about 25 ms per child, and the event loop is
 * stopped for that time. A remote run starts several `ssh` commands per second.
 *
 * The launcher is one small helper process. It starts these commands instead of
 * the server and returns the result on an IPC channel. A `fork` from the helper
 * copies the page tables of the helper only.
 *
 * The launcher is opt-in per process: nothing starts until
 * `startShortCommandLauncher()` is called. While it is off, not ready, or
 * restarting, every command starts directly from the calling process, as before.
 */

export interface ShortCommandResult {
  stdout: string;
  stderr: string;
}

export interface ShortCommandOptions {
  timeout?: number;
  maxBuffer?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export interface ShortCommandStdinOptions extends ShortCommandOptions {
  stdin?: string;
}

type ExecFileImpl = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; cwd?: string; env?: Record<string, string | undefined> },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => unknown;

type SpawnImpl = (
  file: string,
  args: string[],
  options: {
    stdio: ["pipe" | "ignore", "pipe", "pipe"];
    cwd?: string;
    env?: Record<string, string | undefined>;
  },
) => ChildProcess;

// `execFileTextWith` and `spawnTextWith` run in two places: in the calling
// process (direct start), and in the helper, which receives their source text.
// They must stay self-contained: no reference to a module binding, only to
// their parameters and to JavaScript globals.

export function execFileTextWith(
  execFileImpl: ExecFileImpl,
  file: string,
  args: string[],
  options: ShortCommandOptions = {},
): Promise<ShortCommandResult> {
  return new Promise<ShortCommandResult>((resolve, reject) => {
    execFileImpl(
      file,
      args,
      {
        timeout: options.timeout ?? 15_000,
        maxBuffer: options.maxBuffer ?? 1024 * 128,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: options.env } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout: stdout ?? "", stderr: stderr ?? "" }));
          return;
        }
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      },
    );
  });
}

export function spawnTextWith(
  spawnImpl: SpawnImpl,
  file: string,
  args: string[],
  options: ShortCommandStdinOptions = {},
): Promise<ShortCommandResult> {
  return new Promise<ShortCommandResult>((resolve, reject) => {
    const child = spawnImpl(file, args, {
      stdio: [options.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
    });

    const maxBuffer = options.maxBuffer ?? 1024 * 128;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finishReject = (error: Error & { stdout?: string; stderr?: string; code?: number | null; killed?: boolean }) => {
      if (settled) return;
      settled = true;
      error.stdout = stdout;
      error.stderr = stderr;
      error.killed = timedOut;
      reject(error);
    };

    const append = (
      streamName: "stdout" | "stderr",
      chunk: unknown,
    ) => {
      const text = String(chunk);
      if (streamName === "stdout") {
        stdout += text;
      } else {
        stderr += text;
      }
      if (Buffer.byteLength(stdout, "utf8") > maxBuffer || Buffer.byteLength(stderr, "utf8") > maxBuffer) {
        child.kill("SIGTERM");
        finishReject(Object.assign(new Error(`Process output exceeded maxBuffer of ${maxBuffer} bytes.`), {
          code: null,
        }));
      }
    };

    let killEscalation: ReturnType<typeof setTimeout> | null = null;
    const terminateChild = () => {
      child.kill("SIGTERM");
      if (killEscalation) return;
      killEscalation = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          return;
        }
      }, 5_000);
      killEscalation.unref?.();
    };
    const timeout = options.timeout && options.timeout > 0
      ? setTimeout(() => {
          timedOut = true;
          terminateChild();
        }, options.timeout)
      : null;

    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (killEscalation) clearTimeout(killEscalation);
    };

    child.stdout?.on("data", (chunk) => {
      append("stdout", chunk);
    });
    child.stderr?.on("data", (chunk) => {
      append("stderr", chunk);
    });

    child.on("error", (error) => {
      clearTimers();
      finishReject(Object.assign(error, { code: null }));
    });

    child.on("close", (code, signal) => {
      clearTimers();
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(Object.assign(new Error(stderr.trim() || stdout.trim() || `Process exited with code ${code ?? -1}`), {
        stdout,
        stderr,
        code,
        signal,
        killed: timedOut,
      }));
    });

    child.stdin?.on("error", (error) => {
      terminateChild();
      finishReject(error);
    });

    if (options.stdin != null && child.stdin) {
      child.stdin.end(options.stdin);
    }
  });
}

export const SHORT_COMMAND_LAUNCHER_ENV = "PAPERCLIP_SHORT_COMMAND_LAUNCHER";
export const SHORT_COMMAND_LAUNCHER_TITLE = "paperclip-short-command-launcher";

const RESTART_DELAY_MIN_MS = 1_000;
const RESTART_DELAY_MAX_MS = 30_000;
const RESTART_DELAY_RESET_AFTER_MS = 60_000;
/** A command with a timeout settles in the helper at most 5 s after it (SIGKILL escalation). */
const WATCHDOG_GRACE_MS = 10_000;
const STOP_KILL_AFTER_MS = 2_000;

export type ShortCommandLauncherEvent =
  | { type: "started"; pid: number | null }
  | {
      type: "exited";
      pid: number | null;
      code: number | null;
      signal: string | null;
      reason: string | null;
      lostCommands: number;
      restartInMs: number | null;
    };

export interface ShortCommandLauncherStatus {
  /** `startShortCommandLauncher()` was called and the switch allows the launcher. */
  enabled: boolean;
  /** A helper is connected and takes commands now. */
  ready: boolean;
  pid: number | null;
  /** Commands the helper ran to an answer. */
  served: number;
  /** Commands started directly while the launcher was enabled but not ready, or never delivered. */
  direct: number;
  /** Commands in flight when a helper exited. */
  lost: number;
  restarts: number;
}

export interface ShortCommandLauncherHandle {
  enabled: boolean;
  stop: () => Promise<void>;
}

/**
 * `off` turns the launcher off. `on` turns it on, on every platform.
 * Without a value it is on for Linux only: other platforms do not pay the
 * page-table copy on process creation.
 */
export function shortCommandLauncherEnabled(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): boolean {
  const value = env[SHORT_COMMAND_LAUNCHER_ENV]?.trim().toLowerCase();
  if (value === "off") return false;
  if (value === "on") return true;
  return platform === "linux";
}

type SerializedError = { message: string; name?: string; props: Record<string, unknown> };

type HelperResponse =
  | { ready: true }
  | { id: number; ok: true; stdout: string; stderr: string }
  | { id: number; ok: false; error: SerializedError };

interface PendingCommand {
  resolve: (result: ShortCommandResult) => void;
  reject: (error: Error) => void;
  watchdog: ReturnType<typeof setTimeout> | null;
}

interface LauncherState {
  child: ChildProcess | null;
  ready: boolean;
  stopped: boolean;
  startedAtMs: number;
  nextId: number;
  pending: Map<number, PendingCommand>;
  baseEnv: Record<string, string | undefined>;
  baseEnvKeyCount: number;
  baseCwd: string;
  restartDelayMs: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  exitReason: string | null;
  exitWaiters: Array<() => void>;
  onEvent: ((event: ShortCommandLauncherEvent) => void) | null;
  status: ShortCommandLauncherStatus;
}

let state: LauncherState | null = null;

export function buildShortCommandLauncherSource(): string {
  return `"use strict";
process.title = ${JSON.stringify(SHORT_COMMAND_LAUNCHER_TITLE)};
const { execFile, spawn } = require("node:child_process");
const __name = (value) => value;
const execFileTextWith = ${execFileTextWith.toString()};
const spawnTextWith = ${spawnTextWith.toString()};
const answer = (response) => {
  if (!process.connected) return;
  try { process.send(response); } catch { /* The parent is gone. */ }
};
process.on("message", (request) => {
  let run;
  try {
    run = request.kind === "spawnText"
      ? spawnTextWith(spawn, request.file, request.args, request.options)
      : execFileTextWith(execFile, request.file, request.args, request.options);
  } catch (error) {
    run = Promise.reject(error);
  }
  run.then(
    (result) => answer({ id: request.id, ok: true, stdout: result.stdout, stderr: result.stderr }),
    (error) => answer({
      id: request.id,
      ok: false,
      error: {
        message: String(error && error.message !== undefined ? error.message : error),
        name: error && error.name,
        props: error && typeof error === "object" ? { ...error } : {},
      },
    }),
  );
});
// The parent is gone. Commands in flight keep running without a parent, as
// they do when the server itself exits with children.
process.on("disconnect", () => process.exit(0));
process.send({ ready: true });
`;
}

function emit(current: LauncherState, event: ShortCommandLauncherEvent) {
  try {
    current.onEvent?.(event);
  } catch {
    // An observer must not break command handling.
  }
}

function refChannel(current: LauncherState) {
  const channel = current.child?.channel as { ref?: () => void; unref?: () => void } | null | undefined;
  if (current.pending.size > 0) channel?.ref?.();
  else channel?.unref?.();
}

function launcherLostError(): Error {
  return Object.assign(new Error("Short-command launcher exited before the command finished"), {
    code: null,
    signal: null,
    killed: false,
    stdout: "",
    stderr: "",
    launcherLost: true,
  });
}

const ERROR_CLASSES: Record<string, ErrorConstructor> = {
  RangeError,
  TypeError,
  SyntaxError,
  ReferenceError,
  EvalError,
  URIError,
};

/** Same class, message and own properties as the error the helper caught. */
function rebuildError(serialized: SerializedError): Error {
  const ErrorClass = (serialized.name ? ERROR_CLASSES[serialized.name] : undefined) ?? Error;
  const error = new ErrorClass(serialized.message);
  if (serialized.name && serialized.name !== error.name) {
    Object.defineProperty(error, "name", {
      value: serialized.name,
      configurable: true,
      writable: true,
      enumerable: false,
    });
  }
  return Object.assign(error, serialized.props);
}

function onHelperGone(
  current: LauncherState,
  child: ChildProcess,
  code: number | null,
  signal: string | null,
) {
  if (current.child !== child) return;
  const upMs = Date.now() - current.startedAtMs;
  current.child = null;
  current.ready = false;
  current.status.ready = false;
  current.status.pid = null;
  const lost = [...current.pending.values()];
  current.pending.clear();
  current.status.lost += lost.length;
  for (const entry of lost) {
    if (entry.watchdog) clearTimeout(entry.watchdog);
    entry.reject(launcherLostError());
  }
  let restartInMs: number | null = null;
  if (!current.stopped) {
    if (upMs >= RESTART_DELAY_RESET_AFTER_MS) current.restartDelayMs = RESTART_DELAY_MIN_MS;
    restartInMs = current.restartDelayMs;
    current.restartDelayMs = Math.min(current.restartDelayMs * 2, RESTART_DELAY_MAX_MS);
    current.restartTimer = setTimeout(() => {
      current.restartTimer = null;
      if (current.stopped || state !== current) return;
      current.status.restarts += 1;
      startHelper(current);
    }, restartInMs);
    current.restartTimer.unref?.();
  }
  emit(current, {
    type: "exited",
    pid: child.pid ?? null,
    code,
    signal,
    reason: current.exitReason,
    lostCommands: lost.length,
    restartInMs,
  });
  current.exitReason = null;
  for (const waiter of current.exitWaiters.splice(0)) waiter();
}

function startHelper(current: LauncherState) {
  current.baseEnv = { ...process.env };
  current.baseEnvKeyCount = Object.keys(current.baseEnv).length;
  current.baseCwd = process.cwd();
  current.startedAtMs = Date.now();
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, ["-"], {
      stdio: ["pipe", "ignore", "inherit", "ipc"],
      env: current.baseEnv,
      cwd: current.baseCwd,
    });
    if (typeof child?.send !== "function" || typeof child.on !== "function") {
      throw new Error("the helper process has no IPC channel");
    }
  } catch (error) {
    // Treated like a helper that exited at once: commands start directly, and a restart is scheduled.
    const failed = { pid: undefined } as unknown as ChildProcess;
    current.child = failed;
    current.exitReason = error instanceof Error ? error.message : String(error);
    onHelperGone(current, failed, null, null);
    return;
  }
  current.child = child;
  child.unref();
  child.on("message", (message: HelperResponse) => {
    if (current.child !== child) return;
    if ("ready" in message) {
      current.ready = true;
      current.status.ready = true;
      current.status.pid = child.pid ?? null;
      refChannel(current);
      emit(current, { type: "started", pid: child.pid ?? null });
      return;
    }
    const entry = current.pending.get(message.id);
    if (!entry) return;
    current.pending.delete(message.id);
    if (entry.watchdog) clearTimeout(entry.watchdog);
    current.status.served += 1;
    refChannel(current);
    if (message.ok) entry.resolve({ stdout: message.stdout, stderr: message.stderr });
    else entry.reject(rebuildError(message.error));
  });
  child.on("error", (error) => {
    current.exitReason ??= error.message;
    // Node also reports a failed kill here, with the helper still alive. Closing the
    // channel makes a live helper exit, so a restart never leaves two helpers.
    try {
      if (child.connected) child.disconnect();
    } catch {
      // The channel is already closed.
    }
    onHelperGone(current, child, null, null);
  });
  child.on("exit", (code, signal) => {
    onHelperGone(current, child, code, signal);
  });
  child.on("disconnect", () => {
    if (current.child !== child) return;
    current.exitReason ??= "channel closed";
    child.kill("SIGKILL");
  });
  child.stdin?.on("error", () => {
    // The exit handler reports a helper that died before it read its program.
  });
  child.stdin?.end(buildShortCommandLauncherSource());
}

/**
 * Starts the helper for this process. Safe to call more than once.
 * Returns `enabled: false`, and starts nothing, when the switch is off.
 */
export function startShortCommandLauncher(options: {
  onEvent?: (event: ShortCommandLauncherEvent) => void;
  env?: Record<string, string | undefined>;
  platform?: string;
} = {}): ShortCommandLauncherHandle {
  if (!shortCommandLauncherEnabled(options.env ?? process.env, options.platform ?? process.platform)) {
    return { enabled: false, stop: async () => {} };
  }
  if (!state) {
    state = {
      child: null,
      ready: false,
      stopped: false,
      startedAtMs: 0,
      nextId: 1,
      pending: new Map(),
      baseEnv: {},
      baseEnvKeyCount: 0,
      baseCwd: "",
      restartDelayMs: RESTART_DELAY_MIN_MS,
      restartTimer: null,
      exitReason: null,
      exitWaiters: [],
      onEvent: options.onEvent ?? null,
      status: { enabled: true, ready: false, pid: null, served: 0, direct: 0, lost: 0, restarts: 0 },
    };
    startHelper(state);
  } else if (options.onEvent) {
    state.onEvent = options.onEvent;
  }
  return { enabled: true, stop: stopShortCommandLauncher };
}

/** Stops the helper. Commands in flight are rejected; later commands start directly. */
export async function stopShortCommandLauncher(): Promise<void> {
  const current = state;
  if (!current) return;
  state = null;
  current.stopped = true;
  current.status.enabled = false;
  if (current.restartTimer) clearTimeout(current.restartTimer);
  current.restartTimer = null;
  const child = current.child;
  if (!child) return;
  await new Promise<void>((resolve) => {
    current.exitWaiters.push(resolve);
    current.exitReason = "stopped";
    // The helper is unreferenced while idle. Hold the event loop until its exit is seen.
    child.ref();
    child.kill("SIGTERM");
    const escalation = setTimeout(() => child.kill("SIGKILL"), STOP_KILL_AFTER_MS);
    current.exitWaiters.push(() => clearTimeout(escalation));
  });
}

export function getShortCommandLauncherStatus(): ShortCommandLauncherStatus {
  return state
    ? { ...state.status }
    : { enabled: false, ready: false, pid: null, served: 0, direct: 0, lost: 0, restarts: 0 };
}

function environmentIfChanged(current: LauncherState): Record<string, string | undefined> | undefined {
  const env = process.env;
  const keys = Object.keys(env);
  if (keys.length === current.baseEnvKeyCount) {
    let same = true;
    for (const key of keys) {
      if (env[key] !== current.baseEnv[key]) {
        same = false;
        break;
      }
    }
    if (same) return undefined;
  }
  return { ...env };
}

function runThroughLauncher(
  kind: "execFile" | "spawnText",
  file: string,
  args: string[],
  options: ShortCommandStdinOptions,
  direct: () => Promise<ShortCommandResult>,
): Promise<ShortCommandResult> {
  const current = state;
  if (!current) return direct();
  const child = current.child;
  if (!current.ready || !child || !child.connected) {
    current.status.direct += 1;
    return direct();
  }
  return new Promise<ShortCommandResult>((resolve, reject) => {
    const id = current.nextId++;
    const cwd = options.cwd ?? (process.cwd() !== current.baseCwd ? process.cwd() : undefined);
    const env = options.env ?? environmentIfChanged(current);
    const entry: PendingCommand = { resolve, reject, watchdog: null };
    const neverDelivered = () => {
      if (!current.pending.delete(id)) return;
      if (entry.watchdog) clearTimeout(entry.watchdog);
      current.status.direct += 1;
      refChannel(current);
      direct().then(resolve, reject);
    };
    current.pending.set(id, entry);
    refChannel(current);
    const timeoutMs = options.timeout ?? 15_000;
    if (timeoutMs > 0) {
      entry.watchdog = setTimeout(() => {
        // The helper did not answer after the command's own timeout and kill escalation.
        if (current.child !== child) return;
        current.exitReason ??= "no answer after the command timeout";
        child.kill("SIGKILL");
      }, timeoutMs + WATCHDOG_GRACE_MS);
      entry.watchdog.unref?.();
    }
    try {
      child.send(
        { id, kind, file, args, options: { ...options, ...(cwd ? { cwd } : {}), ...(env ? { env } : {}) } },
        (error) => {
          if (error) neverDelivered();
        },
      );
    } catch {
      neverDelivered();
    }
  });
}

/** `execFile` with text output. Same contract with and without the launcher. */
export function execFileText(
  file: string,
  args: string[],
  options: ShortCommandOptions = {},
): Promise<ShortCommandResult> {
  return runThroughLauncher("execFile", file, args, options, () =>
    execFileTextWith(execFile as unknown as ExecFileImpl, file, args, options));
}

/** `spawn` with optional stdin and text output. Same contract with and without the launcher. */
export function spawnText(
  file: string,
  args: string[],
  options: ShortCommandStdinOptions = {},
): Promise<ShortCommandResult> {
  return runThroughLauncher("spawnText", file, args, options, () =>
    spawnTextWith(spawn as unknown as SpawnImpl, file, args, options));
}
