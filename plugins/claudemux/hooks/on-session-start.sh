#!/usr/bin/env bash
# claudemux SessionStart hook. Two responsibilities, both gated by the
# same cwd-must-be-$DEV_DIR/<repo> rail.
#
# 1) Track session_id rotation. The dispatcher writes the sid at
#    `tm spawn` time, but `/clear` (and interactive `/resume`) rotate it.
#    Without this hook /tmp/teammate-<repo>.sid would still point at the
#    retired sid, and every subsequent `tm last` / `tm wait-idle` /
#    `tm states` would consult dead files. We overwrite when the sid
#    differs from what's on disk; equal sid is a quiet no-op (skips the
#    audit log entry, doesn't skip readiness below).
#
# 2) Emit a spawn-readiness signal. `tm spawn` blocks on
#    /tmp/teammate-<repo>.ready before declaring the teammate usable —
#    no more "sleep 8 and hope". We `touch` the file on EVERY
#    SessionStart (including source=clear / compact / resume) because
#    the only consumer is `tm spawn` itself, which pre-rm's the file
#    before launching claude. Later SessionStarts are harmless mtime
#    bumps that no caller polls for.
#
# Safety rails (BOTH must hold before we touch any sid file):
#   1. The hook's cwd must be EXACTLY $DEV_DIR/<repo> — not a nested
#      subdirectory, and not anywhere outside $DEV_DIR. This prevents a
#      stray `cd packages/foo && claude` inside a teammate repo from
#      stealing the teammate's sid pointer.
#   2. /tmp/teammate-<repo>.sid must already exist. Only repos that have
#      been spawned via `tm spawn` carry a sid file; without one we don't
#      invent a teammate that never existed.
#
# The dispatcher itself runs at $DEV_DIR (no /<repo> suffix), so rail #1
# excludes it.

set -u

input=$(cat || true)
[[ -n "$input" ]] || exit 0

# Fast field extraction — same rationale as on-busy.sh: no jq.
extract_field() {
    printf '%s' "$input" | sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1
}

sid=$(extract_field session_id)
cwd=$(extract_field cwd)
src=$(extract_field source)
[[ -n "$sid" && -n "$cwd" ]] || exit 0

# Resolve DEV_DIR exactly the way `tm` does: env override wins, otherwise
# read the config file written by `setup`.
CONFIG_FILE="${CLAUDEMUX_CONFIG_FILE:-$HOME/.config/claudemux/config}"
DEV_DIR=""
if [[ -n "${CLAUDEMUX_DEV_DIR:-}" ]]; then
    DEV_DIR="$CLAUDEMUX_DEV_DIR"
elif [[ -f "$CONFIG_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$CONFIG_FILE"
    DEV_DIR="${DEV_DIR:-}"
fi
[[ -n "$DEV_DIR" ]] || exit 0

# Normalize DEV_DIR to its physical path. Claude Code emits cwd as the
# canonical resolved path (e.g. macOS rewrites /tmp/x -> /private/tmp/x),
# so a config DEV_DIR of /tmp/dispatcher would fail the cwd prefix check
# without normalization. `cd && pwd -P` is portable to macOS bash 3.2.
DEV_DIR=$(cd "$DEV_DIR" 2>/dev/null && pwd -P) || exit 0

# Rail 1: cwd must be EXACTLY $DEV_DIR/<repo> (no nested subdirs, no
# dispatcher root). Trim any trailing slash on cwd just in case.
cwd="${cwd%/}"
case "$cwd" in
    "$DEV_DIR"/*) rest="${cwd#$DEV_DIR/}" ;;
    *) exit 0 ;;
esac
case "$rest" in
    */*|"") exit 0 ;;   # nested under repo, or empty
esac
case "$rest" in
    .|..|.claude|.git|.idea|.vscode|node_modules) exit 0 ;;
esac
repo="$rest"

# Rail 2: only repos that have been spawned via `tm spawn` get tracked.
sf="/tmp/teammate-${repo}.sid"
[[ -f "$sf" ]] || exit 0

# Sid rotation (responsibility 1). Identical sid means dispatcher-spawned
# startup (or /compact / explicit /resume to the same sid) — skip the
# write and the audit log to keep the steady state quiet. Different sid
# means /clear or interactive /resume rotated it.
old=""
[[ -s "$sf" ]] && old=$(cat "$sf" 2>/dev/null || true)
if [[ "$old" != "$sid" ]]; then
    echo "$sid" > "$sf"
    ts=$(date +%Y-%m-%dT%H:%M:%S)
    printf '%s repo=%s source=%s old=%s new=%s\n' "$ts" "$repo" "${src:-?}" "${old:-<none>}" "$sid" \
        >> /tmp/claudemux-sid-changes.log 2>/dev/null
fi

# Spawn-readiness signal (responsibility 2). Always touched after rails
# pass — `tm spawn` rm's this file before launching claude and polls for
# it to re-appear, so the touch on cold startup is what unblocks the
# spawn. Subsequent SessionStarts (clear, compact, resume) also touch,
# which is harmless: no one polls then.
touch "/tmp/teammate-${repo}.ready" 2>/dev/null

exit 0
