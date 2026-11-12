# Studio downstream maintenance

This fork is independently maintained. Changes can be developed, reviewed and
deployed here without acceptance by `paperclipai/paperclip`. Keep the upstream
MIT license and copyright notices. An upstream contribution is optional.

The initial source baseline is the published nightly recorded in
[`upstream.json`](upstream.json), not whatever `master` points to later. Creating
this branch does not prove deployment or application qualification. Deployment
receipts, backups, machine details and credentials stay in private operations
storage, outside this public fork.

## Search upstream before changing behavior

The owner authorizes maintenance of this fork independently of upstream review.
Before each Paperclip behavior change, first isolate the problem and check the
current pull requests in `paperclipai/paperclip`. Search open and draft PRs as
well as merged and closed PRs, using the symptoms, errors, affected contracts and
owning files. Read promising diffs, discussions, tests and dependencies; a matching
title alone does not establish a solution. Check whether a merged fix is already
part of our pinned baseline.

Prefer integrating a suitable existing PR into the fork instead of rewriting
the same fix. Upstream acceptance is not required. Pin the reviewed commit,
preserve authorship and provenance (for example, `git cherry-pick -x`), review
conflicts and compatibility, and run the relevant local checks. Reuse does not
authorize unrelated changes, permission expansion, automatic merges or a
deployment outside the currently authorized scope.

Only begin a new custom implementation after the problem is isolated, a current
documented search finds no suitable upstream PR, and the user explicitly approves
the specific proposed correction. Report partial matches and why they do not
solve the problem. If the search is unavailable or incomplete, state that gap;
do not claim that no PR exists or start custom implementation on that basis.
Refresh the search when resuming a stale investigation before implementation.

For each future patch, record the search date, repository, queries, candidate PR
URLs and disposition in `patches.json` or its linked design note. For reused work,
record the source PR, exact commits and any adaptations. For custom work, record
the isolated cause, absence of a suitable result at that time, and the explicit
user approval and its scope. Do not invent retrospective search or approval
evidence for existing patches. This policy was adopted on 2026-11-10.

## Record every downstream behavior change

Use one reviewable commit or commit group per independent correction. Add its
stable ID to [`patches.json`](patches.json) and use a `Studio-Patch: STUDIO-0001`
commit trailer. Record the triggering behavior, why native configuration or an
adapter is insufficient, affected contracts, tests and limitations, migration
and rollback requirements, and the conditions under which the patch can be
removed. Keep secrets, production dumps, logs and instance-specific values out
of source and examples.

Start from the existing record template. A `proposed` record is not deployed
code. Change its status only with corresponding implementation and evidence.
Commit IDs can be recorded by a following documentation commit to avoid a
self-referential hash. Retired entries remain as history with their reason.

Repository engineering instructions still apply. For development and validation,
prefer existing local/LAN capacity. GitHub Actions is disabled on this fork and
requires explicit user authorization before enabling or triggering it. A passing
local check is not evidence of a complete worker/application journey.

## Upgrading without losing the reasons for our patches

1. Resolve the published upstream version to its immutable tag/commit and package
   integrity. Fetch it from `upstream`; never move an already recorded baseline.
2. Save the live database, persistent files, plugin/adapter configuration and
   dependencies, plus the previous payload and deployment receipt. Verify the
   backup before changing the running installation. Record schema compatibility
   and recovery obligations; a Git or executable rollback alone may not undo a
   database migration.
3. Run `node studio/compare-upstream.mjs <new-tag-or-commit>` locally. It reports
   upstream changes intersecting each patch's owning paths and our commits since
   the old baseline. It does not declare a patch obsolete or perform any update.
4. Create a new `studio/<upstream-version>` branch from that upstream commit.
   For every record, decide **keep**, **adapt**, **drop because upstream fixes it**,
   or **blocked**, with a reason. Carry kept commits with `git cherry-pick -x`;
   preserve original provenance. Resolve conflicts deliberately, not by accepting
   both sides automatically.
5. Compare the two patch series with
   `git range-diff <old-base>..<old-studio-head> <new-base>..<new-studio-head>`.
   Review changed authorization, lifecycle, persistence and public contracts even
   if cherry-pick reports no textual conflict. Re-run the relevant local tests.
6. Update `upstream.json`, every patch decision and the deployment notes. Use an
   immutable downstream release tag for each published build. After native
   service/plugin readback, delegate any real qualification to the authorized
   testing owner; retain its remaining limits separately.

`master` retains upstream history. Custom work belongs on the `studio/*` branches.
Do not force-push or rewrite a deployed branch. Keep an upgrade report and both
old and new release tags so any future operator can reconstruct the comparison.

## Initial backlog

`STUDIO-0007` preserves routed input while required task interactions remain
pending. See [adapter-interaction-admission.md](adapter-interaction-admission.md)
for the read-only companion contract, durable queue ownership, upstream search,
local validation limits and coordinated rollback requirements. It is local only.

`STUDIO-0004` adds bounded native task/document reads and question responses to
the existing legacy run MCP. See [legacy-run-task-mcp.md](legacy-run-task-mcp.md)
for upstream provenance, unchanged authority, tests and rollback limits.

`STUDIO-0003` reuses upstream event-settlement and global-job invocation fixes
with an explicitly approved notification-only guard. See
[plugin-invocation-scopes.md](plugin-invocation-scopes.md) for source provenance,
the security regression, the isolated local suite and the two-module overlay.
It does not change permissions or provide end-to-end worker qualification.

`STUDIO-0001` implements a four-day default for new run MCP credentials after
review of the installed nightly's issuing and public API contracts. See
[runtime-mcp-lifetime.md](runtime-mcp-lifetime.md) for authority, test scope,
artifact provenance, existing-token behavior and rollback limits. Implementation
and deployment receipts remain separate claims.

`STUDIO-0002` records a native update health-contract mismatch: an unauthenticated
probe can receive healthy liveness without the protected version fields, while
the updater requires an exact version and incorrectly rolls back. Keep protected
health details private. A maintenance procedure can stop an idle service, update
the inactive managed installation after a verified fresh backup, start it, and
verify the exact version and commit through an authenticated health read. This
operational procedure is not a source fix or worker qualification.

Use a restrictive installation umask such as `022`: the pinned Copilot installer
rejects group/world-writable executable files. Do not disable its permission,
digest or closure checks to make an installation pass.
