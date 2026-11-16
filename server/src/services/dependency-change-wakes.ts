// STUDIO-0063 (v5, point 2): one function for "dependencies changed". Every path that can make a dependent issue
// ready, or leave it waiting only on cancelled blockers, calls it with the dependents concerned; it decides and
// sends the wakes, so the routes no longer wake by themselves:
// - ready, with blockers left (all done): an `issue_blockers_resolved` wake, keyed on the ready state (one per state);
// - ready, with no blocker left (removed or deleted): an `issue_blockers_resolved` wake keyed on the change's time;
// - not ready, but every unresolved blocker cancelled: the dependency is handed back to the assignee as for a
//   cancelled blocker (STUDIO-0029), a system comment and its wake (a comment left without its wake is woken again).
// The assignee's admitted run then carries the agents' comments held meanwhile (held-dependency-comments.ts).
import { and, eq, inArray, isNull } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import { issueService } from "./issues.js";
import {
  ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
  buildIssueBlockersResolvedWakeStateKey,
  findExistingIssueBlockersResolvedWakeForReadyState,
} from "./issue-dependency-wakeups.js";
import { handBackDependentsLeftWithCancelledBlockers } from "./heartbeat/held-dependency-comments.js";

export type DependencyChangeWakeRequest = {
  source: "automation";
  triggerDetail: "system";
  reason: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  requestedByActorType: "user" | "agent" | "system";
  requestedByActorId: string | null;
  contextSnapshot: Record<string, unknown>;
};

export type DependencyChangeWakeSender = (agentId: string, request: DependencyChangeWakeRequest) => unknown;

export type DependencyChangeKind = "blocker_done" | "blockers_edited" | "blocker_deleted";

export async function wakeDependentsAfterDependencyChange(db: Db, input: {
  companyId: string;
  dependentIssueIds: readonly string[];
  kind: DependencyChangeKind;
  /** The blocker whose change this is (done or deleted), if any. */
  changedBlocker?: { id: string; identifier: string | null; completedAt?: Date | string | null } | null;
  actor: { type: "user" | "agent" | "system"; id: string | null };
  /** Time of the change: keys the wakes of a change that leaves no blocker. */
  at: Date;
  wake: DependencyChangeWakeSender;
  /**
   * For a blocker that became done: its dependents that are now ready, as `listWakeableBlockedDependents` reads them
   * (the caller's service boundary). The other dependents are only checked for a hand-back.
   */
  readyDependents?: ReadonlyArray<{ id: string; assigneeAgentId: string; blockerIssueIds: string[];
    blockedTransitionAt?: Date | string | null }>;
}): Promise<Array<{ dependentIssueId: string; outcome: "ready" | "handed_back" }>> {
  const out: Array<{ dependentIssueId: string; outcome: "ready" | "handed_back" }> = [];
  // An unknown change time (a caller without updatedAt) falls back to now: the key stays unique per change.
  if (Number.isNaN(input.at.getTime())) input = { ...input, at: new Date() };
  if (input.readyDependents) {
    for (const dependent of input.readyDependents) {
      const existing = await findExistingIssueBlockersResolvedWakeForReadyState(db, {
        companyId: input.companyId, dependentIssueId: dependent.id, blockerIssueIds: dependent.blockerIssueIds,
        blockedTransitionAt: dependent.blockedTransitionAt,
      }).catch(() => null);
      if (existing) continue;
      input.wake(dependent.assigneeAgentId, {
        ...readyWake(dependent.id, dependent.blockerIssueIds, input),
        idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
          dependentIssueId: dependent.id, blockerIssueIds: dependent.blockerIssueIds,
          blockedTransitionAt: dependent.blockedTransitionAt,
        }),
      });
      out.push({ dependentIssueId: dependent.id, outcome: "ready" });
    }
    const readyIds = new Set(input.readyDependents.map(dependent => dependent.id));
    const others = input.dependentIssueIds.filter(id => !readyIds.has(id));
    if (others.length > 0) {
      try {
        out.push(...await handBack(db, input, others));
      } catch {
        // The hand-back never prevents the ready dependents' wakes; the next dependency change retries it.
      }
    }
    return out;
  }
  const ids = [...new Set(input.dependentIssueIds)];
  if (ids.length === 0) return out;
  const svc = issueService(db);
  const readiness = await svc.listDependencyReadiness(input.companyId, ids);
  const rows = await db.select({
    id: issues.id, assigneeAgentId: issues.assigneeAgentId, status: issues.status,
    blockedTransitionAt: issues.blockedTransitionAt, conversationAgentId: issues.conversationAgentId,
  }).from(issues).where(and(eq(issues.companyId, input.companyId), inArray(issues.id, ids), isNull(issues.hiddenAt)));
  const byId = new Map(rows.map(row => [row.id, row]));
  const handBackFor: string[] = [];
  for (const id of ids) {
    const dependent = byId.get(id);
    if (!dependent?.assigneeAgentId || dependent.conversationAgentId) continue;
    if (["done", "cancelled", "backlog"].includes(dependent.status)) continue;
    const ready = readiness.get(id);
    if (!ready) {
      // No relation left at all (the last blocker removed or deleted): ready.
      if (input.kind === "blockers_edited" || input.kind === "blocker_deleted") {
        input.wake(dependent.assigneeAgentId, readyWake(id, [], input));
        out.push({ dependentIssueId: id, outcome: "ready" });
      }
      continue;
    }
    if (ready.isDependencyReady) {
      if (ready.blockerIssueIds.length > 0) {
        const existing = await findExistingIssueBlockersResolvedWakeForReadyState(db, {
          companyId: input.companyId, dependentIssueId: id, blockerIssueIds: ready.blockerIssueIds,
          blockedTransitionAt: dependent.blockedTransitionAt,
        }).catch(() => null);
        if (existing) continue;
        input.wake(dependent.assigneeAgentId, {
          ...readyWake(id, ready.blockerIssueIds, input),
          idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
            dependentIssueId: id, blockerIssueIds: ready.blockerIssueIds, blockedTransitionAt: dependent.blockedTransitionAt,
          }),
        });
      } else {
        input.wake(dependent.assigneeAgentId, readyWake(id, [], input));
      }
      out.push({ dependentIssueId: id, outcome: "ready" });
      continue;
    }
    handBackFor.push(id);
  }
  if (handBackFor.length > 0) out.push(...await handBack(db, input, handBackFor));
  return out;
}

