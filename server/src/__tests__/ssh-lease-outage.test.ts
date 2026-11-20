import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { readSshLeaseOutageStart, sshLeaseOutageRetry } from "../services/heartbeat/ssh-lease-outage-retry.js";
import {
  SSH_LEASE_OUTAGE_MAX_MS,
  SSH_LEASE_OUTAGE_RETRY_DELAYS_MS,
  SSH_LEASE_OUTAGE_RETRY_REASON,
  SSH_LEASE_OUTAGE_WAKE_REASON,
  isSshLeaseOutageRun,
  sshLeaseOutageRetryDelayMs,
} from "../services/ssh-lease-outage.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// The ssh lease probe is the only thing replaced: every other step is the server's real path (the ssh
// driver's lease, the orchestrator's classification, the run's failure, the retry scheduler, the sweep).
// A failing probe throws the raw error `ssh` gave, passed through the real classifier of the probe.
const probe = vi.hoisted(() => ({ failure: null as null | (() => Error), calls: 0 }));
vi.mock("@paperclipai/adapter-utils/ssh", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/ssh")>();
  return {
    ...actual,
    ensureSshWorkspaceReady: async (config: { remoteWorkspacePath: string }) => {
      probe.calls += 1;
      if (probe.failure) throw actual.withSshLeaseProbeFailureCause(probe.failure());
      return { remoteCwd: config.remoteWorkspacePath };
    },
  };
});

// TR-2093, run fa0c4bc6 (20 Nov 2026 03:26:21 to 03:26:38): the probe killed by its own 15 s timeout,
// the command line alone as the error, no stderr line.
const TR_2093_MESSAGE = "Command failed: ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes "
  + "-o UserKnownHostsFile=/tmp/paperclip-ssh-known-hosts-x/file -i /tmp/paperclip-ssh-key-x/file -p 22 pk-infra@100.124.59.108 "
  + "sh -c 'mkdir -p /srv/paperclip-infra/execution && cd /srv/paperclip-infra/execution && pwd'\n";
const killedByLocalTimeout = () => Object.assign(new Error(TR_2093_MESSAGE), { code: null, killed: true, signal: "SIGTERM", stdout: "", stderr: "" });
const sshExit255 = (stderr: string) => () => Object.assign(new Error(`Command failed: ssh ...\n${stderr}\n`), { code: 255, killed: false, stdout: "", stderr: `${stderr}\n` });

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping ssh lease outage tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}
const ADAPTER = "ssh_lease_outage_test";
const MINUTE = 60_000;

describe("ssh lease outage: the lane", () => {
  it("waits 30 s, 60 s, 120 s, 240 s, then 5 minutes for as long as it lasts", () => {
    expect([1, 2, 3, 4, 5, 6, 40].map(sshLeaseOutageRetryDelayMs)).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
    expect(SSH_LEASE_OUTAGE_RETRY_DELAYS_MS).toEqual([30_000, 60_000, 120_000, 240_000, 300_000]);
    expect(sshLeaseOutageRetryDelayMs(0)).toBe(30_000);
    expect(SSH_LEASE_OUTAGE_MAX_MS).toBe(12 * 60 * MINUTE);
  });

  it("recognises only a failed run whose lease provider is ssh", () => {
    const outage = { status: "failed", errorCode: "environment_provider_unavailable", resultJson: { providerFailure: { provider: "ssh" } } };
    expect(isSshLeaseOutageRun(outage)).toBe(true);
    expect(isSshLeaseOutageRun({ ...outage, resultJson: { providerFailure: { provider: "daytona" } } })).toBe(false);
    expect(isSshLeaseOutageRun({ ...outage, resultJson: {} })).toBe(false);
    expect(isSshLeaseOutageRun({ ...outage, errorCode: "setup_failed" })).toBe(false);
    expect(isSshLeaseOutageRun({ ...outage, status: "cancelled" })).toBe(false);
    expect(isSshLeaseOutageRun(null)).toBe(false);
  });
});

