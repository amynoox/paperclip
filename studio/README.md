# Studio downstream maintenance

This fork is independently maintained. Changes can be developed, reviewed and
deployed here without acceptance by `paperclipai/paperclip`. Keep the upstream
MIT license and copyright notices. An upstream contribution is optional.

The initial source baseline is the published nightly recorded in
[`upstream.json`](upstream.json), not whatever `master` points to later. Creating
this branch does not prove deployment or application qualification. Deployment
receipts, backups, machine details and credentials stay in private operations
storage, outside this public fork.

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

`STUDIO-0001` records the long-run MCP token issue and its proposed native owner.
It must be reassessed against the newly installed nightly before implementation;
the previous-version diagnosis must not be treated as a finding on newer code.
No downstream Paperclip runtime correction is included in this bootstrap.

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
