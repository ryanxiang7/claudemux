---
name: dispatcher
description: Manage a multi-repo dispatcher session — Claude Code running in the parent directory of several local git repos, used to coordinate work across them. Bundles the `tm` helper script for tmux-teammate operations (ls / spawn / status / send / kill / poll) and codifies the spawn-and-comms protocol so you don't re-derive it. Trigger this skill whenever the user asks to spawn / dispatch / kill / message a teammate, mentions "派一个 / 派活 / 派 teammate / 派 X 去 / 看看 X 在干啥 / 问问 X / dispatcher / 多仓 / 跨仓 / orchestrator", schedules a recurring task on this machine, wants to coordinate work across sibling repos, or interacts from the top-level dispatcher directory itself rather than from any specific repo. Use even when the user does not name the skill — these workflows touch Agent Teams limits, tmux teammate protocol, and local cron-host constraints that are easy to get wrong in one shot.
---

# Dispatcher: multi-repo Claude orchestrator

You are running as the **dispatcher** in `$DEV_DIR` — the parent directory of several sibling git repos — typically inside a `tmux` session named `dispatcher` with Claude Code Remote Control active. Throughout this skill, `$DEV_DIR` refers to that directory: Claude Code's startup banner shows it as the "Primary working directory", and `pwd` returns it. The top-level `CLAUDE.md` in `$DEV_DIR` states your identity, goals, and the hard "don't"s — read it if it isn't already in context. This skill is the *operations* manual that goes with that policy.

> **`$DEV_DIR` is a documentation placeholder, not a shell environment variable.** When you generate a `Bash` call from any example below, substitute the actual absolute path. Pasting `$DEV_DIR` literally into a shell command resolves it to the empty string and breaks the command.

