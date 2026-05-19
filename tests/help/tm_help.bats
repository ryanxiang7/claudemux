#!/usr/bin/env bats
#
# Snapshot tests for `tm help <verb>` output.
#
# README and SKILL docs treat `tm <verb> --help` as the single source of
# truth for verb behavior. These tests turn that promise into a check:
# any change to a help_<verb> body must be reflected in the matching
# fixture under tests/fixtures/, otherwise the test fails. That's the
# intended workflow — refresh the fixture in the same commit that
# changes the help text.
#
# Refresh a single fixture:
#   plugins/claudemux/bin/tm help <verb> > tests/fixtures/help-<verb>.txt
# Refresh all fixtures at once (use sparingly — defeats the snapshot's
# review value if done blindly):
#   for v in $(ls tests/fixtures | sed 's/help-//;s/\.txt//;/^help$/d'); do \
#     plugins/claudemux/bin/tm help "$v" > "tests/fixtures/help-$v.txt"; done

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"
    TM="$REPO_ROOT/plugins/claudemux/bin/tm"
    FIX="$REPO_ROOT/tests/fixtures"
}

# Diff fresh `tm help <arg>` output against the fixture and fail with a
# unified diff on mismatch. Arg "" => top-level help (fixture: help.txt).
assert_help_matches() {
    local arg="$1" fixture
    if [[ -z "$arg" ]]; then
        fixture="$FIX/help.txt"
        run "$TM" help
    else
        fixture="$FIX/help-$arg.txt"
        run "$TM" help "$arg"
    fi
    [ "$status" -eq 0 ]
    [ -f "$fixture" ] || {
        echo "missing fixture: $fixture" >&2
        return 1
    }
    diff -u "$fixture" <(printf '%s\n' "$output") || {
        echo "help output for '${arg:-<top-level>}' diverged from fixture $fixture" >&2
        echo "If the change is intentional, refresh with:" >&2
        echo "  $TM help $arg > $fixture" >&2
        return 1
    }
}

@test "tm help (top-level) matches fixture" { assert_help_matches ""; }

@test "tm help ls"       { assert_help_matches ls; }
@test "tm help states"   { assert_help_matches states; }
@test "tm help spawn"    { assert_help_matches spawn; }
@test "tm help send"     { assert_help_matches send; }
@test "tm help wait"     { assert_help_matches wait; }
@test "tm help compact"  { assert_help_matches compact; }
@test "tm help resume"   { assert_help_matches resume; }
@test "tm help last"     { assert_help_matches last; }
@test "tm help kill"     { assert_help_matches kill; }
@test "tm help reload"   { assert_help_matches reload; }
@test "tm help ctx"      { assert_help_matches ctx; }
@test "tm help history"  { assert_help_matches history; }
@test "tm help mem"      { assert_help_matches mem; }
@test "tm help archive"  { assert_help_matches archive; }
@test "tm help status"   { assert_help_matches status; }
@test "tm help poll"     { assert_help_matches poll; }
@test "tm help doctor"   { assert_help_matches doctor; }

# Cross-form invariance: every verb is reachable via both `tm help <v>`
# and `tm <v> --help`. Spot-checking two representative verbs is enough
# to catch a regression in the dispatch wiring (cmd_X routing --help
# to help_X). Locking it for ALL verbs would just inflate maintenance
# without catching anything the snapshot tests above don't.
@test "tm send --help equals tm help send" {
    a=$("$TM" send --help)
    b=$("$TM" help send)
    [ "$a" = "$b" ]
}

@test "tm doctor --help equals tm help doctor" {
    a=$("$TM" doctor --help)
    b=$("$TM" help doctor)
    [ "$a" = "$b" ]
}
