// STUDIO-0063: a native status decision that makes a blocker done or cancelled goes through the one "dependencies
// changed" function after commit. Silence it closes: D waits on A and B, an agent's comment on D is held, A is
// cancelled by a native decision, then B is finished: cancelled blockers stay unresolved, so D is never ready and,
// without the hand-back, nobody wakes its assignee.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, companies, completionContracts, createDb, heartbeatRuns, issueComments, issueRelations,
  issues, nativeRunFinalizations, nativeRunResults, workAssessments } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { commitNativeStatusDecision } from "./status-decision-committer.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION, type NativeStatusDecision } from "./status-arbiter.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping native dependency change wake tests: ${support.reason}`);
(support.supported ? describe : describe.skip)("native status decisions and dependents' wakes (STUDIO-0063)", () => {
  let db: ReturnType<typeof createDb>, database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const companyId = randomUUID(), workerId = randomUUID(), devId = randomUUID();
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("native-dependency-wakes-");
    db = createDb(database.connectionString, { maxConnections: 6 });
    await db.insert(companies).values({ id: companyId, name: "Native dependency fixture", issuePrefix: "NDW" });
    await db.insert(agents).values([
      { id: workerId, companyId, name: "Worker", adapterType: "paperclip_runner", status: "running" },
      { id: devId, companyId, name: "Dev", adapterType: "process", status: "idle",
        runtimeConfig: { heartbeat: { wakeOnDemand: true } } },
    ]);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  // A native run on blocker A, ready to commit a decision; dependent D (assigned to the Dev) waits on A and on B.
  async function seed(otherBlockerStatus: "cancelled" | "todo") {
    const blockerA = randomUUID(), blockerB = randomUUID(), dependent = randomUUID();
    const runId = randomUUID(), contractId = randomUUID(), resultId = randomUUID(), assessmentId = randomUUID();
    await db.insert(issues).values([
      { id: blockerA, companyId, title: "Blocker A", status: "in_progress", workMode: "standard", assigneeAgentId: workerId },
      { id: blockerB, companyId, title: "Blocker B", status: otherBlockerStatus },
      { id: dependent, companyId, title: "Dependent D", status: "todo", assigneeAgentId: devId },
    ]);
    await db.insert(issueRelations).values([
      { companyId, issueId: blockerA, relatedIssueId: dependent, type: "blocks" },
      { companyId, issueId: blockerB, relatedIssueId: dependent, type: "blocks" },
    ]);
    const [priorIssue] = await db.select().from(issues).where(eq(issues.id, blockerA));
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId: blockerA, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "dependency-wake-test", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "1", objective: "Finish", criteria: [] }, canonicalSha256: `contract-${contractId}`,
      createdByActorType: "system", createdByActorId: "test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: workerId, status: "running", runtimeMode: "native",
      nativeIssueId: blockerA, completionContractId: contractId, completionContractSha256: `contract-${contractId}`,
      contextSnapshot: { issueId: blockerA } });
    await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId: blockerA, runId, completionContractId: contractId,
      serverFingerprint: `fp-${resultId}`, schemaStatus: "accepted", resultJson: {}, canonicalSha256: `sha-${resultId}` });
    await db.insert(workAssessments).values({ id: assessmentId, companyId, issueId: blockerA, runId, contractId, resultId,
      triggerKind: "native_result", triggerActorCompanyId: companyId, priorIssueStatus: "in_progress",
      priorStatusVersion: priorIssue!.statusVersion, policyVersion: "dependency-wake-test", assessmentJson: {},
      inputDigest: `assessment-${assessmentId}` });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId: blockerA, phase: "arbitrating", resultId });
    return { blockerA, blockerB, dependent, runId, assessmentId, priorStatusVersion: priorIssue!.statusVersion,
      priorDecisionId: priorIssue!.lastStatusDecisionId };
  }

  async function commit(f: Awaited<ReturnType<typeof seed>>, status: "done" | "cancelled") {
    const decision: NativeStatusDecision = { policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, statusAction: status,
      toStatus: status, reasonCode: "dependency_wake_test", unblockDescriptor: null, effects: [] };
    return commitNativeStatusDecision({ db, companyId, issueId: f.blockerA, runId: f.runId, assessmentId: f.assessmentId,
      priorStatus: "in_progress", priorStatusVersion: f.priorStatusVersion, priorDecisionId: f.priorDecisionId, decision });
  }

  const devWakes = (dependent: string) => db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, devId)))
    .then(rows => rows.filter(row => (row.payload as Record<string, unknown> | null)?.issueId === dependent));

  it.each(["done", "cancelled"] as const)("hands D back when a native %s decision leaves it waiting only on cancelled blockers", async status => {
    const f = await seed("cancelled");
    await commit(f, status);
    expect((await db.select().from(issues).where(eq(issues.id, f.blockerA)))[0]?.status).toBe(status);
    await vi.waitFor(async () => {
      expect((await devWakes(f.dependent)).some(wake =>
        typeof (wake.payload as Record<string, unknown>).cancelledBlockerIssueId === "string")).toBe(true);
    }, { timeout: 20_000 });
    const notes = await db.select().from(issueComments).where(eq(issueComments.issueId, f.dependent));
    expect(notes.some(note => note.body.includes("every blocker this task still waits on is cancelled"))).toBe(true);
  });

  it("does not hand D back while one of its blockers is still open", async () => {
    const f = await seed("todo");
    await commit(f, "cancelled");
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(await devWakes(f.dependent)).toEqual([]);
  });

  it("wakes D once when a native done decision makes it ready", async () => {
    const f = await seed("todo");
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, f.blockerB));
    await commit(f, "done");
    await vi.waitFor(async () => {
      expect((await devWakes(f.dependent)).filter(wake => wake.reason === "issue_blockers_resolved")).toHaveLength(1);
    }, { timeout: 20_000 });
    await new Promise(resolve => setTimeout(resolve, 500));
    expect((await devWakes(f.dependent)).filter(wake => wake.reason === "issue_blockers_resolved")).toHaveLength(1);
  });
});