> **`tm` is the helper script** bundled with this plugin. Examples below call it as bare `tm`. Claude Code auto-prepends each installed plugin's `bin/` directory to `PATH`, and claudemux ships a `bin/tm` wrapper, so `which tm` should resolve inside any Bash subshell of an interactive Claude Code session — no symlink step required.
>
> If for some reason `tm` is not on `PATH` (e.g. you're calling from a shell that doesn't inherit Claude Code's env), use the absolute install path instead: `~/.claude/plugins/cache/claudemux/claudemux/<version>/bin/tm`. **Do not** rely on `${CLAUDE_PLUGIN_ROOT}` from a generic `Bash` tool call — that variable is only injected when the harness runs commands defined by the plugin (commands/hooks), not in arbitrary subshells you spawn.

## When this skill is doing useful work

- The user asks to push work into another repo ("派一个到 `<repo>`", "去 `<repo>` 看看 X").
- The user asks about an existing teammate ("看看 alarm 在干啥", "问问 monorepo-1 现在的 git status").
- The user asks for a scheduled / recurring local job.
- The user is operating from this directory rather than from any specific sibling repo.

When the user is clearly inside one specific repo (terminal cwd is that repo, request is about that repo only), defer to the project-level skill for that repo instead.

## Pick the right delegation form

Three ways to push work outward. Pick once, up front — switching mid-task is painful.

| Form | Pick when | Skip when |
|---|---|---|
| Inline `Bash` in the target repo (`cd "$DEV_DIR/<repo>" && …`) | One-shot read or trivial change, output fits in this turn | Anything that should produce its own conversation, run a model loop, or persist beyond one turn |
| `claude -p` headless in the target repo | One-shot task that needs a full `claude` turn (code edit, multi-tool reasoning) but is still fire-and-forget | You need a cron / loop / wakeup; you want to keep talking to it later |
| `Agent` teammate via Agent Teams (`team_name=<...>` on the Agent tool) | Parallel work across multiple repos that needs to share a task list or message each other | You need cron firing inside the teammate; you need teammate-level `cwd`; you need session resume; you need nested sub-teams |
| `tmux` teammate (interactive `claude` in a new `tmux` pane, launched by `tm spawn`) | Long-running work that needs a real REPL, must host its own cron, or wants its own Remote Control session for the user to drive directly | Throwaway one-shot work, or anything you'd be embarrassed to keep around for hours |

Cron firing is reliable **only inside an interactive TUI REPL** (this dispatcher, or a tmux teammate launched by `tm spawn`). `claude -p` and Agent Teams teammates both return success from `CronCreate` and then silently never fire (observed empirically). Don't host cron jobs in those forms — keep them on this dispatcher (preferred) or push them into a tmux teammate.

## The `tm` script

`tm` (bundled with this plugin under `skills/dispatcher/scripts/tm`) is the right way to manage tmux teammates. It treats `$PWD` as the dispatcher directory — there is no config file, no env override. Run it from the dispatcher's own claude session (whose cwd is the dispatcher dir by construction); invoking it from anywhere else fails loudly with "repo not found". The script encodes the corrections this dispatcher had to learn the hard way, especially the *two-step Enter* (combining prompt text and `Enter` in one `tmux send-keys` call silently fails to submit the prompt — the Enter becomes a literal newline inside the input box).

```
tm ls                            list all teammate sessions (sessions named teammate-<repo>)
tm states                        one-line-per-teammate fleet snapshot: REPO, SID, BUSY,
                                 LAST (size+age of .last), PREVIEW (first 50 chars of .last).
                                 The "what's everyone doing" view — prefer this over running
                                 tm ls + tm status across each session.
tm spawn <repo> [--resume <sid>] launch a teammate in $DEV_DIR/<repo>;
                                 --resume <sid> picks up an existing session by jsonl-UUID
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
tm resume <repo> [<sid>] [--prompt "..."]
                                 resume a prior conversation. PREFER passing the sid
                                 from the task ledger (active-dispatcher-tasks.md). Without
                                 sid, auto-picks the newest jsonl by mtime (warns on stderr,
                                 since that's rarely the one you actually wanted).
                                 Optional --prompt sends a follow-up after resume.
tm wait-idle <repo> [timeout=600]
                                 block until any of Stop / StopFailure / PostCompact /
                                 SessionEnd fires (the idle-marker file appears).
                                 Prints the path of the <sid>.last file on hit
                                 (which is meaningful only after Stop).
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
```

`<repo>` is the short name (a directory under `$DEV_DIR`). For example, `tm spawn my-repo` creates a session `teammate-my-repo` with cwd `$DEV_DIR/my-repo` and runs `claude` inside it.

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

Run `tm wait-idle` in the background (Bash with `run_in_background: true`) — the harness's task-notification fires when it exits, so the dispatcher gets pinged the moment the teammate goes idle without burning context on a wakeup chain.

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

### Spawn readiness

`tm spawn` no longer relies on a fixed `sleep` before the REPL is usable. It pre-removes `/tmp/teammate-<repo>.ready`, launches `tmux`+`claude`, then polls that file (60 × 0.3 s = 18 s cap). The SessionStart hook touches the file the moment the new claude session signals start — typically 2–4 s on a warm Mac — and the poll returns. On timeout, spawn prints a `WARN` and returns anyway so the caller can probe with `tm send` and get a real error if claude failed to boot. The file is per-repo (not per-sid) and lives outside the `/tmp/claude-idle/` namespace.

### `/clear` and sid rotation

`/clear` retires the current `session_id` and starts a fresh one. Without help, `/tmp/teammate-<repo>.sid` would still point at the dead sid and every subsequent `tm states / last / wait-idle` would consult orphan files. The `on-session-start.sh` hook handles this by recording each teammate's physical cwd at spawn time into `/tmp/teammate-<repo>.cwd`, then on every `SessionStart` event it iterates those files and looks for one whose content byte-equals the firing claude's cwd. On a hit, it overwrites `/tmp/teammate-<repo>.sid` with the new sid (handles `/clear` and interactive `/resume`) and touches `/tmp/teammate-<repo>.ready` (the spawn-readiness signal). `source=startup|compact|resume` with unchanged sid is a quiet no-op for the rotation step; readiness is touched regardless. All sid rotations are logged to `/tmp/claudemux-sid-changes.log` for audit.

The byte-match-against-recorded-cwd safety check is strictly stronger than a "same parent dir" prefix check: a stray `cd packages/foo && claude` inside a teammate repo doesn't match the teammate's recorded cwd, so it cannot hijack the sid pointer. The dispatcher's own cwd (no `.cwd` file maps to it) is naturally skipped too. This is also why there is no `$DEV_DIR` env var or config file anywhere in the plugin: the only path-comparison the runtime ever needs is "is this cwd one of the recorded teammate cwds", and that's purely a filesystem lookup against `/tmp/teammate-*.cwd`.

## Spawning an Agent Teams teammate

Use the `Agent` tool with `team_name=<existing-team>` and `name=<teammate-name>`. The spawn prompt **must** include three things or the teammate will silently misbehave:

1. **Explicit working directory.** Teammate `cwd` inherits this dispatcher's (`$DEV_DIR`) and cannot be set at spawn time. Write into the prompt: ``Your working directory is `$DEV_DIR/<repo>`; cd there before doing anything else.`` (Use the actual absolute path in the prompt — the teammate runs without this skill in context and won't expand `$DEV_DIR`.) The repo's own CLAUDE.md will *not* auto-load — instruct the teammate to `Read` it if needed.

