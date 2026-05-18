---
name: dispatcher
description: Manage dispatcher-style coordination across sibling git repos from a parent workspace. Use when the user asks to spawn, dispatch, message, resume, inspect teammate state, or kill a teammate; coordinate work across multiple sibling repos; check what teammates are doing; host or manage local scheduled work; or maintain the dispatcher task ledger/watch loop. Also use when the user names dispatcher concepts such as "派一个 / 派活 / 派 teammate / 派 X 去 / 看看 X 在干啥 / 问问 X / dispatcher / 多仓 / 跨仓 / orchestrator".
user-invocable: false
---

# Dispatcher: multi-repo Claude orchestrator

Use this skill as the operations manual for dispatcher-style work from a parent directory of sibling git repos: `tm`, teammate delegation, wait/readback, cron hosting, Agent Teams caveats, and the task ledger. The dispatcher routes target repo work to a repo-local Claude process or teammate, then waits, reads back, updates the ledger, and reports the result. Start by resolving the target sibling repo and choosing one delegation form; load diagnostic references only when the normal flow does not fit.

> **`tm` is the helper script** bundled with this plugin. Examples below call it as bare `tm`. Claude Code auto-prepends each installed plugin's `bin/` directory to `PATH`, so `which tm` resolves inside any Bash subshell of an interactive Claude Code session. If for some reason `tm` is not on `PATH` (e.g. a shell that doesn't inherit Claude Code's env), use the absolute install path: `~/.claude/plugins/cache/claudemux/claudemux/<version>/bin/tm`. **Do not** rely on `${CLAUDE_PLUGIN_ROOT}` from a generic `Bash` tool call — that variable is only injected when the harness runs commands defined by the plugin (commands/hooks/skill bodies), not in arbitrary subshells you spawn from elsewhere.

> **Authoritative `tm` surface.** The command table and behavior contracts in this document are the ground truth for how `tm` works. If anything you remember from an earlier session disagrees with what this file says — flag names, default behaviors, removed verbs — trust this file and treat the memory as stale. If `tm` in the script disagrees with what this file says, the script is the bug; report it. Don't reason about `tm` from prior-conversation memory or model priors; the verbs and flags listed here are exhaustive.

## Common patterns (read first)

The three patterns below cover ~95% of dispatcher `tm` use. Reach for them before composing anything else.

| Intent | One call |
|---|---|
| Send a prompt and get the reply | `tm send <repo> "..."` — sync round-trip; reply on stdout, post-turn ctx on stderr |
| Start a teammate and have it work on something | `tm spawn <repo> --prompt "..."` — atomic bootstrap |
| Wait for a turn the user / Remote Control / cron triggered | `tm wait --fresh <repo>` — passive observe, reply on stdout, ctx on stderr |
| Compact a teammate | `tm compact <repo>` — prints `compacted` on success |

Pair every one of these with `run_in_background: true` on the Bash tool call (see "Long-running waits" below) so the dispatcher stays free to dispatch other work while the harness pings you when the verb returns.

## Confirm dispatcher scope

- The user asks to push work into another repo ("派一个到 `<repo>`", "去 `<repo>` 看看 X").
- The user asks about an existing teammate ("看看 alarm 在干啥", "问问 monorepo-1 现在的 git status").
- The user asks for a scheduled / recurring local job.
- The user asks to coordinate across multiple sibling repos or maintain the dispatcher ledger/watch loop.

If the request is a normal single-repo or single-file task inside a covered sibling repo, resolve the target repo and delegate the work into that repo. This keeps repo-local instructions, git state, and tool output inside the worker context instead of mixing them into the dispatcher.

## Pick the right delegation form

Three ways to push work outward. Pick once, up front — switching mid-task is painful. Use the dispatcher's own shell for dispatcher bookkeeping (`tm`, ledger edits, cron setup); use a delegated Claude process or teammate for target repo inspection or modification.

| Form | Pick when | Skip when |
|---|---|---|
| `claude -p` headless in the target repo | One-shot repo task that can finish in a single delegated turn, including reads, small edits, or focused analysis | You need a cron / loop / wakeup; you want to keep talking to it later |
| `Agent` teammate via Agent Teams (`team_name=<...>` on the Agent tool) | Parallel work across multiple repos that needs to share a task list or message each other | You need cron firing inside the teammate; you need teammate-level `cwd`; you need session resume; you need nested sub-teams |
| `tmux` teammate (interactive `claude` in a new `tmux` pane, launched by `tm spawn`) | Long-running work that needs a real REPL, must host its own cron, or wants its own Remote Control session for the user to drive directly | Throwaway one-shot work, or anything you'd be embarrassed to keep around for hours |

Cron firing is reliable **only inside an interactive TUI REPL** (this dispatcher, or a tmux teammate launched by `tm spawn`). `claude -p` and Agent Teams teammates both return success from `CronCreate` and then silently never fire (observed empirically). Don't host cron jobs in those forms — keep them on this dispatcher (preferred) or push them into a tmux teammate.

