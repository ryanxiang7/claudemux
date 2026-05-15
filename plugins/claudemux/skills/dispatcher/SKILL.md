---
name: dispatcher
description: Manage dispatcher-style coordination across sibling git repos from a parent workspace. Use when the user asks to spawn, dispatch, message, resume, inspect teammate state, or kill a teammate; coordinate work across multiple sibling repos; check what teammates are doing; host or manage local scheduled work; or maintain the dispatcher task ledger/watch loop. Also use when the user names dispatcher concepts such as "派一个 / 派活 / 派 teammate / 派 X 去 / 看看 X 在干啥 / 问问 X / dispatcher / 多仓 / 跨仓 / orchestrator".
user-invocable: false
---

# Dispatcher: multi-repo Claude orchestrator

Use this skill as the operations manual for dispatcher-style work from a parent directory of sibling git repos: `tm`, teammate delegation, wait/readback, cron hosting, Agent Teams caveats, and the task ledger. The dispatcher routes target repo work to a repo-local Claude process or teammate, then waits, reads back, updates the ledger, and reports the result. Start by resolving the target sibling repo and choosing one delegation form; load diagnostic references only when the normal flow does not fit.

> **`tm` is the helper script** bundled with this plugin. Examples below call it as bare `tm`. Claude Code auto-prepends each installed plugin's `bin/` directory to `PATH`, so `which tm` resolves inside any Bash subshell of an interactive Claude Code session. If for some reason `tm` is not on `PATH` (e.g. a shell that doesn't inherit Claude Code's env), use the absolute install path: `~/.claude/plugins/cache/claudemux/claudemux/<version>/bin/tm`. **Do not** rely on `${CLAUDE_PLUGIN_ROOT}` from a generic `Bash` tool call — that variable is only injected when the harness runs commands defined by the plugin (commands/hooks/skill bodies), not in arbitrary subshells you spawn from elsewhere.

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

