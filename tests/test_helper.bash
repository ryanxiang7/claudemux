# Shared test helpers for the claudemux bats suite.
#
# load_tm_functions:
#   Source bin/tm with its final `main "$@"` invocation stripped, so all
#   function definitions land in the current shell without firing the
#   CLI dispatcher. This lets pure-function tests call tm internals
#   (session_name, sid_file, fmt_age, ...) directly without spawning a
#   subprocess per assertion, and without modifying bin/tm to add an
#   `is-sourced` guard.

# Resolve repo root from this helper's own path so tests can `load` it
# from any depth under tests/.
TESTS_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TM_BIN="$TESTS_REPO_ROOT/plugins/claudemux/bin/tm"

load_tm_functions() {
    [[ -f "$TM_BIN" ]] || {
        echo "load_tm_functions: tm not found at $TM_BIN" >&2
        return 1
    }
    # `sed '$d'` drops the last line, which is the literal `main "$@"`
    # dispatcher call. We `eval` the result rather than `source <(...)`
    # because macOS ships bash 3.2, where process-substitution sourcing
    # silently fails to register function definitions in the calling
    # shell (function table doesn't propagate). eval works on bash 3.2+.
    eval "$(sed '$d' "$TM_BIN")"
}
