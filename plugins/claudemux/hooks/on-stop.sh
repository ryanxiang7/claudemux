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

# Diagnostic log — appended on every Stop fire, one line per phase. Lives
# under the idle dir so the existing TTL sweep cleans it up after 7 days.
# Always-on (cheap); when investigating a misbehaving turn, `cat` this file
# to see what the hook saw and which branch it took.
DIAG_LOG="/tmp/claude-idle/_on-stop.log"
diag_log() {
    local ts; ts=$(date +%Y-%m-%dT%H:%M:%S)
    printf '%s sid=%s %s\n' "$ts" "${sid:-unknown}" "$*" >> "$DIAG_LOG" 2>/dev/null
}

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
diag_log "phase=enter transcript=${transcript:-<empty>}"

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

# Return the stop_reason of the most recent assistant entry, or empty
# string if no assistant entry exists / jq errored / stop_reason is null.
# Tail-walks the file with rev_lines + head -1: the first emitted value
# (= the latest assistant from end of file) closes the pipeline via
# SIGPIPE, so the scan is bounded to ONE entry's worth of lines.
latest_stop_reason() {
    rev_lines "$1" 2>/dev/null \
        | jq -r 'select(.type == "assistant") | .message.stop_reason // ""' 2>/dev/null \
        | head -1
}

# Does this stop_reason mean the Anthropic API call ended without expecting
# the agent loop to continue? Source: Anthropic API docs.
#   end_turn       Model finished its natural text response.
#   stop_sequence  A configured stop sequence was emitted.
#   max_tokens     Token budget hit.
#   refusal        Model refused (newer models).
# Non-terminal — the agent loop is still mid-flight and will write more:
#   tool_use       Paused waiting for caller to run a tool.
#   pause_turn     Extended-thinking pause; more content coming.
is_terminal_stop_reason() {
    case "$1" in
        end_turn|stop_sequence|max_tokens|refusal) return 0 ;;
        *) return 1 ;;
    esac
}

# Poll the jsonl until the latest assistant entry has a terminal
# stop_reason, signalling that the turn's final API response has been
# persisted. Returns 0 on hit, 1 on timeout.
#
# The Stop hook can fire while Claude Code is still flushing the final
# assistant entry to disk (the failure that motivated this — partial
# extraction with N-1 of N text blocks looked "fine" but was incomplete).
# Without this wait, every long deliverable turn risks a silent loss of
# the last text block.
#
# Budget: 15 × 0.2s = 3s, well within the default 60s hook timeout.
# Fast path (turn already at end_turn on first check) adds zero latency.
wait_for_jsonl_terminal() {
    local jsonl="$1" reason i
    for ((i = 0; i < 15; i++)); do
        reason=$(latest_stop_reason "$jsonl")
        if [[ -n "$reason" ]] && is_terminal_stop_reason "$reason"; then
            return 0
        fi
        sleep 0.2
    done
    return 1
}

if [[ -n "${transcript:-}" && -f "$transcript" ]]; then
    # Snapshot tail-5 entries at fire time — type|stop_reason|content_types
    # — so we can later tell whether the jsonl already had a text-bearing
    # final entry, or only an earlier thinking-only one.
    tail_summary=$(tail -5 "$transcript" 2>/dev/null | jq -r '
        [(.type // "?"),
         (.message.stop_reason // "-"),
         (if .type == "assistant" then ((.message.content // []) | map(.type) | join(",")) else "-" end)
        ] | join("|")
    ' 2>/dev/null | tr '\n' ';')
    diag_log "phase=tail-summary jsonl_size=$(stat -f %z "$transcript" 2>/dev/null || echo ?) tail5=[${tail_summary%;}]"

    # The Stop hook can fire before the turn's final assistant API response
    # has been flushed to the jsonl on disk — so a naive extract can produce
    # a .last that is silently missing the user-visible deliverable text
    # block. We poll for a TERMINAL stop_reason on the most recent assistant
    # entry to decide it's safe to extract.
    #
    # Known weakness being investigated: a turn that splits into multiple
    # API calls (e.g. one thinking-only call followed by a text call) has
    # MULTIPLE terminal entries. If the earlier one is in the jsonl but the
    # final text one isn't yet, fast-path passes prematurely and we extract
    # nothing — historically rm'd .last, which destroyed prior content too.
    # Diagnostic logging here lets us see the timing on a real repro before
    # tightening the predicate.
    if wait_for_jsonl_terminal "$transcript"; then
        diag_log "phase=wait-end result=terminal"
        text=$(extract_last_turn "$transcript")
        if [[ -n "$text" ]]; then
            printf '%s\n' "$text" > "$last_file"
            diag_log "phase=write text_bytes=${#text}"
        else
            diag_log "phase=rm-empty (terminal stop_reason but extract empty — tool-only or thinking-only final entry?)"
            rm -f "$last_file"
        fi
    else
        # CHANGED: previously rm -f'd .last here. Timeout means "we don't
        # know" not "confirmed empty"; destroying any prior .last that may
        # still be valid amplifies the break (advisor flagged this). Leave
        # whatever exists alone.
        diag_log "phase=timeout (jsonl never reached terminal stop_reason within 3s — leaving .last as-is)"
    fi
fi

# Touch the idle signal LAST. Any waiter that races on the touch and
# immediately reads .last will find the .last in place.
touch "$idle_dir/$sid"
diag_log "phase=touch-idle"
exit 0
