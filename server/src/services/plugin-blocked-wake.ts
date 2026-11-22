// STUDIO-0086: a plugin's "verified" wake on an issue that still has unresolved blockers.
//
// A plugin's wake request is refused while its issue waits on a blocker: at the plugin's door
// (plugin-host-services.ts, requestWakeup and requestWakeups) and at the two doors of the queue (heartbeat/queue.ts,
// admission and the start of the run). The worker router needs one way through: it tells the maintenance issue that
// a machine was lent to it, and it carries to the role that holds a machine the request to lend it and its return;
// the role's issue may be the one that waits on the maintenance issue. This is a RIGHT of that one plugin, and it is
// narrow. A wake passes when, and only when:
// - its reason is in a closed list (PLUGIN_BLOCKED_ISSUE_WAKE_REASONS, packages/shared);
// - the plugin that asks is the worker router, by its key (PLUGIN_BLOCKED_ISSUE_WAKE_PLUGIN_KEYS), and its manifest
//   declares `blockedIssueWakeups: true` (it holds `issues.wakeup`, as for any wake);
// - the wake carries the mark `pluginBlockedWake: { pluginId, reason }`, written by the plugin's door only.
// The wake carries fixed data only: no text of the plugin's, or of a role's, reaches the run through it.
// It lifts no blocker and changes no status. Which issue a reason may target (the holder's, the maintenance's) is
// the router's to enforce: the server knows nothing of machines and maintenances.
//
// The mark alone never qualifies, as for a stalled blocker (verifyBlockerStallWake): the doors of the queue read the
// server's own state again. Anything else keeps today's refusal: an ordinary plugin wake, a plugin that does not
// declare the field, an agent's comment on a blocked issue (STUDIO-0063), an issue that is `backlog`, `done` or
// `cancelled`. No right is given to a role: the run is the assignee's own, in the bounded mode of a blocked issue.
//
// The declaration is a manifest field and not a capability on purpose: the host validates a manifest each time it
// activates a plugin, and an unknown capability fails it, so a plugin that declared a new capability could no longer
// load on a server without this patch (a roll-back of the server would stop it). An unknown field is dropped.
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, heartbeatRuns, plugins } from "@paperclipai/db";
import { PLUGIN_BLOCKED_ISSUE_WAKE_PLUGIN_KEYS, PLUGIN_BLOCKED_ISSUE_WAKE_REASONS } from "@paperclipai/shared";
import { readPluginBlockedWake } from "../modules/run-dispatch/domain/wake-context.js";

/** Whether a manifest declares that its plugin may wake a blocked issue. */
export function declaresBlockedIssueWakeups(manifest: { blockedIssueWakeups?: unknown } | null | undefined): boolean {
  return manifest?.blockedIssueWakeups === true;
}

/** Whether the plugin is one that holds the right: the worker router, by its key, with the declaration in its manifest. */
export function holdsBlockedIssueWakeRight(plugin: {
  pluginKey: string | null | undefined;
  manifest: { blockedIssueWakeups?: unknown } | null | undefined;
}): boolean {
  return Boolean(plugin.pluginKey) && (PLUGIN_BLOCKED_ISSUE_WAKE_PLUGIN_KEYS as readonly string[]).includes(plugin.pluginKey!)
    && declaresBlockedIssueWakeups(plugin.manifest);
}

/** The context source of a wake let through: a fixed text, whatever the plugin passes. */
export const PLUGIN_BLOCKED_WAKE_CONTEXT_SOURCE = "plugin.issue.blocked_wake";

/** The mark the plugin's door writes for a wake it lets through, or null when the wake is an ordinary one. */
export function pluginBlockedWakeMark(input: {
  pluginId: string;
  pluginKey: string | null | undefined;
  reason: string | null | undefined;
  manifest: { blockedIssueWakeups?: unknown } | null | undefined;
}): { pluginId: string; reason: string } | null {
  if (!input.reason || !(PLUGIN_BLOCKED_ISSUE_WAKE_REASONS as readonly string[]).includes(input.reason)) return null;
  if (!holdsBlockedIssueWakeRight(input)) return null;
  return { pluginId: input.pluginId, reason: input.reason };
}

