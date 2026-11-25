import type { NextFunction, Request, Response } from "express";
import type { ProjectCommenterAgentKeyScope } from "@paperclipai/shared";

/**
 * STUDIO-0102: the routes a `project_commenter` key may call, and nothing else. Mounted right after the actor is
 * resolved and before every route: any other request of such a key is refused here, before it runs. The routes
 * below still make their own checks (the authorization service admits only `issue:read` and `issue:comment` on a
 * ticket of the key's projects), so a ticket outside the scope is refused there.
 *
 * Allowed, exactly:
 * - GET  /api/companies/:companyId/issues        the key's company; `projectId` one of the key's projects; only `q`,
 *                                                 `projectId`, `limit`
 * - GET  /api/issues/:id                          `id` a UUID; no query (the route answers a reduced view)
 * - GET  /api/issues/:id/comments                 only `order`, `limit`, `afterCommentId`
 * - POST /api/issues/:id/comments                 a body of `body` and `reopen: false` (or absent) only
 * The answers of the three reads are reduced to what finding the ticket needs (routes/issues.ts), and its search
 * leaves documents out. No request of such a key may carry `X-Paperclip-Run-Id`: it has no run.
 */
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const LIST = new RegExp(`^/api/companies/(${UUID})/issues/?$`);
const DETAIL = new RegExp(`^/api/issues/${UUID}/?$`);
const COMMENTS = new RegExp(`^/api/issues/${UUID}/comments/?$`);
const LIST_QUERY = new Set(["q", "projectId", "limit"]);
const COMMENTS_QUERY = new Set(["order", "limit", "afterCommentId"]);
const COMMENT_BODY = new Set(["body", "reopen"]);
export const PROJECT_COMMENTER_ROUTE_DENIED = "project_commenter_route_denied";
const RUN_ID_HEADER = "x-paperclip-run-id";

export function projectCommenterScopeOf(req: Request): ProjectCommenterAgentKeyScope | null {
  const scope = req.actor?.type === "agent" ? req.actor.keyScope : undefined;
  return scope?.kind === "project_commenter" ? scope : null;
}

/** Null when the request is one of the four; otherwise why it is refused. */
export function projectCommenterRouteRefusal(req: Pick<Request, "method" | "path" | "query" | "body" | "headers">,
  scope: ProjectCommenterAgentKeyScope, companyId: string | null | undefined): string | null {
  const keys = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
  const only = (value: unknown, allowed: Set<string>) => keys(value).every(key => allowed.has(key));
  const single = (value: unknown) => typeof value === "string" ? value : null;
  // Such a key has no run: a run id it would send could tie its comment to another agent's run (and lose that
  // run's wake). Refused on every route; the authentication does not take it either.
  if (req.headers?.[RUN_ID_HEADER] !== undefined) return "run_header_not_allowed";
  if (req.method === "GET") {
    const list = LIST.exec(req.path);
    if (list) {
      if (!companyId || list[1]!.toLowerCase() !== companyId.toLowerCase()) return "another_company";
      if (!only(req.query, LIST_QUERY)) return "list_parameter_not_allowed";
      const projectId = single(req.query.projectId);
      if (!projectId || !scope.projectIds.some(id => id.toLowerCase() === projectId.toLowerCase())) return "list_outside_projects";
      return null;
    }
    if (DETAIL.test(req.path)) return keys(req.query).length === 0 ? null : "detail_parameter_not_allowed";
    if (COMMENTS.test(req.path)) return only(req.query, COMMENTS_QUERY) ? null : "comments_parameter_not_allowed";
    return "route_not_allowed";
  }
  if (req.method === "POST" && COMMENTS.test(req.path)) {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.body !== "string") return "comment_body_required";
    if (!only(body, COMMENT_BODY)) return "comment_field_not_allowed";
    if (body.reopen !== undefined && body.reopen !== false) return "comment_reopen_not_allowed";
    return null;
  }
  return "route_not_allowed";
}

export function projectCommenterRouteGuard(req: Request, res: Response, next: NextFunction) {
  const scope = projectCommenterScopeOf(req);
  if (!scope) return next();
  const refusal = projectCommenterRouteRefusal(req, scope, req.actor?.type === "agent" ? req.actor.companyId : null);
  if (refusal === null) return next();
  res.status(403).json({
    error: "This key may only find, read and comment on the tickets of its projects.",
    code: PROJECT_COMMENTER_ROUTE_DENIED,
    reason: refusal,
  });
}
