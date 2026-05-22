# 0009 — `tm` accepts a nested `<repo>` path via a slugged teammate handle

- **Status:** Accepted
- **Date:** 2026-05-21
- **Affects:** `bin/tm`, `hooks/on-session-start.sh`, the cross-process protocol

## Context

A teammate `<repo>` was assumed to be a *direct* subdirectory of the
dispatcher dir. A nested worktree — `web-project/flow-web-monorepo-memory-quota`
— could only be reached by pointing `TM_DISPATCHER_DIR` at the intermediate
directory, an override that has to be remembered per call.

The directory side already worked: `$DISPATCHER_DIR/$repo`, `cd`, and
`pwd -P` handle a multi-segment path unchanged. What broke was the *handle*
side — the same `<repo>` is stamped into a tmux session name (`teammate-<repo>`)
and into `/tmp/teammate-<repo>.*` filenames, and a `/` is illegal there: a
session name cannot carry a path separator, and `/tmp/teammate-a/b.sid`
points into a `/tmp/teammate-a/` directory that does not exist, so the write
fails outright.

## Decision

Split the two roles of `<repo>` explicitly:

- The **raw `<repo>`** stays the working *directory* (`$DISPATCHER_DIR/$repo`).
- A **slug** — `<repo>` with every `/` folded to `-` (`repo_slug`) — is the
  teammate's flat *handle* for its tmux session name and `/tmp/teammate-*`
  files.

`repo_slug` folds only `/` this round. It is idempotent and a no-op on a
single-segment repo (no `/` to fold), so an un-nested teammate's session
name and every protocol file are byte-identical to the pre-nesting scheme —
zero regression. The five `/tmp/teammate-*` builders slugify internally, so
call sites keep passing the raw `<repo>`.

A new protocol file `/tmp/teammate-<slug>.repo` records the raw `<repo>`, so
`tm states` and the `--all` fan-out can map a slugged session name back to
the path the dispatcher typed (`repo_raw_for_slug`).

The `tm`↔hook seam keeps `CLAUDEMUX_TEAMMATE_REPO` carrying the **raw**
`<repo>`; `on-session-start.sh` mirrors `repo_slug` inline (as the
path-builder invariant already prescribes for hooks) rather than having the
env var's meaning change to "slug".

`tm spawn` rejects an absolute `<repo>` and any `..` segment, and guards
against two distinct paths folding to the same slug.

## Consequences

- Dotted repo directory names (`my.repo`) remain a pre-existing, separate
  issue: `.` is also illegal in a tmux session name, but folding it would
  change the handle of an existing single-segment repo. `repo_slug` is
  scoped to `/` only; dotted names are left for a future round.
- Two different paths *can* still collide on a slug (`a/b` and `a-b` both
  fold to `a-b`). The collision is now a loud, specific `tm spawn` failure
  via the `.repo` guard, not a silent shared-session hijack.
- `iter_repos` now reads one `.repo` file per live session instead of being
  pure `tmux ls` parsing — a teammate spawned by an older `tm` (no `.repo`)
  falls back to displaying the slug.

## References

- `bin/tm` — `repo_slug`, `repo_file`, `repo_raw_for_slug`, the slugified
  name/file builders, `cmd_spawn` validation + collision guard.
- `hooks/on-session-start.sh` — inline `repo_slug` mirror.
- [domains/cross-process-protocol.md](/.agents/domains/cross-process-protocol.md) — the `.repo` file and the slug keying scheme.
