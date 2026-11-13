import { describe, expect, it, vi } from "vitest";

// An npm install can resolve "zod" for the server to a different copy than the
// one @paperclipai/shared uses. That copy's toJSONSchema() cannot convert a
// record field built by the other copy: it throws
// "Cannot read properties of undefined (reading 'push')". This mock gives the
// server's "zod" import that behaviour, so tools/list must not depend on it.
vi.mock("zod", async (importOriginal) => {
  const actual = await importOriginal<typeof import("zod")>();
  const otherCopyToJSONSchema = ((schema: Parameters<typeof actual.toJSONSchema>[0], params?: Parameters<typeof actual.toJSONSchema>[1]) =>
    actual.toJSONSchema(schema, {
      ...params,
      override: (ctx) => {
        if (ctx.zodSchema._zod.def.type === "record") throw new TypeError("Cannot read properties of undefined (reading 'push')");
        params?.override?.(ctx);
      },
    })) as typeof actual.toJSONSchema;
  return { ...actual, toJSONSchema: otherCopyToJSONSchema, z: { ...actual.z, toJSONSchema: otherCopyToJSONSchema } };
});

const { projectToolDefinitions } = await import("../services/project-tools.js");

describe("project tool definitions with a second zod copy", () => {
  it("lists the standard-mode tools, including create_project with its record fields", () => {
    const tools = projectToolDefinitions("standard", true);
    const createProject = tools.find(tool => tool.name === "create_project");
    expect(createProject?.inputSchema).toMatchObject({ type: "object", properties: { env: expect.any(Object) } });
    expect((createProject?.inputSchema as { required?: string[] }).required).toContain("idempotencyKey");
    expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining(["create_project", "list_projects", "get_task"]));
  });
});