async function handBack(db: Db, input: { companyId: string; wake: DependencyChangeWakeSender }, dependentIds: string[]) {
  const out: Array<{ dependentIssueId: string; outcome: "handed_back" }> = [];
  {
    for (const handoff of await handBackDependentsLeftWithCancelledBlockers(db, {
      companyId: input.companyId, dependentIds,
    })) {
      input.wake(handoff.assigneeAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId: handoff.dependentId, commentId: handoff.commentId, mutation: "comment",
          cancelledBlockerIssueId: handoff.cancelledBlockerIssueId },
        idempotencyKey: `issue_dependency_cancelled_left:${handoff.commentId}`,
        requestedByActorType: "system",
        requestedByActorId: "cancelled_blocker_handoff",
        contextSnapshot: {
          issueId: handoff.dependentId, taskId: handoff.dependentId,
          commentId: handoff.commentId, wakeCommentId: handoff.commentId,
          source: "issue.cancelled_dependency_handoff", wakeReason: "issue_commented",
          cancelledBlockerIssueId: handoff.cancelledBlockerIssueId,
        },
      });
      out.push({ dependentIssueId: handoff.dependentId, outcome: "handed_back" });
    }
  }
  return out;
}

function readyWake(dependentIssueId: string, blockerIssueIds: string[], input: {
  kind: DependencyChangeKind;
  changedBlocker?: { id: string } | null;
  actor: { type: "user" | "agent" | "system"; id: string | null };
  at: Date;
}): DependencyChangeWakeRequest {
  const source = input.kind === "blocker_done" ? "issue.blockers_resolved"
    : input.kind === "blocker_deleted" ? "issue.blocker_deleted" : "issue.blockers_edited";
  return {
    source: "automation",
    triggerDetail: "system",
    reason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
    payload: {
      issueId: dependentIssueId,
      blockerIssueIds,
      mutation: input.kind,
      ...(input.changedBlocker ? { resolvedBlockerIssueId: input.changedBlocker.id } : {}),
    },
    idempotencyKey: `issue_blockers_ready:${dependentIssueId}:${input.kind}:${input.changedBlocker?.id ?? "set"}:${input.at.toISOString()}`,
    requestedByActorType: input.actor.type,
    requestedByActorId: input.actor.id,
    contextSnapshot: {
      issueId: dependentIssueId,
      taskId: dependentIssueId,
      wakeReason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
      source,
      blockerIssueIds,
      ...(input.changedBlocker ? { resolvedBlockerIssueId: input.changedBlocker.id } : {}),
    },
  };
}
