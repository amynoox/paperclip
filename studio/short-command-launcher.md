# Short-command launcher

## What it is

One small helper process, started by the server at boot. It starts the short commands of the server
(`ssh`, `git`, `ps`, `ssh-keygen`) and returns their result. The server no longer starts them itself.

- Module: `packages/adapter-utils/src/short-command-launcher.ts`.
- Callers: `execFileText` and `spawnText` used by `packages/adapter-utils/src/ssh.ts` (every short
  `ssh` command, with or without stdin), and `runGit` in `server/src/services/execution-workspaces.ts`.
- Start: `server/src/index.ts`, when the listener is bound.
- Not covered: long-lived children (the agent's own `ssh`, `tar` pipes, workspace sync streams). The
  server starts them as before. There are few of them.

## Why

On Linux, Node starts a child with `fork`. The kernel copies the page tables of the calling process
on each `fork`, on the calling thread. The event loop is stopped for that time.

Production, 13 Nov 2026, `2026.1110.0-studio.12`, about 5 remote runs (read from `/proc`):

- server process: 1.6 GiB resident, 31 MB of page tables;
- 10 process starts per second: 3.0 to 3.8 `ssh` (the callback bridge: one per idle wait, four per
  agent request) and bursts of `git rev-parse`;
- main thread at 44 to 55 % of one core, of which 18 to 25 points are kernel time;
- up to 24 ms of kernel time on the main thread per process start.

The cost grows with the memory of the server, thus with its uptime. On the morning of 13 Nov, at
2.3 GiB and 15 `ssh` per second, the server saturated with about 10 remote runs.

A `fork` from the helper copies the page tables of the helper only.

## Switch

`PAPERCLIP_SHORT_COMMAND_LAUNCHER`:

| Value | Effect |
|---|---|
| not set | On for Linux. Off for other platforms: they do not pay this cost. |
| `off` | The server starts no helper. Every command starts from the server process, as before this change. |
| `on` | On for every platform. |

The server logs one line at boot: `short-command launcher started` with the helper pid, or
`short-command launcher is off`.

## Failure behavior

- The helper is not ready, or is down: the command starts directly from the server.
- The helper exits: the server logs a warning and starts the helper again after 1 s. The delay doubles
  at each early exit, up to 30 s. It returns to 1 s after the helper stayed up 60 s.
- A command was in flight when the helper exited: it fails with `launcherLost: true`, exit code `null`.
  The server does not start it again by itself. It cannot know if the remote command ran, and a second
  run of a command that is not idempotent would be new behavior. The callers already handle a failed
  `ssh` command.
- A request the helper never received (the send failed): the command starts directly.
- The helper does not answer 10 s after the timeout of a command: the server kills the helper. The
  rules above then apply.
- The server exits: the helper sees its channel close and exits. Commands in flight continue without
  a parent, as they do today when the server exits.

Timeouts, the SIGTERM then SIGKILL escalation, stdin, output limits, error class, error message and
error properties are the same with and without the helper. The helper runs the same two functions
as the direct path: it receives their source text.

Environment and working directory: a command sees the environment and working directory the server
has at the time of the call, also when they changed after the helper started.

## Local measure

`studio/short-command-launcher-bench.mjs`, WSL 2 Ubuntu 24.04, Node 24.22.2, 300 starts of `/bin/echo`
per case, process memory grown to the stated size. Time the event loop is blocked per start, median:

| Resident memory | Direct start | Launcher asked, switch `off` | Through the launcher |
|---|---|---|---|
| 159 MB | 2.38 ms | 2.35 ms | 0.05 ms |
| 734 MB | 13.46 ms | 13.00 ms | 0.06 ms |
| 1 343 MB | 23.68 ms | 24.80 ms | 0.05 ms |
| 1 630 MB | 29.64 ms | 30.50 ms | 0.05 ms |
| 2 334 MB | 42.14 ms | 44.09 ms | 0.06 ms |

The switch column is the negative control: with the switch off, the cost is the cost of today.

Time from the start to the result, at 1 630 MB, median: 30.11 ms direct, 1.25 ms through the launcher.
Kernel time of the process per start, at 1 630 MB: 9.51 ms direct, 0.02 ms through the launcher.

Rehearsal of the production measure: a process of 1.6 GiB that starts 10 short commands per second,
read by the production script (`2-lancements-et-noyau.py`, below) for 30 s:

| | New children of the process | New children of the helper | Main thread, kernel time |
|---|---|---|---|
| Switch `off` | 10.0 per second | none | 10.4 % of one core |
| Launcher on | 0 | 10.0 per second | 0.2 % of one core |

The test machine is not the server. Its page tables are smaller for the same memory (transparent
huge pages: 4 MB of page tables at 1.6 GiB, against 31 MB on the server), so the absolute values
differ. The ratio is the point.

## Measure to repeat in production

Before and after the switch to the version that carries this change, at a similar load, read-only
(`/proc` only), from the studio working repository:

```
ssh -F tools/ssh/workers.config paperclip-vps 'python3 -' < drafts/paperclip-multi-coeurs/mesures/2-lancements-et-noyau.py
```

Compare, for a similar count of new children per second:

- `main thread CPU % of one core: ... sys` (13 Nov: 18.1 and 24.5);
- `main thread sys time ... ms of kernel time per child` (13 Nov: 24.1).

With the launcher, the script names the helper (`short-command launcher helper: <pid>`) and counts
its new children apart. After the switch, the new direct children of the server must fall to near
zero, the new children of the helper must take their place, and the kernel time of the main thread
must fall. Reference without any process start, 13 Nov 22:18 UTC, same memory: `sys` 4.5.

## What a local test cannot show

- The real load of the server: bridge requests, open browser pages and plugins together.
- The effect on the count of simultaneous runs. The main thread has a base load that does not depend
  on the run count.
- The helper under the real service unit (same control group, stopped with the service).
