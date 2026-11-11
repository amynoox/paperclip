import { Router } from "express";
import { eq } from "drizzle-orm";
import { companies, type Db } from "@paperclipai/db";
import { projectToolContext } from "../services/project-tool-context.js";
import { callProjectTool, projectToolDefinitions } from "../services/project-tools.js";
import { assertCompanyAccess } from "./authz.js";
import { forbidden } from "../errors.js";
import { isRunTaskWriteTool } from "../services/run-task-tools.js";

/** Mounted after actor middleware; connection-scoped tokens cannot authenticate here. */
export function projectToolRoutes(db: Db) {
  const router = Router();
  router.post("/mcp/project-tools", async (req, res) => {
    const context = await projectToolContext(db, req.actor);
    assertCompanyAccess(req, context.run.companyId);
    const { id = null, method, params } = req.body;
    const send = (result: unknown) => res.json({ jsonrpc: "2.0", id, result });
    if (method === "initialize") return send({ protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "paperclip-project-tools", version: "1" } });
    if (method === "notifications/initialized") return res.status(202).end();
    const definitions = projectToolDefinitions(context.issue.workMode, true);
    if (method === "tools/list") return send({ tools: definitions });
    if (method !== "tools/call") return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    const abort = new AbortController();
    const disconnect = () => { if (!res.writableEnded) abort.abort(); };
    req.once("aborted", disconnect);
    res.once("close", disconnect);
    // The client can disappear while the initial run context is being resolved.
    if (req.aborted || res.destroyed) abort.abort();
    try {
      if (!definitions.some(tool => tool.name === params?.name)) throw forbidden("Tool is unavailable in this mode");
      const callContext = isRunTaskWriteTool(params.name)
        ? await projectToolContext(db, req.actor, true, "Task interaction") : context;
      const apiUrl = process.env.PAPERCLIP_API_URL;
      if (!apiUrl) throw new Error("Paperclip API origin is unavailable");
      const result = await callProjectTool({
        name: params.name, arguments: params.arguments ?? {}, apiUrl,
        token: req.header("authorization")!.replace(/^Bearer\s+/i, ""),
        companyId: callContext.run.companyId, issueId: callContext.issue.id, agentId: callContext.run.agentId,
        conversation: Boolean(callContext.issue.conversationAgentId), workMode: callContext.issue.workMode, signal: abort.signal,
        companyPrefix: params.name === "list_projects" ? (await db.select({ issuePrefix: companies.issuePrefix }).from(companies)
          .where(eq(companies.id, context.run.companyId)))[0]?.issuePrefix : null,
      });
      return send({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
    } catch (error) {
      return send({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Project tool failed" }] });
    } finally {
      req.off("aborted", disconnect);
      res.off("close", disconnect);
    }
  });
  return router;
}