2. **Hard SendMessage requirement.** Teammates default to silent idle and will not message back even when the prompt politely asks. Use this exact framing in the prompt:

   > ⚠️ Required: SendMessage to="team-lead" with the result. Not allowed to only idle. Not sending = not done.

3. **Scope.** Teammates cannot spawn their own teammates (no nested teams). If a sub-team is needed, you (the lead) must spawn it.

`--resume` does not restore an Agent Teams teammate after dispatcher restart. Treat teammates as ephemeral; pin persistent state into files inside the target repo if you need continuity.

## Cron host rule

This dispatcher is the only reliable host for `CronCreate` on this machine. The scheduler ticks only inside an interactive TUI REPL — not inside `claude -p`, not inside Agent Teams teammates (both observed to empty-fire).

Implications:

- Place periodic work here. If the work itself belongs to a specific repo, the callback prompt can dispatch outward (Bash into the repo, `claude -p`, `tm send`, or spawn a fresh Agent teammate).
- Jobs fire only while you are **idle** (not mid-query). Ongoing conversation delays firing.
- Jobs are session-only by default and die when this dispatcher process dies (`tmux kill-session dispatcher`, terminal close while not detached, Mac reboot).
- Recurring jobs auto-expire after 7 days.
- For approximate times, pick an off-minute (e.g. `7 * * * *`, not `0 * * * *`) — the platform-wide fleet aliases on `:00` and `:30`.

## Filtering idle-notification noise

Agent Teams teammates emit `{"type":"idle_notification","from":"...","idleReason":"available"}` after every turn. These arrive as conversation turns even when there is no new information.

Default response: a single line confirming the noise, no extra action. Don't `tm status` or `capture-pane` reflexively on every idle ping — that floods your own context. Only investigate state proactively when:

- the user explicitly asks for it,
- you sent a teammate work and a long enough time has passed that something should have come back,
- or an idle notification follows an explicit message you sent and you need to confirm the message was acted on.

A teammate going idle immediately after a SendMessage does **not** mean it failed; it means the teammate finished its turn and is waiting. The Agent Teams framework also separates `shutdown_approved` (the teammate agreed to shut down) from `teammate_terminated` (the process actually exited) — wait for the latter before `TeamDelete`.

## Common foot-guns (each one already cost a session)

- `tmux send-keys -t <s> '<prompt>' Enter` silently doesn't submit — the Enter becomes a newline. Use `tm send` or two separate calls.
- **Multi-line prompts** in Claude Code's TUI need a *second* `Enter`. Once the input box contains any `\n`, the first `Enter` is consumed as "insert newline at cursor" and only the next `Enter` (on the now-empty trailing line) actually submits. `tm send` detects newlines in the prompt and sends the second Enter automatically — but if you ever drop to raw `tmux send-keys`, you have to mirror that yourself.
- Polling with a `grep` whose pattern appears in the *prompt you just sent* makes the wait return instantly. Match against expected *result* keywords (e.g. `Scheduled`, `Cancelled`, `error`), not prompt echoes.
- Polling for "is the teammate done?" with regex — fragile across tasks. Use `tm wait-idle` instead; it reads a hook-driven signal file that exists for every teammate.
- Forgetting that `tm send` resets the idle baseline — if you `tm send` then read `/tmp/claude-idle/<sid>` directly to check "done", you'll find no file even for old completed turns. That's by design; wait via `tm wait-idle`.
- Long `sleep` chains are blocked by the harness sandbox. For "wait until X", use `until <check>; do sleep 4; done` with a time-bounded outer loop, or run the watcher in `run_in_background` and let it notify you on completion.
- Spawning a teammate or `claude -p` just to host a cron job — cron will not fire there, the job creation looks successful, you will only find out by missing the trigger time. Host cron on this dispatcher.
- `grep` / `find` across `$DEV_DIR` — it contains many unrelated repos. Always narrow to a specific repo first.
- The auto-mode classifier blocks the dispatcher from editing its **own** `settings.local.json` to grant itself new tool permissions (flagged as "Self-Modification"). Hand the user the exact JSON snippet to paste, or tell them to use `/permissions`.
- The `/hooks` slash-command UI only surfaces tool-related hooks (PreToolUse / PostToolUse / etc.) — `Stop` hooks do **not** appear in that menu, but they still fire. Don't conclude "hook missing" from the `/hooks` UI alone; check `~/.claude/settings.json` directly and watch for the signal file (`/tmp/claude-idle/<jsonl-uuid>`).

