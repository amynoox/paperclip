// STUDIO-0079: the retry lane of an ssh lease outage (see ../ssh-lease-outage.ts).
//
// The lane is bounded by time, not by a number of attempts: the lease is asked
// for again after a growing delay, capped at five minutes, until
// SSH_LEASE_OUTAGE_MAX_MS has passed since the outage began. When the link
// returns, the retry that is due acquires the lease and the run starts by
// itself.
//
// The outage begins at the END of the first failed run of the latest
// consecutive series of the agent's runs on the issue that all failed on the
// ssh lease. It is read from the runs, not carried along the retry chain: a
// run woken by something else in the middle (a comment, a person's Retry) and
// failing the same way belongs to the same outage and does not restart the
// clock. Cancelled runs and runs that never started are not part of the
// series and do not end it.
import { and, asc, desc, eq, gt, isNotNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { ENVIRONMENT_PROVIDER_UNAVAILABLE_CODE } from "../environment-provider-unavailable-error.js";
import { executionRetryAttemptCount } from "../execution-recovery-attempt.js";
import {
  SSH_LEASE_OUTAGE_MAX_MS,
  SSH_LEASE_OUTAGE_RETRY_DELAYS_MS,
  SSH_LEASE_OUTAGE_RETRY_REASON,
  SSH_LEASE_OUTAGE_WAKE_REASON,
  sshLeaseOutageRetryDelayMs,
} from "../ssh-lease-outage.js";

type OutageRunRef = {
  id: string;
  companyId: string;
  agentId: string;
  createdAt: Date;
  finishedAt: Date | null;
  contextSnapshot: Record<string, unknown> | null;
  scheduledRetryAttempt?: number | null;
  scheduledRetryReason?: string | null;
};

function issueIdOf(run: Pick<OutageRunRef, "contextSnapshot">): string | null {
  const value = run.contextSnapshot?.issueId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** When the outage this failed run belongs to began. */
export async function readSshLeaseOutageStart(db: Db, run: OutageRunRef): Promise<Date> {
  const issueId = issueIdOf(run);
  const scope = and(
    eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.agentId, run.agentId),
    issueId
      ? sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`
      : sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' is null`,
    isNotNull(heartbeatRuns.startedAt),
  );
  const outage = and(
    eq(heartbeatRuns.status, "failed"),
    eq(heartbeatRuns.errorCode, ENVIRONMENT_PROVIDER_UNAVAILABLE_CODE),
    sql`${heartbeatRuns.resultJson} -> 'providerFailure' ->> 'provider' = 'ssh'`,
  );
  const [lastOther] = await db
    .select({ createdAt: heartbeatRuns.createdAt })
    .from(heartbeatRuns)
    .where(and(
      scope,
      sql`not coalesce(${outage}, false)`,
      // A cancelled run says nothing about the link; a live one has not ended.
      notInArray(heartbeatRuns.status, ["cancelled", "queued", "running", "scheduled_retry"]),
    ))
    .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
    .limit(1);
  const [first] = await db
    .select({ createdAt: heartbeatRuns.createdAt, finishedAt: heartbeatRuns.finishedAt })
    .from(heartbeatRuns)
    .where(and(scope, outage, lastOther ? gt(heartbeatRuns.createdAt, lastOther.createdAt) : undefined))
    .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
    .limit(1);
  return first?.finishedAt ?? first?.createdAt ?? run.finishedAt ?? run.createdAt;
}

export interface SshLeaseOutageRetry {
  retryReason: typeof SSH_LEASE_OUTAGE_RETRY_REASON;
  wakeReason: typeof SSH_LEASE_OUTAGE_WAKE_REASON;
  /** Zero once the bound has passed: the scheduler then records the exhaustion and queues nothing. */
  maxAttempts: number;
  delayMs: number;
  outageStartedAt: Date;
  outageDeadline: Date;
}

/** The lane's options for the retry that follows this failed run. */
export async function sshLeaseOutageRetry(db: Db, run: OutageRunRef, now: Date = new Date()): Promise<SshLeaseOutageRetry> {
  const outageStartedAt = await readSshLeaseOutageStart(db, run);
  const outageDeadline = new Date(outageStartedAt.getTime() + SSH_LEASE_OUTAGE_MAX_MS);
  const attempt = executionRetryAttemptCount(run, SSH_LEASE_OUTAGE_RETRY_REASON) + 1;
  const longestDelayMs = SSH_LEASE_OUTAGE_RETRY_DELAYS_MS[SSH_LEASE_OUTAGE_RETRY_DELAYS_MS.length - 1]!;
  const remainingMs = outageDeadline.getTime() - now.getTime();
  return {
    retryReason: SSH_LEASE_OUTAGE_RETRY_REASON,
    wakeReason: SSH_LEASE_OUTAGE_WAKE_REASON,
    // Within the bound the number shown is this attempt plus what the remaining time allows.
    maxAttempts: remainingMs > 0 ? attempt + Math.ceil(remainingMs / longestDelayMs) : 0,
    delayMs: sshLeaseOutageRetryDelayMs(attempt),
    outageStartedAt,
    outageDeadline,
  };
}
