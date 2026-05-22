#!/usr/bin/env bats
#
# Pure-function unit tests for bin/tm. These functions have no IO, no
# global state beyond their args, and no external command calls — they
# are the safest layer to lock down with cheap assertions.
#
# Loaded via test_helper.bash, which strips the trailing `main "$@"`
# line from bin/tm and sources the rest, so every function defined in
# tm is callable here as a plain shell function.

setup() {
    load "$BATS_TEST_DIRNAME/../test_helper.bash"
    load_tm_functions
}

# ---- session_name: PREFIX + repo, no escaping ----

@test "session_name: typical repo" {
    run session_name foo
    [ "$status" -eq 0 ]
    [ "$output" = "teammate-foo" ]
}

@test "session_name: dashes in repo are preserved literally" {
    run session_name a-b-c
    [ "$status" -eq 0 ]
    [ "$output" = "teammate-a-b-c" ]
}

@test "session_name: empty repo yields bare prefix (documents current behavior)" {
    run session_name ""
    [ "$status" -eq 0 ]
    [ "$output" = "teammate-" ]
}

# ---- sid_file: /tmp/teammate-<repo>.sid path builder ----

@test "sid_file: typical repo" {
    run sid_file foo
    [ "$status" -eq 0 ]
    [ "$output" = "/tmp/teammate-foo.sid" ]
}

@test "sid_file: repo with dots passes through" {
    run sid_file my.repo
    [ "$status" -eq 0 ]
    [ "$output" = "/tmp/teammate-my.repo.sid" ]
}

@test "sid_file: matches the prefix used by session_name" {
    # Lock the invariant: sid_file and session_name share the
    # teammate-<repo> stem. Drift between them would silently break
    # spawn -> wait coordination.
    local sn sf
    sn=$(session_name foo)
    sf=$(sid_file foo)
    [ "$sf" = "/tmp/${sn}.sid" ]
}

# ---- fmt_age: seconds -> short relative age ----

@test "fmt_age: under 60 seconds shows seconds" {
    run fmt_age 0
    [ "$output" = "0s" ]
    run fmt_age 59
    [ "$output" = "59s" ]
}

@test "fmt_age: minute and hour boundaries" {
    run fmt_age 60
    [ "$output" = "1m" ]
    run fmt_age 3599
    [ "$output" = "59m" ]
    run fmt_age 3600
    [ "$output" = "1h" ]
}

@test "fmt_age: day boundary" {
    run fmt_age 86399
    [ "$output" = "23h" ]
    run fmt_age 86400
    [ "$output" = "1d" ]
}

# ---- teammate_launch_flags: claude flags shared by every teammate launch ----

@test "teammate_launch_flags: exact flag string for a trivial settings JSON" {
    # Locks the whole shape: --settings carrying the JSON single-quoted,
    # then exactly --disallowedTools AskUserQuestion and nothing else.
    run teammate_launch_flags '{}'
    [ "$status" -eq 0 ]
    [ "$output" = "--settings '{}' --disallowedTools AskUserQuestion" ]
}

@test "teammate_launch_flags: settings JSON passes through verbatim, single-quoted" {
    # The real caller hands in the claudeMdExcludes JSON, whose embedded
    # double quotes must survive into the launch command untouched.
    local json='{"claudeMdExcludes":["/repo/CLAUDE.md","/repo/CLAUDE.local.md"]}'
    run teammate_launch_flags "$json"
    [ "$status" -eq 0 ]
    [ "$output" = "--settings '$json' --disallowedTools AskUserQuestion" ]
}

@test "teammate_launch_flags: AskUserQuestion is the only tool disabled" {
    # The disable is intentionally scoped to one tool. If a second tool
    # were ever appended it would show as a comma/space-joined list.
    run teammate_launch_flags '{}'
    [ "$status" -eq 0 ]
    [[ "$output" == *"--disallowedTools AskUserQuestion" ]]
    [[ "$output" != *"--disallowedTools AskUserQuestion "* ]]
    [[ "$output" != *"AskUserQuestion,"* ]]
}

# ---- heartbeat path builders: /tmp/teammate-<repo>.* ----

@test "proc_file: /tmp/teammate-<repo>.proc" {
    run proc_file foo
    [ "$status" -eq 0 ]
    [ "$output" = "/tmp/teammate-foo.proc" ]
}

@test "health_file: /tmp/teammate-<repo>.health" {
    run health_file foo
    [ "$output" = "/tmp/teammate-foo.health" ]
}

@test "resumed_at_file: /tmp/teammate-<repo>.resumed-at" {
    run resumed_at_file foo
    [ "$output" = "/tmp/teammate-foo.resumed-at" ]
}

