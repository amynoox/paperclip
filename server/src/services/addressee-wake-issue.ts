// STUDIO-0087: the wake of a card addressed to an agent may go to a task of that agent itself.
//
// A card (issue-thread interaction) addressed to an agent wakes that agent on the card's own task. When two roles
// work together, each on its own task, the addressee is not the assignee of the card's task: a routed role is refused
// there (the worker router admits a role on a task assigned to it only), and the card is answered only if something
// else wakes the addressee.
//
// The optional creation field `addresseeWakeIssueId` names the task on which the addressee is woken instead. It is
// accepted only when that task is in the same company, is assigned to the addressee, and is neither `done` nor
// `cancelled`. Without the field nothing changes. The field is not stored on the card: it lives in the wake request
// and in the run's context (`interactionId`, `interactionIssueId` = the card's task).
//
// On its own task the addressee is the assignee, so the wake follows the ordinary path. One gate still stops it:
// unresolved blockers on that task. By default that gate stays as it is: the wake is held as any wake on a blocked
// task, and the card stays pending. A COMPANY SETTING, OFF unless set (ADDRESSEE_WAKE_ON_BLOCKED_ISSUE_SETTING, in
// the company's interactionResolverGovernance), lets a card's wake pass it, in the bounded mode of a blocked task,
// when the server's own state says so (verifyOwnIssueInteractionWake): the context alone never qualifies. Without
// the setting, any role could pull another role onto a blocked task by a card. It lifts no blocker and changes no
// status. The server does not know which task of the addressee is "the right one" for the work in common:
// it only checks that the named task is the addressee's.
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, issueThreadInteractions, issues } from "@paperclipai/db";
import { unprocessable } from "../errors.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * STUDIO-0092: ONE refusal for every reason the named task cannot be used. Three different messages told a caller
 * whether a task it cannot see exists in the company, whose it is, and whether it is open.
 */
export const ADDRESSEE_WAKE_ISSUE_REFUSED =
  "addresseeWakeIssueId cannot be used for this card: name a task in progress or in review that is assigned to the addressee agent and that you can comment";

/** The refusal itself, for the entries that check the creator's access before the card is created. */
export function refuseAddresseeWakeIssue(): never {
  throw unprocessable(ADDRESSEE_WAKE_ISSUE_REFUSED);
}

/** STUDIO-0092: the addressee is woken only on a task it is at work on: `todo`, `backlog` and `blocked` are refused. */
const ADDRESSEE_WAKE_ISSUE_STATUSES = ["in_progress", "in_review"];

/**
 * The checks of the creation field on the named task and the addressee: same company, assigned to the addressee
 * agent, in progress or in review; and the field needs an addressee agent. Throws 422, with one message for the task.
 * The creator's own access to the named task is checked by each entry (the route, a plugin's createInteraction).
 */
export async function assertAddresseeWakeIssue(db: Pick<Db, "select">, input: {
  companyId: string;
  addresseeAgentId: string | null | undefined;
  addresseeWakeIssueId: string;
}): Promise<void> {
  if (!input.addresseeAgentId) throw unprocessable("addresseeWakeIssueId requires addresseeAgentId");
  const [wakeIssue] = await db
    .select({ companyId: issues.companyId, assigneeAgentId: issues.assigneeAgentId, status: issues.status })
    .from(issues).where(eq(issues.id, input.addresseeWakeIssueId)).limit(1);
  if (!wakeIssue || wakeIssue.companyId !== input.companyId || wakeIssue.assigneeAgentId !== input.addresseeAgentId
      || !ADDRESSEE_WAKE_ISSUE_STATUSES.includes(wakeIssue.status)) {
    refuseAddresseeWakeIssue();
  }
}

/**
 * Where the wake of a card goes: the named task of the addressee, or the card's own task (today's behaviour). `context`
 * is what the wake's context carries on top when the wake leaves the card's task.
 */
export function addresseeWakeTarget(cardIssueId: string, addresseeWakeIssueId: unknown): {
  issueId: string;
  context: { interactionIssueId?: string };
} {
  const named = readNonEmptyString(addresseeWakeIssueId);
  return named && named !== cardIssueId
    ? { issueId: named, context: { interactionIssueId: cardIssueId } }
    : { issueId: cardIssueId, context: {} };
}

