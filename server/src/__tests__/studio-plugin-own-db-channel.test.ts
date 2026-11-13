import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  createHostClientHandlers,
  PLUGIN_RPC_ERROR_CODES,
  type HostServices,
  type HostToWorkerMethods,
} from "@paperclipai/plugin-sdk";

vi.mock("../middleware/logger.js", () => {
  const mockLogger: Record<string, unknown> = {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
    child: vi.fn(() => mockLogger),
  };
  return { logger: mockLogger, httpLogger: vi.fn() };
});

import { createPluginWorkerHandle } from "../services/plugin-worker-manager.js";

const ENTRYPOINT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "plugin-worker-invocation-scope.cjs");
const MANIFEST: PaperclipPluginManifestV1 = {
  id: "test.plugin", apiVersion: 1, version: "1.0.0", displayName: "Test plugin", description: "Test plugin",
  author: "Paperclip", categories: ["automation"], capabilities: [], entrypoints: { worker: "dist/worker.js" },
};

// STUDIO-0017: an id-less worker call to the plugin's own database is admitted
// while a non-agent invocation is active. Every other id-less call keeps the
// native refusal, and so does any call while an agent-origin invocation runs.
describe("STUDIO-0017: the plugin's own database channel", () => {
  function setup() {
    const query = vi.fn(async () => [{ ok: 1 }]);
    const execute = vi.fn(async () => ({ rowCount: 1 }));
    const companiesGet = vi.fn(async () => ({ id: "company-1" }));
    const stateGet = vi.fn(async () => null);
    const hostHandlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: ["database.namespace.read", "database.namespace.write", "companies.read", "plugin.state.read"],
      services: { db: { query, execute, namespace: vi.fn() }, companies: { get: companiesGet }, state: { get: stateGet } } as unknown as HostServices,
    });
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: ENTRYPOINT, manifest: MANIFEST, config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" }, apiVersion: 1,
      proactiveCompanyScopes: ["company-1"], hostHandlers,
    });
    return { handle, query, execute, companiesGet, stateGet };
  }
  const getData = (params: Record<string, unknown>) =>
    ({ key: "probe", companyId: "company-1", params } as HostToWorkerMethods["getData"][0]);
  const agentTool = (parameters: Record<string, unknown>) =>
    ({ toolName: "probe", parameters, runContext: { companyId: "company-1", agentId: "agent-1", runId: "run-1" } } as HostToWorkerMethods["executeTool"][0]);

  it("admits id-less db.query and db.execute while a non-agent invocation is active", async () => {
    const { handle, query, execute } = setup();
    try {
      await handle.start();
      await expect(handle.call("getData", getData({ mode: "omit", hostMethod: "db.query", sql: "select 1" }))).resolves.toEqual([{ ok: 1 }]);
      await expect(handle.call("getData", getData({ mode: "omit", hostMethod: "db.execute", sql: "update t set a = 1" }))).resolves.toEqual({ rowCount: 1 });
      expect(query).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally { await handle.stop().catch(() => undefined); }
  });

  it("still refuses an id-less db.query while an agent-origin invocation is active", async () => {
    const { handle, query } = setup();
    try {
      await handle.start();
      await expect(handle.call("executeTool", agentTool({ mode: "missing", hostMethod: "db.query" })))
        .rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED });
      expect(query).not.toHaveBeenCalled();
    } finally { await handle.stop().catch(() => undefined); }
  });

  it("still refuses a db.query that echoes a forged invocation id", async () => {
    const { handle, query } = setup();
    try {
      await handle.start();
      await expect(handle.call("getData", getData({ mode: "unknown", hostMethod: "db.query" })))
        .rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED });
      expect(query).not.toHaveBeenCalled();
    } finally { await handle.stop().catch(() => undefined); }
  });

  it("keeps the ordinary rule for a db.query that names an unconfigured company", async () => {
    const { handle, query } = setup();
    try {
      await handle.start();
      await expect(handle.call("getData", getData({ mode: "omit", hostMethod: "db.query", nestedCompanyId: "company-2" })))
        .rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED });
      expect(query).not.toHaveBeenCalled();
    } finally { await handle.stop().catch(() => undefined); }
  });

  it("still refuses other id-less calls while an invocation is active", async () => {
    const { handle, companiesGet, stateGet } = setup();
    try {
      await handle.start();
      await expect(handle.call("getData", getData({ mode: "omit", hostMethod: "companies.get", requestedCompanyId: "company-2" })))
        .rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED });
      await expect(handle.call("getData", getData({ mode: "omit", hostMethod: "state.get", nestedScopeKind: "instance" })))
        .rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED });
      expect(companiesGet).not.toHaveBeenCalled();
      expect(stateGet).not.toHaveBeenCalled();
    } finally { await handle.stop().catch(() => undefined); }
  });
});