@test "resume_log_file: /tmp/teammate-<repo>.resume-log" {
    run resume_log_file foo
    [ "$output" = "/tmp/teammate-foo.resume-log" ]
}

@test "launch_marker_file: /tmp/teammate-<repo>.last-launch" {
    run launch_marker_file foo
    [ "$output" = "/tmp/teammate-foo.last-launch" ]
}

@test "resume_lock_dir: /tmp/teammate-<repo>.resume.lock" {
    run resume_lock_dir foo
    [ "$output" = "/tmp/teammate-foo.resume.lock" ]
}

@test "heartbeat builders share the teammate-<repo> stem with sid_file" {
    # Lock the invariant: every repo-keyed heartbeat file sits next to
    # the .sid file. Drift here would scatter the protocol.
    local sf; sf=$(sid_file foo)               # /tmp/teammate-foo.sid
    [ "$(proc_file foo)"          = "${sf%.sid}.proc" ]
    [ "$(health_file foo)"        = "${sf%.sid}.health" ]
    [ "$(resumed_at_file foo)"    = "${sf%.sid}.resumed-at" ]
    [ "$(resume_log_file foo)"    = "${sf%.sid}.resume-log" ]
    [ "$(launch_marker_file foo)" = "${sf%.sid}.last-launch" ]
}

# ---- liveness_from_probe: the pure liveness classifier ----
# Args: <has_session> <recent_launch> <cur_cmd> <recorded_cmd> <busy_age> <wedge_secs>

@test "liveness_from_probe: no tmux session -> dead-session" {
    run liveness_from_probe no no '' '' -1 1200
    [ "$output" = "dead-session" ]
}

@test "liveness_from_probe: a recent launch is 'starting', even over a shell pane" {
    # The boot-grace window must win: a teammate still coming up reads
    # as starting, not as a dead shell.
    run liveness_from_probe yes yes zsh node -1 1200
    [ "$output" = "starting" ]
}

@test "liveness_from_probe: recorded .proc matches the live command -> alive" {
    run liveness_from_probe yes no node node -1 1200
    [ "$output" = "alive" ]
}

@test "liveness_from_probe: recorded .proc differs from the live command -> dead-proc" {
    run liveness_from_probe yes no zsh node -1 1200
    [ "$output" = "dead-proc" ]
}

@test "liveness_from_probe: no .proc, pane fell back to a shell -> dead-proc" {
    run liveness_from_probe yes no bash '' -1 1200
    [ "$output" = "dead-proc" ]
}

@test "liveness_from_probe: no .proc, pane runs a known REPL command -> alive" {
    run liveness_from_probe yes no node '' -1 1200
    [ "$output" = "alive" ]
}

@test "liveness_from_probe: no .proc, an unrecognised command errs toward alive" {
    # A false 'alive' only misses a death; a false death would resurrect
    # a healthy teammate. The unknown case must never read as dead.
    run liveness_from_probe yes no some-tool '' -1 1200
    [ "$output" = "alive" ]
}

@test "liveness_from_probe: a .busy older than the wedge threshold -> maybe-wedged" {
    run liveness_from_probe yes no node node 1500 1200
    [ "$output" = "maybe-wedged" ]
}

@test "liveness_from_probe: a .busy younger than the wedge threshold -> alive" {
    run liveness_from_probe yes no node node 300 1200
    [ "$output" = "alive" ]
}

@test "liveness_from_probe: no .busy marker (age -1) is never wedged" {
    run liveness_from_probe yes no node node -1 1200
    [ "$output" = "alive" ]
}

# ---- count_epochs_within / prune_epochs: the resume-budget arithmetic ----

@test "count_epochs_within: counts only epochs inside the window" {
    # now=1000 window=100: 950 in, 905 in, 800 out, 1000 in -> 3
    run count_epochs_within 1000 100 950 905 800 1000
    [ "$output" = "3" ]
}

@test "count_epochs_within: the window boundary is inclusive" {
    # exactly <window> seconds old still counts
    run count_epochs_within 1000 100 900
    [ "$output" = "1" ]
}

@test "count_epochs_within: non-numeric tokens are skipped" {
    run count_epochs_within 1000 100 950 abc 1000
    [ "$output" = "2" ]
}

@test "count_epochs_within: an empty list is zero" {
    run count_epochs_within 1000 100
    [ "$output" = "0" ]
}

@test "prune_epochs: re-emits only in-window epochs, one per line" {
    run prune_epochs 1000 100 950 905 800 1000
    [ "${lines[0]}" = "950" ]
    [ "${lines[1]}" = "905" ]
    [ "${lines[2]}" = "1000" ]
    [ "${#lines[@]}" -eq 3 ]
}

@test "prune_epochs: nothing in window -> empty output" {
    run prune_epochs 1000 100 100 200
    [ "$output" = "" ]
}