`tm` (bundled with this plugin under `bin/tm`) is the right way to manage tmux teammates. It treats `$PWD` as the dispatcher directory — there is no config file, no env override. Run it from the dispatcher's own claude session (whose cwd is the dispatcher dir by construction); invoking it from anywhere else fails loudly. **If the dispatcher's cwd is itself a git working tree** (common when you're maintaining one of the sibling repos directly, e.g. the claudemux plugin), `tm spawn <repo>` will look for `$PWD/<repo>` and miss — `tm` detects this case (`.git` present in cwd) and points you at the right `cd …` invocation. `cd` up to the sibling-parent first, or run `tm` from the actual dispatcher tmux session. The script bakes in two non-obvious tmux behaviors so you don't have to think about them: combining prompt text and `Enter` in one `tmux send-keys` call silently fails to submit (the Enter becomes a literal newline inside the input box), and multi-line prompts need a second `Enter` to submit once the input box already contains a newline.

```
tm ls                            list all teammate sessions (sessions named teammate-<repo>)
tm states                        one-line-per-teammate fleet snapshot: REPO, SID, BUSY,
                                 LAST (size+age of .last), PREVIEW (first 50 chars of .last).
                                 The "what's everyone doing" view — prefer this over running
                                 tm ls + tm status across each session.
tm spawn <repo> [--task <slug>] [--resume <sid>]
                                 launch a teammate inside the sibling repo (cwd = $PWD/<repo>).
                                 --resume <sid> picks up an existing session by jsonl-UUID.
                                 --task <slug> sets the claude conversation display name
                                 (prompt box / /resume picker / terminal title) to
                                 <repo>-<slug>. Slug accepts [a-z0-9] + CJK Unified
                                 Ideographs (中日韩汉字, e.g. `--task 国际化`); other
                                 characters collapse to '-'; capped at 30 chars.
                                 Without --task a fresh spawn auto-names <repo>-<rand4>,
                                 and a --resume without --task keeps the resumed session's
                                 existing name. The chosen name is also echoed in the
                                 spawn stdout (`name=<repo>-<slug>`).
tm status <repo> [lines=80]      capture-pane the teammate's screen (defaults to last 80 lines)
tm send <repo> <prompt...>       send a prompt + Enter (handles the dual-send and
                                 multi-line submit quirk); clears the idle/last baseline
                                 and touches /tmp/teammate-<repo>.send-at for wait-quiet
tm ask [--quiet] [--timeout=N] <repo> <prompt...>
                                 send + wait + cat .last in one shot. Default uses
                                 wait-idle; pass --quiet to use wait-quiet (for /compact
                                 and other non-turn-end paths). Reply on stdout (pipe-
                                 friendly); diagnostics on stderr. Exit non-zero on
                                 timeout, with whatever partial .last exists.
tm resume <repo> [<sid>] [--prompt "..."] [--task <slug>]
                                 resume a prior conversation. PREFER passing the sid
                                 from the task ledger (active-dispatcher-tasks.md). Without
                                 sid, auto-picks the newest jsonl by mtime (warns on stderr,
                                 since that's rarely the one you actually wanted).
                                 Optional --prompt sends a follow-up after resume.
                                 Optional --task relabels the resumed conversation to
                                 <repo>-<slug> (otherwise the existing name carries over).
tm wait-idle [--fresh] <repo> [timeout=600]
                                 block until any of Stop / StopFailure / PostCompact /
                                 SessionEnd fires (the idle-marker file appears).
                                 Prints the path of the <sid>.last file on hit
                                 (which is meaningful only after Stop).
                                 --fresh first clears the idle/last/busy baseline so
                                 the wait targets the NEXT turn boundary, not any
                                 already-recorded one. Reach for it when you're
                                 monitoring autonomous teammate progress without a
                                 fresh `tm send` (which already resets the baseline).
tm wait-quiet <repo> [timeout=600]
                                 block until the pane shows no spinner for ~4s
                                 (and at least 3s have passed since the last send).
                                 Reserve for TUI-only commands that fire NO hook
                                 (/help, /effort dialogs, permission prompts).
tm last <repo>                   cat the assistant's last-turn full text (written by
                                 the Stop hook). Use this instead of 'tm status' when
                                 you need the full reply — tmux scrollback truncates.
tm kill <repo>                   tmux kill-session the teammate and clean up its sid/idle/last/send-at files
tm reload <repo>... | --all      fan out /reload-plugins to one, many, or every teammate
tm poll <repo> <regex> [timeout=180]
                                 block until pane content matches the regex
tm archive <id> [--status '...'] move a finished task from the active ledger to the
                                 archive; reads the compressed outcome from stdin
                                 (see "Archiving a finished task" below)
tm ctx <repo>... | --all [--window 200k|1m]
                                 report a teammate's real context-window usage from
                                 its session transcript (see "Fleet snapshot" below)
```

`<repo>` is the short name of a sibling subdirectory (under your `$PWD`). For example, `tm spawn my-repo` creates a session `teammate-my-repo` with cwd `$PWD/my-repo` and runs `claude` inside it. The teammate loads the target repo's own `CLAUDE.md` as project instructions, but `tm spawn` passes `--settings` with `claudeMdExcludes` so the dispatcher directory's `CLAUDE.md`/`CLAUDE.local.md` stay out of the teammate's upward memory walk — those are dispatcher-only and would otherwise land in the teammate as project instructions that do not apply to it.

The teammate then auto-registers its own Remote Control session — the URL appears in the startup banner (visible via `tm status <repo>`). The user can drive that teammate directly from claude.ai/code or mobile, in parallel with you.

Whenever you would manually call `tmux new-session`, `tmux send-keys`, or `tmux capture-pane` on a teammate, prefer the corresponding `tm` subcommand — it bakes in the conventions, and future fixes (e.g. richer `ls` output, structured `status`) land there once for everyone.

## Knowing when a teammate is done (`tm wait-idle`) and reading the reply (`tm last`)

Every Claude session goes through a Stop event at the end of each turn — the plugin's Stop hook (`hooks/on-stop.sh`, registered via `hooks/hooks.json`) listens for it and writes two files keyed by the session id:

- `/tmp/claude-idle/<sid>` — zero-byte touch, the wait-idle signal.
- `/tmp/claude-idle/<sid>.last` — plain text of the assistant's last turn (concatenated `text` content blocks since the most recent real user message; tool calls and `thinking` blocks are excluded since they aren't part of the visible reply).

