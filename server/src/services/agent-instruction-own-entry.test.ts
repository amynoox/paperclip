import { describe, expect, it } from "vitest";
import { assertNotOwnEntryEdit } from "./agent-instruction-authorization.js";

// STUDIO-0055: an agent never rewrites its own entry file; peers and the Board are governed elsewhere.
describe("assertNotOwnEntryEdit", () => {
  const agent = (agentId: string) => ({ type: "agent", agentId, companyId: "c", runId: "r" }) as never;
  it("refuses the agent itself", () => {
    expect(() => assertNotOwnEntryEdit(agent("a1"), "a1")).toThrow(expect.objectContaining({
      status: 403, details: expect.objectContaining({ code: "AGENT_ENTRY_SELF_EDIT_REFUSED" }) }));
  });
  it("leaves other agents and the Board to the existing rules", () => {
    expect(() => assertNotOwnEntryEdit(agent("a2"), "a1")).not.toThrow();
    expect(() => assertNotOwnEntryEdit({ type: "board", userId: "u", source: "session" } as never, "a1")).not.toThrow();
  });
});