## The `tm` script

`tm` (bundled with this plugin under `bin/tm`) is the right way to manage tmux teammates. It resolves the dispatcher directory once at invocation, in this order: **`$TM_DISPATCHER_DIR` env if set, otherwise `$PWD`**. `/claudemux:setup` writes `TM_DISPATCHER_DIR` into the dispatcher root's `.claude/settings.json` so Claude Code injects it as env at every dispatcher launch — that's what keeps `tm` correct even when the Bash tool's cwd has drifted into a sibling repo (the Bash tool persists `cd` across calls). The `$PWD` fallback exists for dispatchers set up before this feature; if `tm doctor` reports `TM_DISPATCHER_DIR: unset`, rerun `/claudemux:setup` to inoculate. **If the resolved dispatcher dir is itself a git working tree** (common when you're maintaining one of the sibling repos directly, e.g. the claudemux plugin), `tm spawn <repo>` will look for `<dispatcher-dir>/<repo>` and miss — `tm` detects this case (`.git` present in cwd) and points you at the right `cd …` invocation. The script bakes in two non-obvious tmux behaviors so you don't have to think about them: combining prompt text and `Enter` in one `tmux send-keys` call silently fails to submit (the Enter becomes a literal newline inside the input box), and multi-line prompts need a second `Enter` to submit once the input box already contains a newline.

