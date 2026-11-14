# Shared SSH connection for short commands

## What it is

With the switch on, the short SSH commands of the server to one host share one authenticated
connection. The first short command starts a background `ssh` process that keeps the connection
(OpenSSH `ControlMaster`). The next commands open a session on it: no new TCP connection, no key
exchange, no authentication.

- Code: `createSshAuthArgs` and `runSshCommand` in `packages/adapter-utils/src/ssh.ts`.
- Covered: every `runSshCommand` call. This includes the callback bridge (the idle wait, and the four
  commands per agent request: size, read, write the response, remove), the remote checks, and the
  `runSshCommand` calls of external adapters that import `@paperclipai/adapter-utils/ssh`.
- Not covered, by design: the long-lived agent session (`buildSshSpawnTarget`) and the `tar` streams
  of the workspace sync. Each keeps its own connection, so the agent session never depends on the
  shared one, and a large transfer does not delay short commands.

Origin: upstream pull request
[paperclipai/paperclip#6970](https://github.com/paperclipai/paperclip/pull/6970) (closed for
inactivity on 6 Nov 2026, not merged; head `d3e9dd55d2`). Taken from it: `ControlMaster=auto`,
`ControlPath` with `%C`, `ControlPersist`, and the rule that the Windows client never uses it.
Changed here:

| Upstream #6970 | Here | Reason |
|---|---|---|
| Always on, except on a Windows client | Off unless the switch is `on` | Not yet tried against the real machines of the studio |
| All SSH calls | Short commands only | The agent session and the transfers stay independent |
| Socket in the shared temporary directory | Socket in a private directory (mode 0700) made by the process | OpenSSH advises against a control socket where other users can write |
| One socket per host, port and user | One socket per host, port, user and identity | Two keys for one account never share a connection |
| No keepalive | `ServerAliveInterval=5`, `ServerAliveCountMax=3` | A dead connection is detected in about 15 s |
| `ControlPersist=60s` | `ControlPersist=60` | Same value |
| A queue that spaces the connections of a Windows client | Not taken | The server is Linux; the queue changes the timing of every command on Windows |

## Why

Production, 13 Nov 2026, `2026.1110.0-studio.12`, read from `/proc` over 30 s with about 5 remote
runs: 113 `ssh` processes started by the server, median lifetime 0.35 s. One agent request to the
API costs four of them in sequence: about 1.05 s before the agent has its answer, 1.4 s in all, on
top of the API call itself. Most of that time is connection setup.

## Switch

`PAPERCLIP_SSH_CONNECTION_SHARING`, read at each command:

| Value | Effect |
|---|---|
| not set, or any value other than the ones below | One connection per command, as before this change. The `ssh` arguments are the same as before. |
| `on` (also `1`, `true`) | Short commands share one connection per host and identity. |
| any value, on a Windows host | Always off: the OpenSSH client for Windows cannot create the control socket. |

To turn it on: set the variable in the environment of the service and restart the service. To turn
it off: remove it and restart.

## Failure behavior (OpenSSH client, seen in the local tests unless stated)

- No shared connection yet and several commands start together: one creates it, the others open
  their own connection. All succeed.
- The background process is killed, or its socket is stale: the next command creates a new shared
  connection. No error.
- The server stops answering without closing the connection: commands to that host wait until their
  own timeout, as they do today when a host is unreachable. The background process exits after
  about 15 s without answer; the next command then opens a new connection. Seen locally: 18 s to
  recover with a frozen server.
- The remote server refuses one more session on the connection (`MaxSessions`, 10 by default): by
  the design of the OpenSSH client, that command opens its own connection. Not reproduced locally
  (the test server did not enforce the limit).
- A command times out: the server kills the local `ssh` of that command, as before. The shared
  connection stays.
- The shared connection ends when no command used it for 60 s, and when the service stops.

Timeouts, stdin, output limits, exit codes and error properties of `runSshCommand` do not change:
the same tests pass with the switch off and on.

## Local measure

WSL 2 Ubuntu 24.04, Node 24.22.2, OpenSSH 9.6p1 client and server on the loopback address,
`studio/ssh-connection-sharing-bench.mjs`, 40 commands and 20 bridge requests per mode, two runs
(values of the second run in brackets). Median:

| | Switch off | Switch on |
|---|---|---|
| One short command (`true`) | 176.7 ms (175.7) | 14.2 ms (14.3) |
| TCP connections for 40 commands | 40 | 0 new (the one opened by the setup command) |
| Bridge request, until the response is written (3 commands) | 540.5 ms (537.4) | 52.1 ms (52.5) |
| Bridge request, in all (4 commands) | 717.2 ms (716.3) | 67.7 ms (68.9) |

The switch-off column is the negative control: it is the cost of today.

The loopback has no network delay. In production one short command lasts 0.35 s (median), against
0.18 s here, so the absolute gain per command is expected to be larger there. Not measured there.

## What a local test cannot show

- A remote host that runs the OpenSSH server for Windows, or macOS: several sessions on one
  connection are standard SSH, but this was not tried against the studio machines.
- The real network between the server and the machines.
- The classification of errors by the worker router when a host disappears: with the switch on, a
  command to a lost host can end by its own timeout instead of a connection error during about 15 s.

## Before turning the switch on in production

1. Bench: the same server version with the switch on, against a local `sshd`, with the non-regression
   run of the bench.
2. One run on a Windows machine and one on a Mac with the switch on, then read the server log for
   `mux_client` or `ControlSocket` messages.
3. Measure before and after, at a similar load, read-only, from the studio working repository:
   `drafts/paperclip-multi-coeurs/mesures/2-lancements-et-noyau.py` prints the lifetimes of the `ssh`
   children of the server (13 Nov: median 0.35 s). Expected after: a median far below 0.1 s for the
   short commands; the idle wait of the bridge keeps its 5 s.
