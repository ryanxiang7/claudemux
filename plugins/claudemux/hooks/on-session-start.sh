#!/usr/bin/env bash
# claudemux SessionStart hook. Three responsibilities, gated by two
# independent safety checks (no DEV_DIR, no config file):
#
#   1) Sid rotation. /clear (and interactive /resume) generate a fresh
#      session_id; we update /tmp/teammate-<slug>.sid in place so the
#      dispatcher's `tm states / last / wait / send` keep working.
#
#   2) Spawn readiness. Touch /tmp/teammate-<slug>.ready so `tm spawn`'s
#      poll loop knows the REPL is up.
#
#   3) Audit. Each rotation is appended to /tmp/claudemux-sid-changes.log
#      so drift events are post-hoc inspectable.
#
# A teammate <repo> may be a multi-segment path (a nested worktree like
# `group/repo`). The protocol files are keyed by a SLUG that folds every
# '/' to '-', so they stay flat `/tmp/teammate-*` filenames. CLAUDEMUX_-
# TEAMMATE_REPO carries the raw <repo>; this hook slugifies it itself via
# the repo_slug mirror of bin/tm's builder. For a single-segment repo the
# slug equals the repo, so this is a no-op there.
#
# Safety check 1 — env identity gate:
#   `tm spawn` launches its tmux session with
#   `tmux new-session -e CLAUDEMUX_TEAMMATE_REPO=<repo>`. claude inherits
#   that env, hooks inherit it from claude. The env survives /clear and
#   /resume because they don't restart the claude process. If the env is
#   not set, this is some other claude session (the dispatcher itself,
#   an ad-hoc `cd <repo> && claude`, a teammate launched via raw
#   `tmux new-session` without the -e) and we no-op. This single check
#   is what prevents a dispatcher whose cwd happens to byte-equal a
#   recorded teammate.cwd from hijacking the teammate's .sid file via
#   the cwd-match loop below.
#
# Safety check 2 — recorded-cwd byte match:
#   Even with the env set, we still verify the firing claude's cwd
#   byte-equals the content of /tmp/teammate-<slug>.cwd. `tm spawn`
#   writes that file at spawn time with the PHYSICAL path of the
#   teammate's directory (via `cd && pwd -P`), and Claude Code emits cwd
#   in the hook payload also as the physical path. The match also acts
#   as a safety against a stray `cd packages/foo && /clear` inside a
#   teammate — different cwd → no sid rotation, the .sid pointer stays
#   pinned to the teammate's real workspace.

set -u

input=$(cat || true)
[[ -n "$input" ]] || exit 0

# Fast field extraction — sed is enough for the JSON shapes Claude Code
# emits; jq's ~8 ms cold start is wasted budget on every SessionStart.
extract_field() {
    printf '%s' "$input" | sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1
}

sid=$(extract_field session_id)
cwd=$(extract_field cwd)
src=$(extract_field source)
[[ -n "$sid" && -n "$cwd" ]] || exit 0

# Path builders for the per-slug protocol files under /tmp. Mirror
# bin/tm's repo_slug + cwd_file / sid_file / ready_file so the scheme has
# a named accessor at every site — hooks can't source bin/tm, so the
# discipline is enforced by repeating the builders here. repo_slug folds
# every '/' in a (possibly multi-segment) <repo> to '-' so the value is a
# legal tmux session name and a flat /tmp filename component; it is a
# no-op on a single-segment repo.
repo_slug()  { printf '%s' "$1" | tr '/' '-'; }
cwd_file()   { echo "/tmp/teammate-$(repo_slug "$1").cwd"; }
sid_file()   { echo "/tmp/teammate-$(repo_slug "$1").sid"; }
ready_file() { echo "/tmp/teammate-$(repo_slug "$1").ready"; }

# Env identity gate (see file header). Without CLAUDEMUX_TEAMMATE_REPO,
# this claude was not launched by `tm spawn` — exit before doing any
# .sid / .ready work, even if the cwd happens to match a recorded
# teammate.cwd. This is what protects against the dispatcher (running in
# a cwd that coincides with a sibling repo) hijacking the sid pointer.
env_repo="${CLAUDEMUX_TEAMMATE_REPO:-}"
[[ -n "$env_repo" ]] || exit 0

# Recorded-cwd byte match. The env tells us WHICH repo we should be;
# the .cwd file tells us where that repo actually lives on disk. If the
# firing cwd doesn't match the recorded cwd for env_repo, something is
# off (e.g. someone `cd`'d into a subdir before /clear) — refuse to
# rotate, leaving the .sid pointer pinned to the teammate's workspace.
cf=$(cwd_file "$env_repo")
[[ -f "$cf" ]] || exit 0
[[ "$(cat "$cf" 2>/dev/null)" == "$cwd" ]] || exit 0
repo="$env_repo"

sf=$(sid_file "$repo")

# Sid rotation. Write only when the sid actually changes — that keeps
# the steady-state startup case quiet (dispatcher's `tm spawn` already
# wrote the same sid before claude booted) and limits the audit log to
# real rotations (/clear, interactive /resume).
old=""
[[ -s "$sf" ]] && old=$(cat "$sf" 2>/dev/null || true)
if [[ "$old" != "$sid" ]]; then
    echo "$sid" > "$sf"
    ts=$(date +%Y-%m-%dT%H:%M:%S)
    printf '%s repo=%s source=%s old=%s new=%s\n' "$ts" "$repo" "${src:-?}" "${old:-<none>}" "$sid" \
        >> /tmp/claudemux-sid-changes.log 2>/dev/null
fi

# Readiness signal — always touched once the teammate is identified.
# `tm spawn` rm's this file BEFORE launching claude and polls for it to
# reappear; subsequent SessionStarts (clear / compact / resume) also
# touch but no one polls at that time, so they're harmless mtime bumps.
touch "$(ready_file "$repo")" 2>/dev/null

exit 0