```
tm ls                            List running teammate-<repo> sessions.
tm states                        One-line fleet snapshot: REPO, SID, BUSY,
                                 LAST (size+age of .last), PREVIEW (first 50
                                 chars of last reply). "Who's doing what"
                                 view — prefer this over fanning out
                                 tm ls + tm status per session.
tm spawn <repo> [--task <slug>] [--prompt "..."] [--no-wait]
                                 Launch a teammate inside the sibling repo
                                 (cwd = <dispatcher-dir>/<repo>, where the
                                 dispatcher dir comes from
                                 TM_DISPATCHER_DIR env or $PWD fallback).
                                 Without --prompt,
                                 returns once the REPL signals SessionStart
                                 (~2-4s warm). With --prompt "...", sleeps
                                 3s post-ready, sends the prompt, waits for
                                 Stop, and prints the first-turn reply on
                                 stdout — atomic bootstrap, ONE call. Pair
                                 with --no-wait to fire-and-forget the
                                 first prompt. --task <slug> names the
                                 conversation <repo>-<slug>; allowlist is
                                 [a-z0-9] + CJK Unified Ideographs (中日韩
                                 汉字, e.g. `--task 国际化`); other chars
                                 collapse to '-'; capped at 30 chars.
                                 Without --task a fresh spawn auto-names
                                 <repo>-<rand4>. Fresh spawns also write
                                 an empty /tmp/claude-idle/<sid>.last
                                 sentinel so 'tm last' before any reply
                                 returns a clear "no reply yet" error
                                 instead of stale content from an earlier
                                 sid.
tm send [--no-wait] [--pane-quiet] [--timeout N] <repo> <prompt...>
                                 Atomic round-trip BY DEFAULT: send prompt
                                 + wait for Stop + print reply on stdout.
                                 The dispatcher's primary verb — folds
                                 what used to be send + wait-idle + last
                                 into one call. Stdout is reply text only;
                                 status lines go to stderr (pipe-friendly).
                                 On the default (Stop-hook) path, also
                                 echoes the post-turn ctx to stderr as
                                 "ctx: N tokens · ~M next turn · X% of
                                 W (note)" — same data as `tm ctx <repo>`
                                 inline with the reply. Skipped on
                                 --pane-quiet (no fresh jsonl usage block)
                                 and --no-wait (nothing waited).
                                 --no-wait fire-and-forget (use for
                                 /clear before kill, or anywhere the
                                 reply doesn't matter). --pane-quiet
                                 falls back to pane-quiet detection
                                 (TUI-only commands: /help, /effort,
                                 /agents, permission prompts). --timeout
                                 N overrides the 600s default. Empty
                                 stdout never silently means success: a
                                 turn with no text (tool-only, /compact,
                                 /clear) prints the sentinel
                                 "(no text reply this turn — tool-only,
                                 /compact, /clear, or fresh spawn)".
tm wait <repo> [timeout=600] [--fresh] [--pane-quiet] [--timeout N]
                                 Block until the teammate's next Stop
                                 hook (or pane-quiet fallback), then
                                 print the reply on stdout — same output
                                 contract as tm send (including the
                                 stderr ctx echo on the Stop-hook path).
                                 Use when an external actor (Remote
                                 Control web UI, mobile app, cron) drove
                                 the turn and you just want to collect
                                 the result.
                                 --fresh clears the baseline up front so
                                 the NEXT Stop unblocks the wait. Use
                                 when monitoring autonomous teammate
                                 progress (no fresh tm send to reset).
                                 No-op under --pane-quiet (the "≥3s
                                 since last send" gate already provides
                                 freshness for that path).
                                 --pane-quiet falls back to pane-quiet
                                 detection (same use case as tm send);
                                 skips the ctx echo for the same reason
                                 as on tm send.
                                 --timeout N is the flag form of the
                                 positional [timeout=600]; if both are
                                 passed, whichever is parsed last wins.
tm compact <repo> [timeout=600] [--timeout N]
                                 Send /compact and verify PostCompact
                                 fired. Prints "compacted" on stdout on
                                 success (idle marker touched). Doesn't
                                 read ctx — run `tm ctx <repo>`
                                 separately, or rely on the stderr ctx
                                 echo on the next `tm send`.
                                 Default timeout 600s because large
                                 contexts (~300k+) routinely take 3-4
                                 minutes to compact.
                                 Two non-success modes, both exit 1:
                                  - Claude Code refuses with "Not
                                    enough messages to compact"
                                    (transcript too short). That error
                                    path fires no hook; the pane is
                                    scanned alongside the idle-marker
                                    poll to detect it and bail early
                                    rather than hang to timeout.
                                  - PostCompact never fires within the
                                    timeout — compaction is hung or
                                    the Stop hook is misconfigured.
tm resume <repo> [<sid>] [--task <slug>] [--prompt "..."] [--no-wait]
                                 Resume a prior conversation. PREFER
                                 passing the sid from the task ledger
                                 (active-dispatcher-tasks.md). Without
                                 sid, auto-picks the newest jsonl by
                                 mtime (warns on stderr; it's rarely the
                                 one you actually want). --prompt sends
                                 a follow-up after a 3s settle (sync by
                                 default, like tm spawn --prompt).
                                 --no-wait (only with --prompt) fires
                                 without waiting. --task relabels the
                                 resumed conversation.
tm last <repo>                   Print the teammate's last-turn reply
                                 from /tmp/claude-idle/<sid>.last. Empty
                                 or missing file dies with "no reply
                                 yet". Use when you want to re-read a
                                 reply that tm send / tm wait already
                                 printed (their output is one-shot).
tm kill <repo>                   Kill the teammate's tmux session and
                                 clean up its sid/idle/last/send-at
                                 files.
tm reload <repo>... | --all      Fan out /reload-plugins to one, many,
                                 or every teammate.
tm ctx <repo>... | --all [--window 200k|1m]
                                 Real context-window usage per teammate
                                 from the jsonl usage block (more
                                 accurate than the TUI percentage). See
                                 "Context-window usage: tm ctx" below.
tm history <repo> [<sid-or-prefix>]
                                 Inspect this repo's past Claude
                                 sessions (live or dead). No <sid> ->
                                 list mode; with <sid> or 8+ char prefix
                                 -> detail mode. See "Inspecting past
                                 sessions" below.
tm archive <id> [--status '...'] Move a finished task from the active
                                 ledger to the archive; reads the
                                 compressed outcome from stdin. See
                                 "Archiving a finished task" below.

DIAGNOSTIC (use only when the verbs above don't fit)
tm status <repo> [lines=80]      capture-pane the teammate's screen.
                                 The atomic send/wait verbs make this
                                 unnecessary for normal flow — reach
                                 for it only when you genuinely need
                                 the live pane (e.g. confirming a TUI
                                 dialog is up).
tm poll <repo> <regex> [timeout=180]
                                 Block until pane content matches a
                                 regex. Fallback when wait can't catch
                                 an interesting intermediate state.
                                 Match the EXPECTED RESULT, not the
                                 prompt you just sent.
tm doctor                        Self-check: tm path + version,
                                 TM_DISPATCHER_DIR vs $PWD, tmux,
                                 idle dir, active teammates. Read-only
                                 — reach for it when "is the env
                                 actually injected?" or "why is tm
                                 looking in the wrong place?" comes up.

HELP
tm --help / tm -h / tm help      top-level synopsis (one line per verb).
tm <verb> --help                 detailed contract for one verb. Prefer
tm help <verb>                   one of these over re-reading this whole
                                 SKILL.md when verifying a flag or output
                                 contract you're about to rely on.
```

`<repo>` is the short name of a sibling subdirectory directly under the dispatcher directory (resolved as `${TM_DISPATCHER_DIR:-$PWD}`). For example, `tm spawn my-repo` creates a session `teammate-my-repo` with cwd `<dispatcher-dir>/my-repo` and runs `claude` inside it. The teammate loads the target repo's own `CLAUDE.md` as project instructions, but `tm spawn` passes `--settings` with `claudeMdExcludes` so the dispatcher directory's `CLAUDE.md`/`CLAUDE.local.md` stay out of the teammate's upward memory walk — those are dispatcher-only and would otherwise land in the teammate as project instructions that do not apply to it.

