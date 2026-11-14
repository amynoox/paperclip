#!/usr/bin/env node
// Bench for STUDIO short-command launcher: how long one process start blocks the event loop of a
// large process, with and without the launcher. Linux only. Needs the built adapter-utils package:
//   pnpm --filter @paperclipai/adapter-utils build
//   node studio/short-command-launcher-bench.mjs --rss-mb 1600 --mode direct
//   node studio/short-command-launcher-bench.mjs --rss-mb 1600 --mode launcher
//   node studio/short-command-launcher-bench.mjs --rss-mb 1600 --mode switch-off   (negative control)
// It prints one JSON line. It starts `/bin/echo` only and writes nothing.
import { readFileSync } from "node:fs";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import {
  execFileText,
  getShortCommandLauncherStatus,
  startShortCommandLauncher,
  stopShortCommandLauncher,
} from "../packages/adapter-utils/dist/short-command-launcher.js";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const rssTargetMb = Number(argument("rss-mb", "1600"));
const launches = Number(argument("launches", "300"));
const mode = argument("mode", "direct");
if (!["direct", "launcher", "switch-off"].includes(mode)) {
  throw new Error("--mode must be direct, launcher or switch-off");
}

// Grow the resident memory of this process, as a long-lived server has it. Every page is written,
// so the kernel has a page-table entry to copy for it on fork.
const ballast = [];
while (process.memoryUsage().rss < rssTargetMb * 1024 * 1024) {
  ballast.push(Buffer.alloc(32 * 1024 * 1024, 1));
}

function procStatus(key) {
  const line = readFileSync("/proc/self/status", "utf8").split("\n").find((entry) => entry.startsWith(`${key}:`));
  return line ? Number(line.replace(/[^0-9]/g, "")) : null;
}

function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  const round = (value) => Math.round(value * 100) / 100;
  return {
    mean: round(values.reduce((sum, value) => sum + value, 0) / values.length),
    median: round(at(0.5)),
    p90: round(at(0.9)),
    max: round(sorted[sorted.length - 1]),
  };
}

// Negative control: the server asks for the launcher, the environment switch refuses it.
if (mode === "switch-off") {
  const handle = startShortCommandLauncher({ env: { PAPERCLIP_SHORT_COMMAND_LAUNCHER: "off" }, platform: "linux" });
  if (handle.enabled) throw new Error("the switch did not turn the launcher off");
}
if (mode === "launcher") {
  startShortCommandLauncher({ env: { PAPERCLIP_SHORT_COMMAND_LAUNCHER: "on" } });
  const deadline = Date.now() + 15_000;
  while (!getShortCommandLauncherStatus().ready) {
    if (Date.now() > deadline) throw new Error("the launcher did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function launch(index) {
  const before = performance.now();
  const pending = execFileText("/bin/echo", [String(index)]);
  const blocked = performance.now() - before; // the call returned: the event loop is free again
  const result = await pending;
  if (result.stdout !== `${index}\n`) throw new Error(`wrong output for launch ${index}`);
  return { blocked, total: performance.now() - before };
}

for (let index = 0; index < 10; index += 1) await launch(index);

const loopDelay = monitorEventLoopDelay({ resolution: 1 });
const cpuBefore = process.cpuUsage();
const blocked = [];
const total = [];
loopDelay.enable();
for (let index = 0; index < launches; index += 1) {
  const sample = await launch(index);
  blocked.push(sample.blocked);
  total.push(sample.total);
}
loopDelay.disable();
const cpu = process.cpuUsage(cpuBefore);
const status = getShortCommandLauncherStatus();

console.log(JSON.stringify({
  mode,
  node: process.version,
  launches,
  rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  pageTablesKb: procStatus("VmPTE"),
  eventLoopBlockedPerLaunchMs: summary(blocked),
  launchToResultMs: summary(total),
  processCpuPerLaunchMs: {
    user: Math.round(cpu.user / launches / 10) / 100,
    system: Math.round(cpu.system / launches / 10) / 100,
  },
  eventLoopDelayMs: {
    p99: Math.round(loopDelay.percentile(99) / 1e4) / 100,
    max: Math.round(loopDelay.max / 1e4) / 100,
  },
  launcher: mode === "launcher" ? { served: status.served, direct: status.direct, lost: status.lost } : null,
}));

ballast.length = 0;
await stopShortCommandLauncher();
