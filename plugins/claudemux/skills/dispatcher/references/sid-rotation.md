# sid rotation and spawn readiness (diagnostic reference)

Mechanism behind two pieces of `claudemux` plumbing that are normally invisible:

1. How `tm spawn` blocks until the new teammate REPL is actually usable.
2. How `on-session-start.sh` keeps `/tmp/teammate-<repo>.sid` in sync when `/clear` (or interactive `/resume`) rotates the underlying claude `session_id`.

Read this only when debugging `.sid` drift, a stuck `tm spawn`, or surprising `tm states` output. Normal dispatcher work does not need to consult it.

## Spawn readiness

`tm spawn` pre-removes `/tmp/teammate-<repo>.ready`, launches `tmux`+`claude`, then polls that file (60 × 0.3 s = 18 s cap) before returning. The SessionStart hook touches the file the moment the new claude session signals start — typically 2–4 s on a warm Mac — and the poll returns the moment it lands. On timeout, spawn prints a `WARN` and returns anyway so the caller can probe with `tm send` and get a real error if claude failed to boot. The file is per-repo (not per-sid) and lives outside the `/tmp/claude-idle/` namespace.

## `/clear` and sid rotation

`/clear` retires the current `session_id` and starts a fresh one. Without help, `/tmp/teammate-<repo>.sid` would still point at the dead sid and every subsequent `tm states / last / wait / send` would consult orphan files. The `on-session-start.sh` hook handles this with two gates on every `SessionStart` event:

1. **Env identity.** `tm spawn` launches its tmux session with `tmux new-session -e CLAUDEMUX_TEAMMATE_REPO=<repo>`. claude inherits that env, and so does the hook. If the env var is unset, this is some other claude session (the dispatcher itself, an ad-hoc `cd <repo> && claude`, or a teammate started via raw `tmux new-session` without the `-e`) — the hook no-ops. The env survives `/clear` and `/resume` because they don't restart the claude process.

2. **Recorded-cwd byte match.** Even with the env set, the firing claude's cwd must byte-equal the content of `/tmp/teammate-<env-repo>.cwd` (written by `tm spawn` using the PHYSICAL path via `cd && pwd -P`). A stray `cd packages/foo` inside the teammate before `/clear` won't match — the `.sid` pointer stays pinned to the teammate's real workspace.

On a both-gates pass, the hook overwrites `/tmp/teammate-<repo>.sid` with the new sid (handles `/clear` and interactive `/resume`) and touches `/tmp/teammate-<repo>.ready` (the spawn-readiness signal). `source=startup|compact|resume` with unchanged sid is a quiet no-op for the rotation step; readiness is touched regardless. All sid rotations are logged to `/tmp/claudemux-sid-changes.log` for audit.

The env gate is what makes this safe in the edge case where the dispatcher's own cwd byte-equals a recorded `teammate.cwd` (e.g. when maintaining the claudemux plugin itself: running the dispatcher from `~/Development/claudemux` while also having spawned `tm spawn claudemux` from a parent directory at some point). Without the env gate, both sessions match the same `.cwd` file and the last SessionStart to fire wins. With it, only the `tm spawn`-launched teammate ever updates the sid pointer.

## Debugging checklist

When `.sid` looks wrong or `tm states` shows stale data:

| What to inspect | Command | What it tells you |
|---|---|---|
| Current sid pointer | `cat /tmp/teammate-<repo>.sid` | Which session id the helpers consult |
| Recorded teammate cwd | `cat /tmp/teammate-<repo>.cwd` | Must byte-equal the teammate's own `pwd -P` |
| Rotation history | `tail /tmp/claudemux-sid-changes.log` | Every rotation, with timestamps and source |
| Env identity (run inside teammate) | `printenv CLAUDEMUX_TEAMMATE_REPO` | Empty → env gate fails → hook no-ops |
| Spawn readiness signal | `ls -l /tmp/teammate-<repo>.ready` | Touched by SessionStart on boot |

If env identity is empty, the teammate was launched outside `tm spawn` (raw `tmux new-session`, or `cd <repo> && claude`). Kill it and re-launch via `tm spawn <repo>`; raw launches deliberately bypass the rotation machinery.