/** Who asked for a wake: read from its request row. Only the plugin's door asks as the system for that plugin. */
async function requestedByThePlugin(db: Pick<Db, "select">, wakeupRequestId: string | null, pluginId: string): Promise<boolean> {
  if (!wakeupRequestId) return false;
  const [requester] = await db.select({ type: agentWakeupRequests.requestedByActorType, id: agentWakeupRequests.requestedByActorId })
    .from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeupRequestId)).limit(1);
  return requester?.type === "system" && requester.id === pluginId;
}

/**
 * The retry path. A context that says "I am a retry" proves nothing: anyone who could write a context could write
 * that. What proves it is the server's own state: the run being judged is a row whose `retry_of_run_id` the server
 * wrote, the run it retries carried the same mark (same plugin, same reason, the fixed source the plugin's door
 * writes) for the same agent and the same issue, and so on back to the run the plugin's door asked for, whose wake
 * request names the plugin. No run to judge (the admission of a new wake): no retry path.
 */
async function serverRetryOfThePluginWake(db: Pick<Db, "select">, input: {
  runId: string | null | undefined;
  contextSnapshot: Record<string, unknown> | null | undefined;
  mark: { pluginId: string; reason: string };
}): Promise<boolean> {
  if (!input.runId) return false;
  const context = input.contextSnapshot ?? {};
  const seen = new Set<string>();
  let judgedId = input.runId;
  // The server's retries of one run are bounded; the count only guards this loop.
  for (let hop = 0; hop < 50; hop += 1) {
    if (seen.has(judgedId)) return false;
    seen.add(judgedId);
    const [judged] = await db.select({ companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId, retryOfRunId: heartbeatRuns.retryOfRunId })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, judgedId)).limit(1);
    if (!judged?.retryOfRunId) return false;
    if (hop === 0 && context.retryOfRunId !== judged.retryOfRunId) return false;
    const [retried] = await db.select({ companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId, retryOfRunId: heartbeatRuns.retryOfRunId,
      wakeupRequestId: heartbeatRuns.wakeupRequestId, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, judged.retryOfRunId)).limit(1);
    if (!retried || retried.companyId !== judged.companyId || retried.agentId !== judged.agentId) return false;
    const retriedContext = (retried.contextSnapshot ?? {}) as Record<string, unknown>;
    const retriedMark = (retriedContext.pluginBlockedWake ?? {}) as Record<string, unknown>;
    if (retriedMark.pluginId !== input.mark.pluginId || retriedMark.reason !== input.mark.reason) return false;
    if (retriedContext.source !== PLUGIN_BLOCKED_WAKE_CONTEXT_SOURCE || retriedContext.issueId !== context.issueId) return false;
    if (!retried.retryOfRunId) {
      return retriedContext.wakeReason === input.mark.reason && requestedByThePlugin(db, retried.wakeupRequestId, input.mark.pluginId);
    }
    judgedId = judged.retryOfRunId;
  }
  return false;
}

/**
 * Whether a wake may run although its issue has unresolved blockers, as a plugin's verified wake. The requester is
 * the one of the wake request (given at the admission, or read by its id). A retry the server itself creates (a lost
 * link, a resource wait) keeps the context and has a request of the server's own: it is admitted only when the
 * database says it is the server's retry of the plugin's wake (serverRetryOfThePluginWake); `runId` is the run being
 * judged, when there is one.
 */
export async function verifyPluginBlockedWake(db: Pick<Db, "select">, input: {
  contextSnapshot: Record<string, unknown> | null | undefined;
  requestedByActorType?: string | null;
  requestedByActorId?: string | null;
  wakeupRequestId?: string | null;
  runId?: string | null;
}): Promise<boolean> {
  const mark = readPluginBlockedWake(input.contextSnapshot, PLUGIN_BLOCKED_ISSUE_WAKE_REASONS);
  if (!mark) return false;
  if (mark.serverRetry) {
    if (!(await serverRetryOfThePluginWake(db, { runId: input.runId, contextSnapshot: input.contextSnapshot, mark }))) return false;
  } else if (input.wakeupRequestId) {
    if (!(await requestedByThePlugin(db, input.wakeupRequestId, mark.pluginId))) return false;
  } else if (input.requestedByActorType !== "system" || input.requestedByActorId !== mark.pluginId) {
    return false;
  }
  const [plugin] = await db.select({ status: plugins.status, pluginKey: plugins.pluginKey, manifest: plugins.manifestJson }).from(plugins)
    .where(and(eq(plugins.id, mark.pluginId))).limit(1);
  return plugin?.status === "ready" && holdsBlockedIssueWakeRight(plugin);
}