## Local dispatcher notes (`$DEV_DIR/.claude/local-dispatcher-notes.md`)

This skill ships inside the claudemux plugin install directory, which is
read-only and gets overwritten on plugin update. Anything user-specific —
foot-guns this particular dispatcher hits, conventions the user has stated
once, project-local procedural additions — lives in
`$DEV_DIR/.claude/local-dispatcher-notes.md` instead. The file is user-owned,
free-form, and persists across plugin upgrades.

Before doing anything substantive, check whether the notes file exists and
`Read` it if so — it's where `/claudemux:optimize` parks dispatcher-specific
additions that didn't warrant editing `$DEV_DIR/CLAUDE.md`. Treat its
contents as additional skill body for this dispatcher.

## Task ledger (use AutoMemory)

The dispatcher keeps a single live ledger named `active-dispatcher-tasks.md` in
this project's AutoMemory directory (Claude Code derives the directory from
`$DEV_DIR` — it's `~/.claude/projects/<dev-dir-with-slashes-as-dashes>/memory/`,
and the `MEMORY.md` index in the same folder lists it). Read it on boot,
before any cross-task decision, and whenever the user asks "what's running"
or "看看现在在跑啥". If the ledger file doesn't exist yet, create it from the
shape described below.

When you spawn a teammate (any form: inline Bash, `claude -p`, Agent teammate,
`tm spawn`), append an entry to the `## Active` section. Required fields:

| Field | How to obtain |
|---|---|
| `id` | `t-<YYYYMMDD-HHMM>-<short-tag>` — short-tag is a 1-2 word slug of the intent |
| `repo` | absolute path under `$DEV_DIR/` |
| `branch` | `git -C <repo> branch --show-current` at spawn time |
| `teammate` | tmux session name (`teammate-<repo>`) for tmux teammates; `<agent_id>@<team>` for Agent Teams teammates; short PID or none for inline / `-p` |
| `sid` | the teammate's claude session id (for tmux teammates: `cat /tmp/teammate-<repo>.sid`; for Agent Teams: not applicable). This is the field `tm resume <repo> <sid>` consumes when you come back to the task in a future dispatcher session — record it at spawn time, not after the teammate has died. |
| `intent` | one short line — what the user actually asked for |
| `artifacts` | URLs to any Dev Task / MR / Feishu doc as they appear (start empty, fill later) |
| `watch` | `CronCreate` job id polling this task's artifacts, or `none` |
| `last_checked` | timestamp of last poll, or `never` |
| `created` | timestamp at spawn |

When the work finishes (MR merged / Dev Task closed / explicit "done" / teammate
killed), move the entry from `## Active` to `## Recently done`. Keep the last
~10 there; drop older. The exact entry shape is in the ledger file itself.

Don't try to over-engineer this with a separate database. The markdown file
*is* the system; Read + Edit it like any other text. A future helper script
can come later if it earns its keep.

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
4. When the task hits a terminal state (merged / closed / abandoned), `CronDelete` the watch and move the row to `## Recently done`.

The dispatcher idle-only firing rule still applies — long human conversation with you delays the watch tick. That is acceptable; CI / review state does not need second-level freshness.
