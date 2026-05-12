#!/usr/bin/env bash
# claudemux Stop hook.
#
# Writes two files on every Stop event:
#   /tmp/claude-idle/<sid>        zero-byte touch — the wait-idle signal
#   /tmp/claude-idle/<sid>.last   plain text of the assistant's last turn
#
# The .last file lets the dispatcher recover a full reply without scraping
# tmux scrollback (which truncates) and without parsing jsonl itself.
#
# Hook stdin is the harness JSON: { session_id, transcript_path, ... }.
# We always exit 0 — the harness does not want a hook to fail the turn.

set -u

input=$(cat || true)
[[ -n "${input:-}" ]] || exit 0

# Pull both fields in one jq invocation — jq is the dominant per-Stop cost
# (~8ms cold start each), and this hook runs on EVERY Claude Code session
# on the machine.
sid=""; transcript=""
IFS=$'\t' read -r sid transcript < <(
    printf '%s' "$input" | jq -r '[.session_id // "", .transcript_path // ""] | @tsv' 2>/dev/null || true
)
[[ -n "${sid:-}" ]] || exit 0

idle_dir="/tmp/claude-idle"
mkdir -p "$idle_dir" 2>/dev/null || exit 0

# Occasionally sweep stale idle/last files older than 7 days. The hook is the
# only writer to $idle_dir, but `tm kill` only cleans entries for sessions it
# spawned — ad-hoc `claude` sessions (and orphans from crashes) accumulate
# forever otherwise. Run in the background and ignore failures so the sweep
# never delays turn-end. ~1/16 probability keeps it amortized over many turns.
if (( RANDOM % 16 == 0 )); then
    find "$idle_dir" -maxdepth 1 -mtime +7 -type f -delete 2>/dev/null &
    disown 2>/dev/null || true
fi

last_file="$idle_dir/$sid.last"

# Reverse input by line. GNU `tac` if available (Linux), else BSD `tail -r`
# (macOS). Both seek from end on a regular file (true backward streaming),
# and both also work on stdin (slurped), which is fine for the second
# reversal where input is already O(turn-size).
rev_lines() {
    if command -v tac >/dev/null 2>&1; then tac "$@"; else tail -r "$@"; fi
}

# Extract the assistant's last-turn text from a jsonl transcript.
#
# Walk the file BACKWARDS line by line. For each entry:
#   - assistant entry: emit its joined text-block content (empty entries dropped)
#   - real user entry (string content): `halt` — that's the previous turn's
#     boundary. tool_result user entries have array content, so they fail the
#     type check and we keep walking back.
#   - anything else: skip.
# `halt` makes jq exit cleanly, the upstream reverser gets SIGPIPE and stops,
# so the file read is bounded by ONE turn's worth of lines (~10s-100s), not
# the transcript length. The small reversed output is then reversed back to
# chronological order and joined with blank lines.
extract_last_turn() {
    rev_lines "$1" 2>/dev/null | jq -c '
        if .type == "user" and (.message.content | type) == "string" then halt
        elif .type == "assistant" then
          (.message.content // [] | map(select(.type == "text") | .text) | join(""))
          | select(length > 0)
        else empty end
    ' 2>/dev/null | rev_lines | jq -rs 'join("\n\n")'
}

if [[ -n "${transcript:-}" && -f "$transcript" ]]; then
    # Stop hook can fire before the final assistant text block has flushed to
    # the jsonl on disk (observed: dispatcher's own turn with a long reply
    # left a 1-byte .last because the text entry hadn't landed yet). Retry
    # once after a short sleep before giving up.
    text=$(extract_last_turn "$transcript")
    if [[ -z "$text" ]]; then
        sleep 0.25
        text=$(extract_last_turn "$transcript")
    fi
    if [[ -n "$text" ]]; then
        printf '%s\n' "$text" > "$last_file"
    else
        # Nothing to write — drop any stale .last rather than leave a 1-byte
        # newline-only file. Consumers can treat "file missing" as "no visible
        # text in this turn" (e.g. tool-only turn).
        rm -f "$last_file"
    fi
fi

# Touch the idle signal LAST. Any waiter that races on the touch and
# immediately reads .last will find the .last in place.
touch "$idle_dir/$sid"
exit 0