The teammate then auto-registers its own Remote Control session — the URL appears in the startup banner (visible via `tm status <repo>`). The user can drive that teammate directly from claude.ai/code or mobile, in parallel with you.

Whenever you would manually call `tmux new-session`, `tmux send-keys`, or `tmux capture-pane` on a teammate, prefer the corresponding `tm` subcommand — it bakes in the conventions, and future fixes (e.g. richer `ls` output, structured `status`) land there once for everyone.

## When to use which verb (scenario → verb)

Match the dispatcher intent to the right verb before composing. Most
"why didn't that work?" foot-guns come from reaching for raw paths
(`/tmp/claude-idle/<sid>.last`, the jsonl files) instead of the verb
that already covers the case.

| Dispatcher intent | Verb |
|---|---|
| Send a prompt to a teammate and get the reply | `tm send <repo> "..."` |
| Re-read the reply `tm send`/`tm wait` just printed (their output is one-shot) | `tm last <repo>` |
| Start a fresh teammate AND give it a first task in one shot | `tm spawn <repo> --prompt "..."` |
| Bring up a fresh teammate but don't task it yet | `tm spawn <repo>` |
| Wait for a turn an external actor (Remote Control, mobile, cron) drove | `tm wait --fresh <repo>` |
| Wait for a TUI-only command that fires no Stop hook (`/help`, `/effort`, `/agents`, permission prompts) | `tm send --pane-quiet ...` or `tm wait --pane-quiet ...` |
| Verify an autonomous teammate task's real outcome (turn 2+ may continue after first Stop) | Check side effects directly (`git log`, MR state, ledger artifacts) — stdout from `tm send`/`tm spawn --prompt` is one settled turn, not the task end |
| See what every teammate is currently doing | `tm states` |
| Get the raw tmux session list of teammates (when you specifically want tmux row format) | `tm ls` |
| Stop a teammate and clean up its state files | `tm kill <repo>` |
| Inspect a past session for a repo (live or dead — even teammates that were killed) | `tm history <repo>` then `tm history <repo> <sid-prefix>` |
| Resume a prior conversation by sid (from the task ledger) | `tm resume <repo> <sid>` |
| Pick up the right sid when the user said "continue that thing from yesterday" but the ledger entry is missing | `tm history <repo>` (lists every jsonl with topic + age), then `tm resume <repo> <sid>` |
| Read teammate context-window usage (more accurate than the TUI percentage) | `tm ctx <repo>` or `tm ctx --all` |
| Compact a teammate's transcript | `tm compact <repo>` |
| Send `/reload-plugins` after a plugin update | `tm reload <repo>...` or `tm reload --all` |
| Verify the contract / flags of a verb you're about to use | `tm <verb> --help` (or `tm help <verb>`) |
| Sanity-check that TM_DISPATCHER_DIR / tmux / idle dir are all in good shape | `tm doctor` |
| Move a finished task from active ledger to archive | `tm archive <id>` (compressed outcome on stdin) |
| Capture the live pane (only when you genuinely need to see what's on screen — e.g. a TUI dialog) | `tm status <repo>` |
| Block until the pane matches a regex (escape hatch when `tm wait` can't catch an intermediate state) | `tm poll <repo> <regex>` — match expected result, not the prompt you just sent |

Raw files under `/tmp/claude-idle/` and the jsonl transcripts under
`~/.claude/projects/...` are escape hatches, not the default. Reach
for them only when the verb you actually want isn't in the table above
— and if that happens often, that's a missing-verb signal to surface.

## How the idle / .last machinery works (background — read once)

The two atomic verbs (`tm send`, `tm wait`) and the bootstrap (`tm spawn --prompt`) are all powered by two on-disk files per teammate:

- `/tmp/claude-idle/<sid>` — zero-byte touch, the idle signal. The plugin's `on-stop.sh` hook touches this on Stop, StopFailure, PostCompact, and SessionEnd.
- `/tmp/claude-idle/<sid>.last` — plain text of the assistant's last turn, written by `on-stop.sh` on Stop only (the other three events touch the idle marker without writing `.last`, since they don't correspond to a settled assistant turn).

The hook fires for every Claude Code session (including the dispatcher itself), but that's harmless: nothing ever waits on the dispatcher's own sid. Edits to `hooks/on-stop.sh` or `hooks/hooks.json` take effect after `/reload-plugins` — no Claude Code restart needed ([docs](https://code.claude.com/docs/en/discover-plugins.md#apply-plugin-changes-without-restarting)). After publishing a plugin change, use `tm reload --all` to fan `/reload-plugins` out to every running teammate (or `tm reload <repo>...` for specific ones); the dispatcher itself still needs the user to type `/reload-plugins` manually.

Why `.last` exists at all: `tm status` (= `tmux capture-pane`) reads the scrollback buffer, which truncates at the configured pane history limit (typically a few thousand lines). A long teammate reply gets clipped silently. `.last` is the full assistant text as recorded in the jsonl transcript — the atomic verbs and `tm last` read it instead of scraping the pane.

The bits that make multi-turn waits correct:

- On a fresh `tm spawn`, `tm` pre-generates a UUID and hands it to `claude --session-id <uuid>`. The jsonl filename equals that UUID and the sid is written to `/tmp/teammate-<repo>.sid` before spawn returns. Fresh spawn also writes a zero-byte `<sid>.last` sentinel, so `tm last` before any reply returns a clear "no reply yet" instead of stale content from an earlier sid.
- `tm send` (sync default) clears `<sid>`, `<sid>.last`, and `<sid>.busy` before sending — so the wait that follows targets THIS turn's outcome, not a leftover from a prior turn — and then blocks on the idle marker for up to `--timeout N` (default 600s) before printing `.last` on stdout.
- `tm wait` (passive observer) does the same blocking and printing, optionally with `--fresh` to clear the baseline first.
- `tm compact` sends `/compact` and blocks on the idle marker (touched by `on-stop.sh` on PostCompact) — that single signal is the whole success contract. It also scans the pane for Claude Code's "Not enough messages to compact" rejection, which fires no hook, so the verb exits 1 immediately instead of hanging to timeout.

## Long-running waits — run them in the background

**Every verb that may block longer than a couple of seconds MUST run in the background** (`Bash` tool with `run_in_background: true`). This covers `tm send` (sync default — blocks until Stop), `tm wait`, `tm spawn --prompt` (atomic bootstrap blocks until first-turn Stop), `tm resume --prompt` (same shape), `tm compact` (blocks until PostCompact, default 600s cap because large contexts take minutes), `tm poll`, and any file-polling loop you write yourself.

A foreground wait blocks the dispatcher end to end: while it sits there it cannot receive or dispatch any other task. There is no upside to foreground — the harness fires a task-notification when a background command exits, so the dispatcher gets pinged the moment the verb returns with the reply text already in its stdout.

The only `tm` calls that are safe foreground (sub-second) are: `tm ls`, `tm states`, `tm status`, `tm last`, `tm ctx`, `tm history`, `tm archive`, `tm reload`, `tm kill`, `tm send --no-wait`, `tm resume` without `--prompt`, fresh `tm spawn` without `--prompt`. Anything with an implicit or explicit wait phase goes background.

Passive observation without a fresh send — e.g. the teammate is autonomously progressing through sub-agents, cron callbacks, or follow-up turns the user kicked off via Remote Control — needs `tm wait --fresh <repo>`. Without `--fresh`, the marker from the last turn is still on disk and `wait` returns instantly. `--fresh` clears the idle/.last/.busy baseline up front so the wait targets the NEXT Stop, the same way `tm send` resets the baseline before sending.

## TUI-only commands and the `--pane-quiet` fallback

The Stop hook fires on Stop, StopFailure, PostCompact, and SessionEnd — so `/compact` and `/clear` (and API errors) all unblock the default `tm send` / `tm wait` correctly. The atomic verbs are the right answer for those paths.

The narrow case where you still need pane-quiet detection is **TUI-only slash commands and dialogs that fire NO hook at all**: `/help`, `/effort`, `/agents` opening dialogs, permission prompts. For those, pass `--pane-quiet` to either `tm send` (sends the command, then waits for the pane to settle) or `tm wait` (passive observe of pane-quiet without sending). It polls the pane and returns when the spinner has been absent for ~4s AND at least 3s have passed since the last send.

```bash
tm send --pane-quiet <repo> /help
```

Known blind spot: a permission prompt blocks claude with no spinner. `--pane-quiet` returns "ready" but the teammate is actually stuck on a y/n decision. If you suspect a prompt, follow with `tm status <repo>` to see the pane. (The `Notification` hook event with `notification_type=permission_prompt` could be bound in the future to surface this state directly; not done yet.)

## Fleet snapshot: `tm states`

When several teammates are running and you want a one-shot "who's doing what", `tm states` prints one line per teammate:

| Column | Meaning |
|---|---|
| `REPO` | short repo name (= tmux session minus the `teammate-` prefix) |
| `SID` | first 8 chars of the session id (kept fresh across `/clear` by the SessionStart hook — see below) |
| `BUSY` | `yes` if `/tmp/claude-idle/<sid>.busy` exists. The plugin's `on-busy.sh` hook touches that file on UserPromptSubmit / UserPromptExpansion / PreToolUse / PreCompact, and `on-stop.sh` removes it on Stop / StopFailure / PostCompact / SessionEnd. **Known false-negative**: purely-TUI commands (`/help`, `/effort`, `/agents` dialogs, permission prompts) fire zero hooks, so BUSY can read `no` while the pane is actually showing a blocking dialog. Use `tm status <repo>` if you need ground truth. |
| `LAST` | byte count and age of `<sid>.last` (the last-turn text written by `on-stop.sh` on Stop), or `-` if no turn has ended yet |
| `PREVIEW` | first 50 chars of `<sid>.last`, control chars stripped |

`BUSY` is a stat() of one file — cheap, no pane scraping. `LAST` and `PREVIEW` come from the Stop hook artifacts. The three together answer "is anyone working right now?" and "what did each teammate last say?" without scraping each pane individually.

### Context-window usage: `tm ctx`

To know how full a teammate's context window is, use `tm ctx <repo>` (or `tm ctx --all`). It reads the teammate's session transcript and reports the real prompt size — do not rely on the TUI status-bar percentage, which is approximate and absent in many environments.

`tm ctx` reports the most recent assistant turn's prompt size (`input_tokens` + `cache_creation_input_tokens` + `cache_read_input_tokens`), a next-turn estimate (plus that turn's `output_tokens`), and the percentage of the context window. The window size is not recorded in the transcript: a peak usage above ~210k proves a 1M window, otherwise `tm ctx` assumes 200k and labels it `assumed 200k`. Pass `--window 200k|1m` when you know the window and the heuristic can't yet tell.

### Inspecting past sessions: `tm history`

When you need to know what Claude sessions a repo has accumulated — including ones whose teammate has been killed, ones never recorded in the task ledger, or just to pick the right `sid` for `tm resume` — use `tm history`.

`tm history <repo>` prints a newest-first table of every `*.jsonl` under that repo's project directory: `SID` (8 chars), `AGE` (relative mtime), `SIZE`, and `TOPIC` (first user prompt, truncated to 60 chars). A leading `*` marks the row whose sid matches the current live teammate (`/tmp/teammate-<repo>.sid`). Use this list to pick a session before resuming.

`tm history <repo> <sid-or-prefix>` (an 8+ character prefix is fine; ambiguous prefixes are rejected with the candidate list) prints a single session's detail: full sid, jsonl path / size / line count, created and last-seen timestamps, ctx usage (same calculation as `tm ctx`), the first user prompt in full, the last assistant text up to 1500 characters (with a truncation note pointing to the jsonl), and a ready-to-paste `tm resume <repo> <full-sid>` line.

Boundary with neighbouring commands:
- `tm last <repo>` is current-live-teammate only — it reads the in-memory hook file `/tmp/claude-idle/<sid>.last`. `tm history` covers any jsonl on disk, including killed sessions.
- `tm resume <repo>` mutates state (starts a process, claims the tmux session). `tm history` is read-only; it only suggests the resume command in its detail output.

### Spawn readiness and `/clear` sid rotation

`tm spawn` blocks (≤ 18 s) until `on-session-start.sh` touches `/tmp/teammate-<repo>.ready`, so the REPL is usable the moment `tm spawn` returns. The same hook keeps `/tmp/teammate-<repo>.sid` in sync when `/clear` or interactive `/resume` rotates the underlying `session_id`, gated by env identity (`CLAUDEMUX_TEAMMATE_REPO`) **plus** recorded-cwd byte match — so the dispatcher's own SessionStart events can't hijack a teammate's `.sid`. The full mechanism, the edge case where dispatcher cwd byte-equals a recorded `teammate.cwd`, and the debugging checklist live in `references/sid-rotation.md`. Read that only when `.sid` looks wrong; normal dispatcher work doesn't need it.

## Agent Teams teammates (rare path)

`tm spawn` is the default. Reach for Agent Teams only when you genuinely need a shared task list or peer SendMessage across multiple teammates. The spawn-prompt checklist (especially the explicit-cwd workaround — Agent Teams teammates inherit the dispatcher's cwd and cannot be reassigned at spawn time), the hard SendMessage requirement, and the idle-notification noise filter live in `references/agent-teams.md`. Read that file before spawning your first Agent Teams teammate; skip it otherwise.

## Cron host rule

This dispatcher is the only reliable host for `CronCreate` on this machine. The scheduler ticks only inside an interactive TUI REPL — not inside `claude -p`, not inside Agent Teams teammates (both observed to empty-fire).

Implications:

- Place periodic work here. If the work itself belongs to a specific repo, the callback prompt can dispatch outward (Bash into the repo, `claude -p`, `tm send`, or spawn a fresh Agent teammate).
- Jobs fire only while you are **idle** (not mid-query). Ongoing conversation delays firing.
- Jobs are session-only by default and die when this dispatcher process dies (`tmux kill-session dispatcher`, terminal close while not detached, Mac reboot).
- Recurring jobs auto-expire after 7 days.
- For approximate times, pick an off-minute (e.g. `7 * * * *`, not `0 * * * *`) — the platform-wide fleet aliases on `:00` and `:30`.

## Common foot-guns

- **Bash tool persists `cd` across calls.** Claude Code's Bash tool keeps the shell working directory between invocations, so `cd <sibling-repo> && git status` taints every subsequent Bash call until you `cd` back. Without `TM_DISPATCHER_DIR` set, that drift also corrupts everything `tm` derives from `$PWD` — repo paths, the AutoMemory ledger location, ctx/history project-dir encodings. With the env set by `/claudemux:setup`, `tm` itself stays correct; but other dispatcher Bash work (`grep` across siblings, ledger reads, raw `git log`) still sees the drifted cwd. Discipline: prefer **`git -C <repo> <cmd>`** for per-repo inspection, or **`(cd <repo> && <cmd>)`** as a subshell so the parent shell's PWD never moves. Use `tm doctor` to confirm `TM_DISPATCHER_DIR` is set; if it isn't, rerun `/claudemux:setup`.
- `tmux send-keys -t <s> '<prompt>' Enter` silently doesn't submit — the Enter becomes a newline. Use `tm send` or two separate calls.
- **Multi-line prompts** in Claude Code's TUI need a *second* `Enter`. Once the input box contains any `\n`, the first `Enter` is consumed as "insert newline at cursor" and only the next `Enter` (on the now-empty trailing line) actually submits. `tm send` detects newlines in the prompt and sends the second Enter automatically — but if you ever drop to raw `tmux send-keys`, you have to mirror that yourself.
- Polling with a `grep` whose pattern appears in the *prompt you just sent* makes the wait return instantly. Match against expected *result* keywords (e.g. `Scheduled`, `Cancelled`, `error`), not prompt echoes.
- Polling for "is the teammate done?" with regex — fragile across tasks. Use the atomic `tm send` (which already waits) or `tm wait --fresh` (for passive observation) instead; both read a hook-driven signal file.
- Composing the old `send + wait-idle + last` ritual when `tm send` already does all three atomically. The wait baseline and idle marker are internal to `tm send` now; stdout is the reply text. Reaching for the old ritual fights the design.
- Reading `/tmp/claude-idle/<sid>` directly to check "done" — `tm send` rm's the marker before sending, so an old completed turn won't be visible there. That's by design; use `tm wait` (which polls the same file and is what `tm send` itself uses internally).
- Calling `tm send <repo> /compact` and expecting useful stdout: PostCompact fires the idle marker but produces no `.last` text, so stdout is just the "(no text reply this turn)" sentinel. Prefer `tm compact <repo>` — it also catches the "Not enough messages to compact" error path (which fires no hook and would otherwise hang `tm send` to timeout) by scanning the pane, and prints a clean `compacted` line. `tm compact` deliberately does NOT echo ctx — the post-compact size is best read separately via `tm ctx <repo>` once you want it.
- Using `tm spawn <repo>` then a separate `tm send <repo> "..."` for bootstrap when `tm spawn <repo> --prompt "..."` does both in one atomic call (and returns the first-turn reply on stdout).
- Long `sleep` chains are blocked by the harness sandbox. For "wait until X", use `until <check>; do sleep 4; done` with a time-bounded outer loop — and that loop, like every wait, MUST run with `run_in_background: true` (see "Every long-running wait MUST run in the background" above). A foreground wait blocks the dispatcher from receiving or dispatching anything else for its whole duration.
- Spawning a teammate or `claude -p` just to host a cron job — cron will not fire there, the job creation looks successful, you will only find out by missing the trigger time. Host cron on this dispatcher.
- `grep` / `find` across the dispatcher directory (your `$PWD`) mixes unrelated repos into the dispatcher context. Resolve the target repo, then ask the repo-local worker to search there.
- The auto-mode classifier blocks the dispatcher from editing its **own** `settings.local.json` to grant itself new tool permissions (flagged as "Self-Modification"). Hand the user a minimal JSON snippet to merge into `~/.claude/settings.local.json`, or point them at `/permissions` to do it interactively. Example snippet (merge with whatever's already there):

  ```json
  { "permissions": { "allow": ["Bash(<command>:*)"] } }
  ```
- The `/hooks` slash-command UI only surfaces tool-related hooks (PreToolUse / PostToolUse / etc.) — `Stop` hooks do **not** appear in that menu, but they still fire. Don't conclude "hook missing" from the `/hooks` UI alone; check `~/.claude/settings.json` directly and watch for the signal file (`/tmp/claude-idle/<jsonl-uuid>`).

## Local dispatcher notes

User-specific notes accumulated by `/claudemux:optimize` live in `.claude/local-dispatcher-notes.md` under the dispatcher directory. At the start of a dispatcher session, check whether that file exists and Read it if so — it holds user-owned dispatcher conventions you need in context before routing any work. It's user-owned and survives plugin upgrades: anything that would be lost on a plugin update is written here, not into the plugin-shipped skill body.

## Task ledger (use AutoMemory)

The ledger is two files in this project's AutoMemory directory (Claude Code
derives it from your `$PWD`; the resolved path is
`~/.claude/projects/<encoded-cwd>/memory/`, where `<encoded-cwd>` is `$PWD`
with `/` and `.` both replaced by `-`; the `MEMORY.md` index in the same
folder lists both):

- `active-dispatcher-tasks.md` — only in-flight tasks, one `## Active` section.
  Small by construction. **Read it on boot**, before any cross-task decision,
  and whenever the user asks "what's running" / "看看现在在跑啥".
- `dispatcher-tasks-archive.md` — closed tasks, compressed. **Never read on
  boot.** Read it on demand only — when the user asks about a past task or you
  need history to make a decision.

If either file doesn't exist yet, create it from the shape below.

### Active entries

When you spawn delegated repo work (`claude -p`, Agent teammate, or `tm spawn`),
append an entry to the `## Active` section. An active entry is working memory:
keep whatever you need to resume the task — root-cause notes, option menus,
resume instructions all belong here while the task is in flight. Required fields:

| Field | How to obtain |
|---|---|
| `id` | `t-<YYYYMMDD-HHMM>-<short-tag>` — short-tag is a 1-2 word slug of the intent |
| `repo` | the repo's absolute path (a sibling subdirectory under your `$PWD`) |
| `branch` | `git -C <repo> branch --show-current` at spawn time |
| `teammate` | tmux session name (`teammate-<repo>`) for tmux teammates; `<agent_id>@<team>` for Agent Teams teammates; short PID or none for `claude -p` |
| `sid` | the teammate's claude session id (for tmux teammates: `cat /tmp/teammate-<repo>.sid`; for Agent Teams: not applicable). This is the field `tm resume <repo> <sid>` consumes when you come back to the task in a future dispatcher session — record it at spawn time, not after the teammate has died. |
| `intent` | one short line — what the user actually asked for |
| `artifacts` | URLs to any Dev Task / MR / Feishu doc as they appear (start empty, fill later) |
| `watch` | `CronCreate` job id polling this task's artifacts, or `none` |
| `last_checked` | timestamp of last poll, or `never` |
| `created` | timestamp at spawn |

### Archiving a finished task

When the work hits a terminal state (MR merged / Dev Task closed / explicit
"done" / teammate killed):

1. If the entry has a `watch` cron job, `CronDelete` it first.
2. Compose the **outcome** — one or two lines: the conclusion plus key
   artifacts (commit SHAs, MR URL, Dev Task URL). This is the only part that
   needs your judgment; everything else is copied or stamped mechanically.
3. Run `tm archive <id>` with that outcome on stdin:

   ```
   echo "<outcome text>" | tm archive t-20260515-1430-foo
   ```

   `tm archive` copies `repo` / `branch` / `intent` verbatim from the active
   entry, stamps today's date as `closed`, and carries over the active
   header's `[status]` tag — pass `--status '<tag>'` to change it (e.g. a
   task that was `[PAUSED]` and is now `done`). It prepends the compressed
   entry to the top of `dispatcher-tasks-archive.md` (newest first; creates
   that file from its shape if it doesn't exist), then deletes the full entry
   from `active-dispatcher-tasks.md`.

An archive entry is a pointer plus a conclusion, not a knowledge store. The
deep analysis lives on the task's branch, commit messages, and tracker record —
the archive entry just points there. If some analysis is durably reusable
knowledge (not task-specific), promote it to its own `project` or `feedback`
memory file instead of leaving it in the archive.

The markdown files *are* the system — no database. `tm archive` handles the
mechanical move; for everything else (reading the ledger, fixing a field,
editing active entries) Read + Edit them like any other text.

## Auto-watch MR / CI / review

When a spawned task produces a Dev Task or MR, set up a recurring `CronCreate`
on this dispatcher (not in the teammate — cron does not fire there). Use the
`bits-devops` skill for the actual status fetch.

Loop shape:

1. After artifact URLs land in the ledger, pick a cadence — default `*/30 * * * *`
   for active MRs, hourly once the work moves to "awaiting review", off entirely
   when merged or abandoned. Avoid `:00` / `:30` minutes.
2. `CronCreate` a recurring callback. The callback prompt should:
   - Read the ledger.
   - For each row with `watch != none`, fetch CI / review status via the `bits-devops` skill against the recorded MR / Dev Task URL.
   - On **CI failure**: `tm send <repo>` (or SendMessage to the Agent teammate) with the failing job link and the failure summary, asking the teammate to fix. If no teammate is alive for that row, alert the user instead.
   - On **review comments**: same pattern — relay the reviewer comment text plus the file/line to the teammate.
   - Update `last_checked` in the ledger row.
3. Record the cron job id back into the row's `watch` field so the watch can be torn down later (`CronDelete <id>`).
4. When the task hits a terminal state (merged / closed / abandoned), `CronDelete` the watch and archive the task (compress + move to `dispatcher-tasks-archive.md`, see "Archiving a finished task" above).

The dispatcher idle-only firing rule still applies — long human conversation with you delays the watch tick. That is acceptable; CI / review state does not need second-level freshness.
