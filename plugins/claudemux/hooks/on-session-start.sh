#!/usr/bin/env bash
# claudemux SessionStart hook. Three responsibilities, all gated by one
# single safety check (no DEV_DIR, no env override, no config file):
#
#   1) Sid rotation. /clear (and interactive /resume) generate a fresh
#      session_id; we update /tmp/teammate-<repo>.sid in place so the
#      dispatcher's `tm states / last / wait-idle` keep working.
#
#   2) Spawn readiness. Touch /tmp/teammate-<repo>.ready so `tm spawn`'s
#      poll loop knows the REPL is up.
#
#   3) Audit. Each rotation is appended to /tmp/claudemux-sid-changes.log
#      so drift events are post-hoc inspectable.
#
# The safety check: the firing claude's cwd must byte-equal the content
# of exactly one /tmp/teammate-<repo>.cwd file. `tm spawn` writes that
# file at spawn time with the PHYSICAL path of the teammate's directory
# (via `cd && pwd -P`), and Claude Code emits cwd in the hook payload
# also as the physical path, so the comparison is straightforward.
# Without a matching .cwd we do nothing — random claude sessions running
# anywhere else on the machine (including the dispatcher itself, since
# the dispatcher's cwd has no .cwd file mapped to it) silently no-op.

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

# Find the teammate whose recorded cwd byte-equals the firing cwd.
# Iterating /tmp/teammate-*.cwd is O(N) where N is the current teammate
# count (typically 1–5); no global state, no parent-path heuristics.
repo=""
for cf in /tmp/teammate-*.cwd; do
    [[ -f "$cf" ]] || continue
    [[ "$(cat "$cf" 2>/dev/null)" == "$cwd" ]] || continue
    base=$(basename "$cf" .cwd)        # teammate-<repo>
    repo="${base#teammate-}"
    break
done
[[ -n "$repo" ]] || exit 0

sf="/tmp/teammate-${repo}.sid"

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
touch "/tmp/teammate-${repo}.ready" 2>/dev/null

exit 0
