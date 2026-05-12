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
    # The Stop hook can fire before the turn's final assistant API response
    # has been flushed to the jsonl on disk — so a naive extract can produce
    # a .last that is silently missing the user-visible deliverable text
    # block (the case that motivated this version: 72/73 blocks extracted,
    # the 73rd being the actual reply, looked "fine" but was incomplete).
    #
    # Solution: poll the jsonl for a TERMINAL stop_reason on the most
    # recent assistant entry. Each Anthropic API response writes a stop_
    # reason indicating whether more output is expected. While the model is
    # paused waiting for a tool ("tool_use") or extended thinking
    # ("pause_turn"), the agent loop will write more content; we must wait.
    # Once we see a terminal reason (end_turn / stop_sequence / max_tokens /
    # refusal), the turn's final response is on disk and extraction is safe.
    #
    # Fast path: a turn already at end_turn returns on the first check (no
    # waiting). Slow path: at most ~3s. If we never see terminal — the
    # turn was interrupted, errored, or Stop fired in an unexpected order
    # — we LEAVE .last ABSENT rather than write a misleading partial.
    if wait_for_jsonl_terminal "$transcript"; then
        text=$(extract_last_turn "$transcript")
        if [[ -n "$text" ]]; then
            printf '%s\n' "$text" > "$last_file"
        else
            # No visible text (e.g. tool-only turn). Drop any stale .last.
            rm -f "$last_file"
        fi
    else
        # Diagnostic so a future debugger can distinguish "turn produced no
        # text" from "we timed out waiting for jsonl to settle". Goes to
        # stderr → Claude Code's hook log; user never sees it directly.
        echo "on-stop: $sid: jsonl never reached terminal stop_reason within 3s — leaving .last absent" >&2
        rm -f "$last_file"
    fi
fi

# Touch the idle signal LAST. Any waiter that races on the touch and
# immediately reads .last will find the .last in place.
touch "$idle_dir/$sid"
exit 0
