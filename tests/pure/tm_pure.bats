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
    # teammate-<slug> stem. Drift between them would silently break
    # spawn -> wait coordination.
    local sn sf
    sn=$(session_name foo)
    sf=$(sid_file foo)
    [ "$sf" = "/tmp/${sn}.sid" ]
}

# ---- repo_slug: fold '/' in a nested <repo> into one flat handle ----

@test "repo_slug: single-segment repo is unchanged" {
    run repo_slug foo
    [ "$status" -eq 0 ]
    [ "$output" = "foo" ]
}

@test "repo_slug: single-segment repo with dashes is unchanged" {
    # The zero-regression guarantee: an un-nested repo (the only kind
    # that existed before nesting) slugs to itself byte-for-byte.
    run repo_slug flow-web-monorepo
    [ "$status" -eq 0 ]
    [ "$output" = "flow-web-monorepo" ]
}

@test "repo_slug: nested repo folds every slash to a dash" {
    run repo_slug web-project/flow-web-monorepo-memory-quota
    [ "$status" -eq 0 ]
    [ "$output" = "web-project-flow-web-monorepo-memory-quota" ]
}

@test "repo_slug: deeply nested repo folds all separators" {
    run repo_slug a/b/c/d
    [ "$status" -eq 0 ]
    [ "$output" = "a-b-c-d" ]
}

@test "repo_slug: idempotent — slugging a slug is a no-op" {
    local once twice
    once=$(repo_slug web-project/repo)
    twice=$(repo_slug "$once")
    [ "$once" = "$twice" ]
}

@test "repo_slug: dots pass through (dotted repo names out of scope this round)" {
    run repo_slug my.repo
    [ "$status" -eq 0 ]
    [ "$output" = "my.repo" ]
}

@test "repo_slug: empty input yields empty output" {
    run repo_slug ""
    [ "$status" -eq 0 ]
    [ "$output" = "" ]
}

# ---- name/file builders: a nested <repo> slugs into one flat handle ----

@test "session_name: nested repo is slugged into one segment" {
    run session_name web-project/feature-x
    [ "$status" -eq 0 ]
    [ "$output" = "teammate-web-project-feature-x" ]
}

@test "sid_file: nested repo produces no '/' inside the file path" {
    run sid_file web-project/feature-x
    [ "$status" -eq 0 ]
    [ "$output" = "/tmp/teammate-web-project-feature-x.sid" ]
    # The bug this guards: a raw '/' would make the path point into a
    # non-existent /tmp/teammate-web-project/ directory.
    [[ "$output" != */teammate-web-project/* ]]
}

@test "send_at_file / ready_file / cwd_file / repo_file: nested repo slugged" {
    run send_at_file web-project/feature-x
    [ "$output" = "/tmp/teammate-web-project-feature-x.send-at" ]
    run ready_file web-project/feature-x
    [ "$output" = "/tmp/teammate-web-project-feature-x.ready" ]
    run cwd_file web-project/feature-x
    [ "$output" = "/tmp/teammate-web-project-feature-x.cwd" ]
    run repo_file web-project/feature-x
    [ "$output" = "/tmp/teammate-web-project-feature-x.repo" ]
}

@test "builders: nested repo's session_name and sid_file share the slugged stem" {
    local sn sf
    sn=$(session_name web-project/feature-x)
    sf=$(sid_file web-project/feature-x)
    [ "$sf" = "/tmp/${sn}.sid" ]
}

@test "repo_file: single-segment repo matches the flat pre-existing scheme" {
    run repo_file foo
    [ "$status" -eq 0 ]
    [ "$output" = "/tmp/teammate-foo.repo" ]
}

@test "repo_raw_for_slug: each call emits exactly one newline-terminated line" {
    # iter_repos pipes every teammate slug through repo_raw_for_slug and
    # `read`s the result line by line. A missing trailing newline would
    # concatenate adjacent teammates into a single token — breaking the
    # tm reload/ctx --all fan-out. These slugs have no .repo sidecar, so
    # both hit the fallback branch; the joined output must still be two
    # distinct lines.
    local out
    out=$(repo_raw_for_slug zzz-no-such-slug-1; repo_raw_for_slug zzz-no-such-slug-2)
    [ "$(printf '%s\n' "$out" | grep -c .)" -eq 2 ]
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