describeEmbeddedPostgres("ssh lease outage on the real run path (TR-2093)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let workspaceCwd!: string;
  const executedRunIds: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ssh-lease-outage-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    workspaceCwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-lease-outage-"));
    registerServerAdapter({
      type: ADAPTER,
      execute: async (input) => {
        executedRunIds.push(input.runId);
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, String(input.context.issueId)));
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
      },
      testEnvironment: async () => ({ adapterType: ADAPTER, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 240_000);

  afterEach(async () => {
    probe.failure = null;
    probe.calls = 0;
    executedRunIds.length = 0;
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() })
      .where(sql`${heartbeatRuns.status} in ('running', 'queued', 'scheduled_retry')`);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
  });

  afterAll(async () => {
    unregisterServerAdapter(ADAPTER);
    if (workspaceCwd) await fs.rm(workspaceCwd, { recursive: true, force: true });
    await db?.$client.end({ timeout: 0 });
    await tempDb?.cleanup();
  });

  type Fixture = { companyId: string; agentId: string; issueId: string; environmentId: string };

  async function seed(): Promise<Fixture> {
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    const companyId = randomUUID(), projectId = randomUUID(), projectWorkspaceId = randomUUID();
    const agentId = randomUUID(), issueId = randomUUID(), environmentId = randomUUID();
    const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = new Date();
    await db.insert(companies).values({ id: companyId, name: "Ssh outage fixture", issuePrefix,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user" });
    await db.insert(authUsers).values({ id: "responsible-user", name: "Responsible user", email: "ssh-outage@example.test", createdAt: now, updatedAt: now })
      .onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Infra project" });
    await db.insert(projectWorkspaces).values({ id: projectWorkspaceId, companyId, projectId, name: "Primary workspace",
      sourceType: "local_path", cwd: workspaceCwd, isPrimary: true });
    // As PK-OVH-INFRA: an ssh environment, the default of the role.
    await db.insert(environments).values({ id: environmentId, name: `PK-OVH-INFRA ${environmentId.slice(0, 8)}`, driver: "ssh", status: "active",
      config: { host: "infra-test.invalid", username: "pk-infra", remoteWorkspacePath: workspaceCwd } });
    await db.insert(agents).values({ id: agentId, companyId, name: "Infra Manager", role: "engineer", status: "idle",
      adapterType: ADAPTER, adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      defaultEnvironmentId: environmentId, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Infra task", status: "in_progress", priority: "medium",
      responsibleUserId: "responsible-user", assigneeAgentId: agentId, projectId, projectWorkspaceId, issueNumber: 1, identifier: `${issuePrefix}-1` });
    return { companyId, agentId, issueId, environmentId };
  }

  const runsOf = (f: Fixture) => db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, f.agentId)))
    .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id));
  const issueOf = async (f: Fixture) => (await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]!;
  const actionsOf = (f: Fixture) => db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
  const scheduledOf = async (f: Fixture) => (await runsOf(f)).filter((run) => run.status === "scheduled_retry");

  async function start(f: Fixture, wakeReason = "issue_assigned") {
    const run = await heartbeat.invoke(f.agentId, "assignment", { issueId: f.issueId, wakeReason }, "system");
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    return (await heartbeat.getRun(run!.id))!;
  }

  // The retry that is waiting comes due, as it would in real time, and runs.
  async function promote(f: Fixture) {
    const scheduled = await scheduledOf(f);
    expect(scheduled).toHaveLength(1);
    await heartbeat.promoteDueScheduledRetries(new Date(scheduled[0]!.scheduledRetryAt!.getTime() + 1_000));
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    return (await heartbeat.getRun(scheduled[0]!.id))!;
  }

  // Move every run of the role back in time, as if that much time had passed.
  async function age(f: Fixture, minutes: number) {
    await db.execute(sql`update heartbeat_runs set
      created_at = created_at - make_interval(mins => ${minutes}),
      started_at = started_at - make_interval(mins => ${minutes}),
      finished_at = finished_at - make_interval(mins => ${minutes}),
      scheduled_retry_at = scheduled_retry_at - make_interval(mins => ${minutes})
      where company_id = ${f.companyId} and agent_id = ${f.agentId}`);
  }

  it("TR-2093: the lease fails for 30 minutes, then the link returns; the run starts by itself, the issue is never blocked", async () => {
    const f = await seed();
    probe.failure = killedByLocalTimeout;
    const first = await start(f);
    expect(first).toMatchObject({ status: "failed", errorCode: "environment_provider_unavailable" });
    expect(first.error).toMatch(/^Failed to acquire lease for environment "PK-OVH-INFRA [0-9a-f]{8}" \(ssh\): Command failed: ssh -o BatchMode=yes/);
    expect(first.resultJson).toMatchObject({ providerFailure: { provider: "ssh", phase: "startup", providerCode: "ETIMEDOUT", retryability: "transient" } });
    expect(isSshLeaseOutageRun(first)).toBe(true);

    // Eight more attempts, each due after its delay; the delay grows and then stays at five minutes.
    const delays: number[] = [];
    let previous = first;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const [retry] = await scheduledOf(f);
      expect(retry).toMatchObject({ retryOfRunId: previous.id, scheduledRetryReason: SSH_LEASE_OUTAGE_RETRY_REASON, scheduledRetryAttempt: attempt });
      expect(retry!.contextSnapshot).toMatchObject({ wakeReason: SSH_LEASE_OUTAGE_WAKE_REASON, retryReason: SSH_LEASE_OUTAGE_RETRY_REASON });
      // Read again: the rows were moved back in time since `previous` was read.
      const predecessor = (await heartbeat.getRun(previous.id))!;
      delays.push(Math.round((retry!.scheduledRetryAt!.getTime() - predecessor.finishedAt!.getTime()) / 10_000) * 10);
      // Between two attempts the issue is at work, held by the waiting retry, and the sweep leaves it alone.
      expect(await issueOf(f)).toMatchObject({ status: "in_progress", executionRunId: retry!.id });
      await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
      expect((await issueOf(f)).status).toBe("in_progress");
      expect(await actionsOf(f)).toHaveLength(0);
      previous = await promote(f);
      expect(previous).toMatchObject({ id: retry!.id, status: "failed", errorCode: "environment_provider_unavailable" });
      // Time passes: four minutes per attempt, more than 30 minutes in all.
      await age(f, 4);
    }
    expect(delays).toEqual([30, 60, 120, 240, 300, 300, 300, 300]);
    expect(executedRunIds).toHaveLength(0);
    const outageStart = await readSshLeaseOutageStart(db, previous);
    expect(Date.now() - outageStart.getTime()).toBeGreaterThan(30 * MINUTE);
    // The lane never spends the failure budget.
    expect((await scheduledOf(f))[0]!.contextSnapshot).toMatchObject({ executionRetryAccounting: { failureRetries: 0 } });

    // The link returns: the retry that is due acquires the lease and the engine runs, once.
    probe.failure = null;
    const done = await promote(f);
    expect(done).toMatchObject({ status: "succeeded", scheduledRetryReason: SSH_LEASE_OUTAGE_RETRY_REASON, scheduledRetryAttempt: 9 });
    expect(executedRunIds).toEqual([done.id]);
    expect(probe.calls).toBe(10);
    expect((await issueOf(f)).status).toBe("done");
    expect(await actionsOf(f)).toHaveLength(0);
    expect(await scheduledOf(f)).toHaveLength(0);
    expect((await runsOf(f)).map((run) => run.status)).toEqual([...Array(9).fill("failed"), "succeeded"]);
  }, 300_000);

  it.each([
    ["a connection that times out", sshExit255("ssh: connect to host 100.124.59.108 port 22: Connection timed out"), "ETIMEDOUT"],
    ["a link cut during the key exchange", sshExit255("kex_exchange_identification: read: Connection reset by peer"), "ECONNRESET"],
    ["a name that cannot be resolved for now", sshExit255("ssh: Could not resolve hostname pk-infra: Temporary failure in name resolution"), "EAI_AGAIN"],
  ] as Array<[string, () => Error, string]>)("takes the same lane for %s", async (_name, failure, code) => {
    const f = await seed();
    probe.failure = failure;
    const first = await start(f);
    expect(first).toMatchObject({ status: "failed", errorCode: "environment_provider_unavailable" });
    expect(first.resultJson).toMatchObject({ providerFailure: { provider: "ssh", providerCode: code } });
    expect((await scheduledOf(f))[0]).toMatchObject({ scheduledRetryReason: SSH_LEASE_OUTAGE_RETRY_REASON, scheduledRetryAttempt: 1 });
  }, 180_000);

  it.each([
    ["a refused key", sshExit255("pk-infra@100.124.59.108: Permission denied (publickey).")],
    ["an unknown host", sshExit255("ssh: Could not resolve hostname pk-infra: Name or service not known")],
    ["a changed host key", sshExit255("Host key verification failed.")],
  ] as Array<[string, () => Error]>)("%s is no outage: today's path, unchanged", async (_name, failure) => {
    const f = await seed();
    probe.failure = failure;
    const first = await start(f);
    expect(first).toMatchObject({ status: "failed", errorCode: "setup_failed" });
    expect(isSshLeaseOutageRun(first)).toBe(false);
    expect(await scheduledOf(f)).toHaveLength(0);
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    await heartbeat.drainActiveRunExecutions();
    expect((await issueOf(f)).status).toBe("blocked");
    expect((await actionsOf(f))[0]).toMatchObject({ kind: "stranded_assigned_issue", status: "active" });
  }, 180_000);

  it("past 12 h the lane stops, says so on the run, and queues nothing more", async () => {
    const f = await seed();
    probe.failure = killedByLocalTimeout;
    const first = await start(f);
    await promote(f);
    // Twelve hours and one minute have passed since the first failure ended.
    await age(f, 12 * 60 + 1);
    const last = await promote(f);
    expect(last).toMatchObject({ status: "failed", errorCode: "environment_provider_unavailable", scheduledRetryAttempt: 2 });
    expect(await scheduledOf(f)).toHaveLength(0);
    expect((await runsOf(f)).map((run) => run.status)).toEqual(["failed", "failed", "failed"]);
    const retry = await sshLeaseOutageRetry(db, last);
    expect(retry.maxAttempts).toBe(0);
    expect(retry.outageStartedAt.getTime()).toBe((await heartbeat.getRun(first.id))!.finishedAt!.getTime());
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, last.id));
    expect(events.some((event) => String(event.message).includes("Bounded retry exhausted after 2 scheduled attempts"))).toBe(true);
  }, 180_000);

  it("one minute before 12 h the lane still retries", async () => {
    const f = await seed();
    probe.failure = killedByLocalTimeout;
    await start(f);
    await promote(f);
    await age(f, 12 * 60 - 1);
    const last = await promote(f);
    expect(last.status).toBe("failed");
    expect((await scheduledOf(f))[0]).toMatchObject({ retryOfRunId: last.id, scheduledRetryReason: SSH_LEASE_OUTAGE_RETRY_REASON, scheduledRetryAttempt: 3 });
  }, 180_000);

  it("a run woken by something else during the outage does not restart the clock", async () => {
    const f = await seed();
    probe.failure = killedByLocalTimeout;
    const first = await start(f);
    // The waiting retry is cancelled before it starts (a gate), and 12 h 05 pass.
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "issue_waiting_for_response", finishedAt: new Date() })
      .where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "scheduled_retry")));
    await db.update(issues).set({ executionRunId: null, executionLockedAt: null, executionAgentNameKey: null }).where(eq(issues.id, f.issueId));
    await age(f, 12 * 60 + 5);
    // A comment wakes the role: a new run, not a retry of the first one. It fails on the lease too.
    const woken = await start(f, "issue_commented");
    expect(woken).toMatchObject({ status: "failed", errorCode: "environment_provider_unavailable", retryOfRunId: null });
    // Same outage: its clock began at the first failure, so nothing more is queued.
    expect((await readSshLeaseOutageStart(db, woken)).getTime()).toBe((await heartbeat.getRun(first.id))!.finishedAt!.getTime());
    expect(await scheduledOf(f)).toHaveLength(0);
  }, 180_000);

  it("a run that got its lease ends the outage: the next one has its own 12 h", async () => {
    const f = await seed();
    probe.failure = killedByLocalTimeout;
    await start(f);
    probe.failure = null;
    const worked = await promote(f);
    expect(worked.status).toBe("succeeded");
    await age(f, 13 * 60);
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.issueId));
    probe.failure = killedByLocalTimeout;
    const again = await start(f, "issue_commented");
    expect(again).toMatchObject({ status: "failed", errorCode: "environment_provider_unavailable" });
    expect((await readSshLeaseOutageStart(db, again)).getTime()).toBe(again.finishedAt!.getTime());
    expect((await scheduledOf(f))[0]).toMatchObject({ retryOfRunId: again.id, scheduledRetryReason: SSH_LEASE_OUTAGE_RETRY_REASON, scheduledRetryAttempt: 1 });
  }, 180_000);
});
