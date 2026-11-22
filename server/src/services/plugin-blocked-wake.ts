// STUDIO-0086: a plugin's "verified" wake on an issue that still has unresolved blockers.
//
// A plugin's wake request is refused while its issue waits on a blocker: at the plugin's door
// (plugin-host-services.ts, requestWakeup and requestWakeups) and at the two doors of the queue (heartbeat/queue.ts,
// admission and the start of the run). The worker router needs one way through: it tells the maintenance issue that
// a machine was lent to it, and it carries to the role that holds a machine the request to lend it and its return;
// the role's issue may be the one that waits on the maintenance issue. So a wake passes when, and only when:
// - its reason is in a closed list (PLUGIN_BLOCKED_ISSUE_WAKE_REASONS, packages/shared);
// - the plugin that asks declares `blockedIssueWakeups: true` in its manifest (and holds `issues.wakeup`, as any wake);
// - the wake carries the mark `pluginBlockedWake: { pluginId, reason }`, written by the plugin's door only.
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
import { agentWakeupRequests, plugins } from "@paperclipai/db";
import { PLUGIN_BLOCKED_ISSUE_WAKE_REASONS } from "@paperclipai/shared";
import { readPluginBlockedWake } from "../modules/run-dispatch/domain/wake-context.js";

/** Whether a manifest declares that its plugin may wake a blocked issue. */
export function declaresBlockedIssueWakeups(manifest: { blockedIssueWakeups?: unknown } | null | undefined): boolean {
  return manifest?.blockedIssueWakeups === true;
}

/** The mark the plugin's door writes for a wake it lets through, or null when the wake is an ordinary one. */
export function pluginBlockedWakeMark(input: {
  pluginId: string;
  reason: string | null | undefined;
  manifest: { blockedIssueWakeups?: unknown } | null | undefined;
}): { pluginId: string; reason: string } | null {
  if (!input.reason || !(PLUGIN_BLOCKED_ISSUE_WAKE_REASONS as readonly string[]).includes(input.reason)) return null;
  if (!declaresBlockedIssueWakeups(input.manifest)) return null;
  return { pluginId: input.pluginId, reason: input.reason };
}

/**
 * Whether a wake may run although its issue has unresolved blockers, as a plugin's verified wake. The requester is
 * the one of the wake request (given, or read by its id); a retry the server itself creates (a resource wait) keeps
 * the context but has no request of its own, and is admitted on the mark and the plugin's state.
 */
export async function verifyPluginBlockedWake(db: Pick<Db, "select">, input: {
  contextSnapshot: Record<string, unknown> | null | undefined;
  requestedByActorType?: string | null;
  requestedByActorId?: string | null;
  wakeupRequestId?: string | null;
}): Promise<boolean> {
  const mark = readPluginBlockedWake(input.contextSnapshot, PLUGIN_BLOCKED_ISSUE_WAKE_REASONS);
  if (!mark) return false;
  if (!mark.serverRetry) {
    const requester = input.wakeupRequestId
      ? await db.select({ type: agentWakeupRequests.requestedByActorType, id: agentWakeupRequests.requestedByActorId })
        .from(agentWakeupRequests).where(eq(agentWakeupRequests.id, input.wakeupRequestId)).then((rows) => rows[0] ?? null)
      : { type: input.requestedByActorType ?? null, id: input.requestedByActorId ?? null };
    if (requester?.type !== "system" || requester.id !== mark.pluginId) return false;
  }
  const [plugin] = await db.select({ status: plugins.status, manifest: plugins.manifestJson }).from(plugins)
    .where(and(eq(plugins.id, mark.pluginId))).limit(1);
  return plugin?.status === "ready" && declaresBlockedIssueWakeups(plugin.manifest);
}