The hook fires for every Claude Code session (including the dispatcher itself), but that's harmless: nothing ever `wait-idle`s on the dispatcher's own sid. Edits to `hooks/on-stop.sh` or `hooks/hooks.json` take effect after `/reload-plugins` — no Claude Code restart needed ([docs](https://code.claude.com/docs/en/discover-plugins.md#apply-plugin-changes-without-restarting)). After publishing a plugin change, use `tm reload --all` to fan `/reload-plugins` out to every running teammate (or `tm reload <repo>...` for specific ones); the dispatcher itself still needs the user to type `/reload-plugins` manually.

Why `.last` exists at all: `tm status` (= `tmux capture-pane`) reads the scrollback buffer, which truncates at the configured pane history limit (typically a few thousand lines). A long teammate reply gets clipped silently. `.last` is the full assistant text as recorded in the jsonl transcript — the dispatcher can `tm last <repo>` (or `Read` the file path directly) to get the complete reply, no scraping, no jsonl parsing.

`tm` plumbs this into a wait primitive:

1. On `tm spawn <repo>` (fresh), `tm` pre-generates a UUID and hands it to `claude --session-id <uuid>`. The jsonl filename equals that UUID, and the sid is written to `/tmp/teammate-<repo>.sid` *before* the spawn returns. No jsonl scanning, no race window — `tm wait-idle` is usable immediately after spawn, without needing a prior `tm send`.
2. On `tm spawn <repo> --resume <sid>`, the sid is given by the caller and written the same way.
3. `tm send` rm's `/tmp/claude-idle/<sid>`, `<sid>.last`, AND `<sid>.busy` before sending, so a previous turn's files don't satisfy the next `tm wait-idle` / `tm last` / `tm states`. This is the bit that makes multi-turn waits correct.
4. `tm wait-idle <repo> [timeout=600]` blocks until `/tmp/claude-idle/<sid>` exists. It polls every ~3s, prints `idle: <sid>` + the `.last` path (with byte count) on hit, exits non-zero on timeout.
5. `tm last <repo>` cats `<sid>.last` — the full assistant reply for the latest turn. Empty file means the assistant ended the turn without text output (e.g. it only ran tools); fall back to `tm status` in that case.

Recommended pattern when delegating substantive work:

```bash
tm send <repo> '<prompt>'
tm wait-idle <repo> 1800   # 30-minute cap; prints the .last path on hit
tm last <repo>             # full assistant reply; no scrollback truncation
```

Use `tm last` for the full text. Reserve `tm status` for cases where you specifically want to see the live screen (e.g. progress on a long-running tool, or to confirm the teammate is at the input prompt) — its tmux scrollback buffer truncates and is not a substitute for `tm last`.

**Every long-running wait MUST run in the background** (Bash with `run_in_background: true`) — this covers `tm wait-idle`, `tm wait-quiet`, `tm poll`, file-polling loops, and any other watcher. A foreground wait blocks the dispatcher end to end: while it sits there it cannot receive or dispatch any other task. There is no upside to running it in the foreground — the harness fires a task-notification when a background command exits, so the dispatcher gets pinged the moment the wait returns, with no context burned on a wakeup chain.

Passive monitoring without a fresh `tm send` — e.g. the teammate is autonomously progressing through sub-agents, cron callbacks, or follow-up turns the user kicked off elsewhere — needs `tm wait-idle --fresh <repo>`. Without `--fresh`, the marker from the last turn is still on disk and `wait-idle` returns instantly. `--fresh` clears the idle / `.last` / `.busy` baseline up front so the wait targets the NEXT Stop, the same way `tm send` resets the baseline before sending.

When the idle-hook signal doesn't fit (waiting for some intermediate screen state, not turn-end), fall back to `tm poll <repo> <regex>` — but for "wait until teammate is done with a normal turn", `wait-idle` is the right answer.

## When the Stop hook isn't enough: `tm wait-quiet`

`tm wait-idle` blocks on the idle marker that `on-stop.sh` touches. Since this plugin binds `on-stop.sh` to **four** events — Stop, StopFailure, PostCompact, SessionEnd — the cases that used to hang `wait-idle` (`/compact` not firing Stop, API errors not firing Stop) now wake it up correctly. Use `wait-idle` as the default everywhere.

`tm wait-quiet <repo>` remains for **TUI-only commands that fire no hook at all** — `/help`, `/effort`, `/agents` opening dialogs, permission prompts. These leave the pane in a non-idle state without triggering any of the eight transition events; only pane inspection can tell you the teammate is "stuck on something the dispatcher doesn't model". `wait-quiet` polls the pane and returns when the model spinner has been absent for ~4 seconds AND at least 3 seconds have passed since the last `tm send`.

```bash
tm send <repo> '/help'
tm wait-quiet <repo> 30
```

Known blind spot: a permission prompt blocks claude with no spinner. `wait-quiet` will return "ready" but the teammate is actually stuck on a y/n decision. If you suspect a prompt, follow with `tm status <repo>` to see the pane. (The `Notification` hook event with `notification_type=permission_prompt` could be bound in the future to surface this state directly; not done yet.)

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

- `tmux send-keys -t <s> '<prompt>' Enter` silently doesn't submit — the Enter becomes a newline. Use `tm send` or two separate calls.
- **Multi-line prompts** in Claude Code's TUI need a *second* `Enter`. Once the input box contains any `\n`, the first `Enter` is consumed as "insert newline at cursor" and only the next `Enter` (on the now-empty trailing line) actually submits. `tm send` detects newlines in the prompt and sends the second Enter automatically — but if you ever drop to raw `tmux send-keys`, you have to mirror that yourself.
- Polling with a `grep` whose pattern appears in the *prompt you just sent* makes the wait return instantly. Match against expected *result* keywords (e.g. `Scheduled`, `Cancelled`, `error`), not prompt echoes.
- Polling for "is the teammate done?" with regex — fragile across tasks. Use `tm wait-idle` instead; it reads a hook-driven signal file that exists for every teammate.
- Forgetting that `tm send` resets the idle baseline — if you `tm send` then read `/tmp/claude-idle/<sid>` directly to check "done", you'll find no file even for old completed turns. That's by design; wait via `tm wait-idle`.
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