type OwnIssueCard = { interactionId: string; cardIssueId: string; cardIssueIdentifier: string | null };

/**
 * The card a run on the agent's own task was woken for, read from the server's state: the context names a card and
 * the card's task (another one), that card is still `pending`, addressed to the run's agent, on the task the context
 * names, in the same company; and the run's task is assigned to that agent. Null otherwise. A retry the server
 * creates keeps the context but not the wake reason.
 */
export async function readOwnIssueInteractionWake(db: Pick<Db, "select">, input: {
  companyId: string;
  issueId: string;
  agentId: string;
  contextSnapshot: Record<string, unknown> | null | undefined;
}): Promise<OwnIssueCard | null> {
  const context = input.contextSnapshot ?? {};
  const interactionId = readNonEmptyString(context.interactionId);
  const cardIssueId = readNonEmptyString(context.interactionIssueId);
  if (!interactionId || !cardIssueId || cardIssueId === input.issueId) return null;
  if (context.wakeReason !== "interaction_pending" && !readNonEmptyString(context.retryOfRunId)) return null;
  const [card] = await db
    .select({ id: issueThreadInteractions.id, cardIssueIdentifier: issues.identifier })
    .from(issueThreadInteractions)
    .innerJoin(issues, eq(issues.id, issueThreadInteractions.issueId))
    .where(and(
      eq(issueThreadInteractions.id, interactionId),
      eq(issueThreadInteractions.companyId, input.companyId),
      eq(issueThreadInteractions.issueId, cardIssueId),
      eq(issueThreadInteractions.addresseeAgentId, input.agentId),
      eq(issueThreadInteractions.status, "pending"),
    )).limit(1);
  if (!card) return null;
  const [own] = await db.select({ id: issues.id }).from(issues).where(and(
    eq(issues.id, input.issueId), eq(issues.companyId, input.companyId), eq(issues.assigneeAgentId, input.agentId),
  )).limit(1);
  return own ? { interactionId, cardIssueId, cardIssueIdentifier: card.cardIssueIdentifier } : null;
}

/**
 * The company's switch for the gate below: `interactionResolverGovernance.addresseeWakeOnBlockedIssue.enabled`. OFF
 * unless it is exactly `true`; no install sets it.
 */
export const ADDRESSEE_WAKE_ON_BLOCKED_ISSUE_SETTING = "addresseeWakeOnBlockedIssue";

async function blockedIssueWakeEnabled(db: Pick<Db, "select">, companyId: string): Promise<boolean> {
  const [company] = await db.select({ governance: companies.interactionResolverGovernance }).from(companies)
    .where(eq(companies.id, companyId)).limit(1);
  const setting = (company?.governance as Record<string, unknown> | null | undefined)?.[ADDRESSEE_WAKE_ON_BLOCKED_ISSUE_SETTING];
  return (setting as { enabled?: unknown } | null | undefined)?.enabled === true;
}

/**
 * The gate of unresolved blockers: true for a verified wake of a card on the agent's own task, and only when the
 * company's setting is on. Off (the default), the wake keeps today's gate.
 */
export async function verifyOwnIssueInteractionWake(
  db: Pick<Db, "select">,
  input: Parameters<typeof readOwnIssueInteractionWake>[1],
): Promise<boolean> {
  if ((await readOwnIssueInteractionWake(db, input)) === null) return false;
  return blockedIssueWakeEnabled(db, input.companyId);
}

/**
 * What the run reads, added to the task text the server builds: which card waits, and on which task. Fixed text and
 * identifiers only; empty when the card no longer waits.
 */
export async function ownIssueInteractionNote(
  db: Pick<Db, "select">,
  input: Parameters<typeof readOwnIssueInteractionWake>[1],
): Promise<string> {
  const card = await readOwnIssueInteractionWake(db, input);
  if (!card) return "";
  return `\n\nA question addressed to you is pending on another task: interaction ${card.interactionId} on issue ` +
    `${card.cardIssueIdentifier ?? card.cardIssueId} (issue id ${card.cardIssueId}). You were woken on this task, ` +
    "which is yours, to answer it. Read that interaction on that issue and answer it there.";
}
