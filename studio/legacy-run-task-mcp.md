# STUDIO-0004 — Native task tools for legacy run MCP

A legacy `codex_local` CLI run receives managed project and connection MCP
servers, but the project server does not expose task documents or question
responses. Its sandbox can correctly reject direct private-network API calls.
The agent can then finish a conversation without reading the requested evidence
or answering an interaction addressed to it. Changing Git identity, execution
profile or network rules does not repair this missing tool catalogue.

## Upstream review and authorization

The completed 2026-11-11 search covered all PR states in
`paperclipai/paperclip`, including paginated results for legacy Codex MCP, task
tools, documents, interactions, and the affected transport files. Search terms
included `codex_local MCP`, `run-task-tools`, `project-tools`,
`respond interaction MCP`, `task documents MCP`, and `paperclipRespond`.
Search results and reviewed diffs are retained in private operational evidence.
This is a dated search result, not a claim about future PRs.

The closest result was [PR #16420](https://github.com/paperclipai/paperclip/pull/16420),
head `517636bba8eb462e028a718e50e81fd5d7d9c814`. Its useful architecture is a
run-authenticated native API transport on the existing project MCP endpoint.
Its proposed catalogue does not include documents or interaction responses and
also adds unrelated task/comment writes. We use that architecture as inspiration;
this is not a cherry-pick and does not claim that the upstream PR was integrated.

Other reviewed partial matches:

| PR | Reviewed head | Why it does not supply this fix |
| --- | --- | --- |
| [#9810](https://github.com/paperclipai/paperclip/pull/9810) | `572f55e82ee1389c57cac87d524af41f6b02d53b` | Lists interactions in a standalone MCP server. |
| [#9850](https://github.com/paperclipai/paperclip/pull/9850) | `41345da5804d2499bd45d946ff4865508d3b6412` | Reads an interaction; no run-bound response delivery. |
| [#16323](https://github.com/paperclipai/paperclip/pull/16323) | `76111194adbf249bf9256eb9b5b245eaa807f7d6` | ACP engine path excludes the remote CLI path. |
| [#10470](https://github.com/paperclipai/paperclip/pull/10470) | `bf364dc1aa13a26c631e3de55bb5f4cf956e1a19` | Different agent adapter. |
| [#9393](https://github.com/paperclipai/paperclip/pull/9393) | `013370f6fc60015689ada0ce1779f463b9c70ea4` | Generic remote API forwarding is broader than this scope. |
| [#15380](https://github.com/paperclipai/paperclip/pull/15380) | `64f96373118eb190f8cba1c2ab17cb979555f3ad` | External human OAuth must not replace a run's agent identity. |
| [#20263](https://github.com/paperclipai/paperclip/pull/20263) | `f390f3dceca487bc515221b2ec4eba18d1f313ee` | Tool approval delivery, not the missing operations. |
| [#18562](https://github.com/paperclipai/paperclip/pull/18562) | `475853ea2c09578837c464defa6cee3d13a7ff4f` | Public MCP origin is already correctly supplied in the affected path. |
| [#16772](https://github.com/paperclipai/paperclip/pull/16772) | `9f81a238da6703eb736b16646e6a3ab028a07390` | Documents denied sandbox routes; does not add this catalogue. |

The owner explicitly approved this bounded custom implementation, local tests
and deployment on 2026-11-11 after receiving the partial-match verdict.

## Contract

The existing `/api/mcp/project-tools` endpoint now lists `get_task`,
`list_task_documents`, `read_task_document`, `list_task_interactions`, and
`respond_to_task_interaction`. Each operation has a fixed native REST route.
There is no arbitrary URL or caller-supplied identity. Omitted `taskId` means
the authenticated run's task. Related tasks still pass native access checks.

The existing `projectToolContext` verifies the run JWT, run identity and current
conversation generation. Responses recheck the current write mode. Ask and
Planning expose reads only. The same JWT reaches the normal native endpoint,
which retains company/privacy checks, run attribution, containment, resolver
audience, cross-task influence limits, atomic resolution, activity records and
native response delivery. A responsible human in the run context never becomes
the answer's actor. Human-only, governed or incorrectly addressed questions stay
denied. No permission, connection, adapter or network setting changes.

Calls have a 60-second timeout and are cancelled on MCP disconnect. No mutation
is retried automatically. Cancellation after a native response commit cannot
undo that commit; callers must reread the interaction before deciding whether to
submit again. Native continuation effects of a successful answer are preserved.
The deployment itself must not answer, wake or test a task.

## Local verification and limits

Run `npm ci --ignore-scripts --workspaces=false` and `npm test` in
`studio/task-mcp-tests`. The 34 focused local cases use real loopback HTTP,
Express, shared validators, the project context guards and native audience
decision. They exercise cancellation, deadlines, malformed addressing, identity
injection, redirects, mode/run/generation denial, response refusal and no retry.
Database IO and identity capture are fixture boundaries. Native database
transactions, authorization middleware and downstream continuation persistence
are not established by this isolated suite.

The existing PostgreSQL-backed `chat-project-tools.test.ts` gains a native
integration regression for documents, cross-company denial and Ask mode. It is
not run in the sparse checkout. No full workspace build, real agent run, worker
test or GitHub Actions run is claimed.

`build-task-mcp-overlay.mjs` requires committed source and exact installed
nightly module hashes. It compares normalized compiled baseline source with
those modules, then emits two replacements and one new module. The same focused
suite can be run with `STUDIO_MCP_OVERLAY` pointing at that output directory.
Preserve STUDIO-0001 and STUDIO-0003. No database migration is involved.
Deployment, authenticated readback and real qualification are separate evidence.

Rollback restores the retained payload while drained and verifies the previous
version and module hashes. It must not restore an older database or erase an
answer already committed by a later real run. Retire this patch when an upstream
legacy run MCP catalogue supplies these operations with equivalent native
authority and passes the same negative regressions.
