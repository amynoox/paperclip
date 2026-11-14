// Local measure for the shared SSH connection (see studio/ssh-connection-sharing.md).
//
// It starts the SSH test server of the repository (a local `sshd`, needs `ssh`, `sshd` and
// `ssh-keygen` on PATH), then measures, with the switch off and on:
//   - one short command (`true`);
//   - the four commands the callback bridge runs for one agent request
//     (size, read, write the response, remove).
//
// Build first: pnpm --filter @paperclipai/adapter-utils build
// Run:         node studio/ssh-connection-sharing-bench.mjs [--commands 40] [--requests 20]

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  buildSshEnvLabFixtureConfig,
  createSshCommandManagedRuntimeRunner,
  getSshEnvLabSupport,
  runSshCommand,
  SSH_CONNECTION_SHARING_ENV,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
} from "../packages/adapter-utils/dist/ssh.js";
import { createCommandManagedSandboxCallbackBridgeQueueClient } from "../packages/adapter-utils/dist/sandbox-callback-bridge.js";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? Number(process.argv[index + 1]) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    median: Number(at(0.5).toFixed(1)),
    p90: Number(at(0.9).toFixed(1)),
    max: Number(sorted[sorted.length - 1].toFixed(1)),
  };
}

async function connectionCount(state) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  const log = await readFile(state.sshdLogPath, "utf8").catch(() => "");
  return (log.match(/Connection from /g) ?? []).length;
}

const commands = option("commands", 40);
const requests = option("requests", 20);

const support = await getSshEnvLabSupport();
if (!support.supported) {
  console.error(`SSH test server not available: ${support.reason}`);
  process.exit(2);
}

const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-sharing-bench-"));
const state = await startSshEnvLabFixture({ statePath: path.join(rootDir, "state.json") });
const config = await buildSshEnvLabFixtureConfig(state);
const remoteCwd = state.workspaceDir;
const queueDir = path.posix.join(remoteCwd, "bench-queue");
const requestBody = JSON.stringify({ id: "bench", method: "GET", path: "/api/health", headers: {}, body: "x".repeat(600) });
const responseBody = `${JSON.stringify({ id: "bench", status: 200, headers: {}, body: "y".repeat(2000) })}\n`;

try {
  for (const mode of ["off", "on"]) {
    process.env[SSH_CONNECTION_SHARING_ENV] = mode;
    const client = createCommandManagedSandboxCallbackBridgeQueueClient({
      runner: createSshCommandManagedRuntimeRunner({ spec: { ...config, remoteCwd }, defaultCwd: remoteCwd }),
      remoteCwd,
    });
    await client.makeDirs([path.posix.join(queueDir, "requests"), path.posix.join(queueDir, "responses")]);

    const connectionsBefore = await connectionCount(state);
    const commandMs = [];
    for (let index = 0; index < commands; index += 1) {
      const startedAt = performance.now();
      await runSshCommand(config, "true");
      commandMs.push(performance.now() - startedAt);
    }
    const connectionsForCommands = (await connectionCount(state)) - connectionsBefore;

    const requestMs = [];
    const untilResponseMs = [];
    for (let index = 0; index < requests; index += 1) {
      const name = `${mode}-${index}.json`;
      const requestPath = path.posix.join(queueDir, "requests", name);
      const responsePath = path.posix.join(queueDir, "responses", name);
      // The agent side writes the request file; this write is not part of the measure.
      await runSshCommand(config, `cat > '${requestPath}'`, { stdin: requestBody });
      const startedAt = performance.now();
      const size = await client.fileSize(requestPath);
      await client.readTextFile(requestPath, size);
      await client.writeResponseFile(responsePath, responseBody, { requestPath });
      untilResponseMs.push(performance.now() - startedAt);
      await client.remove(requestPath);
      requestMs.push(performance.now() - startedAt);
    }

    console.log(JSON.stringify({
      utc: new Date().toISOString(),
      switch: mode,
      oneCommandMs: summary(commandMs),
      connectionsForCommands,
      commands,
      bridgeRequestFourCommandsMs: summary(requestMs),
      bridgeRequestUntilResponseWrittenMs: summary(untilResponseMs),
      requests,
    }));
  }
} finally {
  delete process.env[SSH_CONNECTION_SHARING_ENV];
  await stopSshEnvLabFixture(state).catch(() => undefined);
  await rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
}
