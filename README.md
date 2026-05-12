**English** · [简体中文](./README.zh-CN.md)

# claudemux

> One Claude Code session that drives many. Run a **dispatcher** in the parent
> of your repos; spawn per-repo **teammates** in `tmux`, talk to them in plain
> language, and keep them alive across days.

The name is `claude` + `tmux`. The shape is a *dispatcher* (the Claude Code
session you talk to) plus *teammates* (one Claude Code per repo, each in its
own `tmux` session).

## Why you might want this

If you keep half a dozen sibling repos under one folder and find yourself
opening five Claude Code sessions to coordinate work across them — switching
windows, copying context, asking each one "are you done yet?" — `claudemux`
collapses that into one conversation. The dispatcher routes work into the
right repo, blocks until the teammate replies, and gives you a single place
to schedule recurring jobs (CI watchers, status pulls) that survive across
sessions.

Because each teammate is a real `claude` REPL inside `tmux`, it auto-registers
its own Claude Code Remote Control URL — you can also drive any teammate
directly from `claude.ai/code` or the mobile app, in parallel with the
dispatcher.

## Architecture

```mermaid
flowchart TB
    user(["You<br/>(terminal · web · mobile)"])

    subgraph dispatcher_dir["dispatcher directory · the parent of your repos"]
        dispatcher["dispatcher<br/>(claude in tmux, talks to you)"]
        repoA[("repo-a/")]
        repoB[("repo-b/")]
        repoC[("repo-c/")]
    end

    subgraph teammates["teammates · one tmux session per repo"]
        tA["teammate-repo-a<br/>(claude in repo-a/)"]
        tB["teammate-repo-b<br/>(claude in repo-b/)"]
    end

    user <-->|chat| dispatcher
    user -.->|optional: direct drive<br/>via Remote Control| tA
    dispatcher -->|tm spawn / send / ask| tA
    dispatcher -->|tm spawn / send / ask| tB
    tA -.cwd.-> repoA
    tB -.cwd.-> repoB
```

The dispatcher holds the conversation; teammates do the work. Everything in
between — spawning, sending prompts, waiting for replies, killing stale
sessions — goes through the `tm` script the plugin installs on `PATH`.

## Install

Inside any Claude Code session:

```
/plugin marketplace add excitedjs/claudemux
/plugin install claudemux@claudemux
/reload-plugins
```

`/reload-plugins` activates the bundled Stop hook in this Claude Code
process; no restart needed.

Then, from inside the directory you want as your dispatcher root (the
parent of your sibling repos):

```bash
cd ~/path/to/your/dev-dir
claude
```

And in the REPL:

```
/claudemux:setup
```

`/claudemux:setup` records your dispatcher directory in
`~/.config/claudemux/config`, seeds a `CLAUDE.md` (the dispatcher's
working agreement) into the directory, and offers to flip on Claude
Code's `remoteControlAtStartup` so every teammate gets its own remote
URL.

## Quick start

In your dispatcher directory, talk in plain language:

> 派一个 teammate 去 repo-a 跑测试
>
> 看看 repo-b 现在在干啥
>
> 让 repo-a 跑 lint,同时让 repo-b 升级 react 到 19

The `dispatcher` skill auto-triggers on these intents — you don't have to
name it.

Or skip the conversation and use `tm` directly:

```bash
tm spawn repo-a                                # launch a teammate
tm ask   repo-a 'run yarn test in unit-test'   # send + wait + print reply
tm states                                      # fleet snapshot
tm kill  repo-a                                # done
```

## The `tm` script

`tm` is on `PATH` automatically when you're inside any Claude Code session.
Outside of `claude`, symlink it once into your `PATH` (see [Outside Claude
Code](#using-tm-outside-claude-code)).

| Subcommand | What it does |
|---|---|
| `tm ls` | List every running teammate session. |
| `tm states` | One-line-per-teammate fleet snapshot: repo, sid, busy?, size + age of last reply, preview of the first 50 chars. The "what's everyone doing right now" view. |
| `tm spawn <repo>` | Launch a teammate for `<repo>` (a directory under your dispatcher root) in a fresh `tmux` session. Pre-generates the session id, so wait/last work immediately. |
| `tm resume <repo> [<sid>]` | Resume a prior conversation. Prefer passing the `sid` from your task ledger; without it, falls back to the newest jsonl by mtime (with a warning). |
| `tm send <repo> <prompt…>` | Send a prompt + Enter. Handles the two-step Enter and the multi-line submit quirk you'd otherwise re-discover. |
| `tm ask [--quiet] [--timeout=N] <repo> <prompt…>` | The round-trip primitive: send + wait + print the assistant's full reply on stdout. Pipe-friendly. Use `--quiet` for things like `/compact` that don't fire a Stop event. |
| `tm wait-idle <repo> [timeout]` | Block until the teammate's Stop hook fires (= one turn finished). |
| `tm wait-quiet <repo> [timeout]` | Block until the teammate's pane shows no working spinner for a few seconds. Useful when the action doesn't end in a Stop event (`/compact`, `/clear`). |
| `tm last <repo>` | Print the full text of the teammate's last reply. Use this instead of `tm status` when you need the complete text — tmux scrollback truncates. |
| `tm status <repo> [lines]` | Capture-pane the teammate's live screen. |
| `tm poll <repo> <regex> [timeout]` | Block until pane content matches a regex. Fallback when `wait-idle` / `wait-quiet` don't apply. |
| `tm kill <repo>` | Kill the teammate's tmux session and clean up its state files. |

### How the wait primitives work

Every Claude Code session emits a Stop event at the end of each turn. The
plugin's Stop hook writes two files keyed by the session id:

- `/tmp/claude-idle/<sid>` — zero-byte touch, the wait-idle signal.
- `/tmp/claude-idle/<sid>.last` — plain text of the assistant's last-turn
  reply (just the visible text blocks; tool calls and internal thinking
  are excluded).

`tm send` deletes both files before submitting, so a subsequent `wait-idle`
/ `last` reflects *this* turn, not a previously satisfied one. The hook
waits for the latest assistant API response in the jsonl to reach a
terminal `stop_reason` before writing `.last`, so the file is either
complete or absent — never a partial reply that looks complete.

`tm wait-quiet` is a sister primitive that watches the live pane for the
"working" spinner instead of the hook signal. Use it when a teammate is
running a slash-command (e.g. `/compact`) that doesn't fire Stop.

## `/claudemux:optimize` — periodic self-review

A bundled skill that scans the dispatcher's own recent conversations,
spots recurring foot-guns or undocumented conventions, and promotes them
into the right place:

- a behavioral rule for every dispatcher session → your `CLAUDE.md`
- a dispatcher-specific addition → `<dispatcher-root>/.claude/local-dispatcher-notes.md`
- a situational fact → project memory (`~/.claude/projects/<encoded>/memory/`)

It runs in a forked context (so the log scan doesn't pollute your live
session) and returns a short structured report. Invoke manually with
`/claudemux:optimize`, or schedule it via `CronCreate` for a weekly pass.

## Configuration

`~/.config/claudemux/config` is the one piece of state the plugin keeps.
It records:

```
DEV_DIR="/Users/you/Development"
```

`DEV_DIR` is the **dispatcher root** — the directory your dispatcher Claude
session runs in and the parent it expects sibling repos under. Every `tm`
subcommand resolves repo short-names against it (`tm spawn foo` →
`$DEV_DIR/foo`). Re-run `/claudemux:setup` (or edit the file by hand) to
change it.

> ⚠️ In docs `$DEV_DIR` is a *placeholder*, not a real shell variable. The
> plugin scripts source the config and resolve it internally; if you copy a
> command from these docs into your shell, replace `$DEV_DIR` with the
> actual path.

`<dispatcher-root>/.claude/local-dispatcher-notes.md` is an optional
user-owned notes file. `/claudemux:optimize` appends user-specific
dispatcher conventions there; the bundled dispatcher skill reads it on
trigger. It's the safe place to keep notes you don't want overwritten by
a plugin update.

## Requirements

| Tool | Why |
|---|---|
| Claude Code CLI | The plugin attaches to it. |
| `tmux` | Teammates live in tmux sessions. |
| `jq` | The Stop hook parses harness JSON. |
| `bash` | Plugin scripts use Bash features (works with the macOS-default `bash` and any Linux distribution). |
| macOS or Linux | Scripts use BSD `stat -f %m`. GNU Linux needs `-c %Y` (PRs welcome). |

## Using `tm` outside Claude Code

`tm` ships under `bin/tm` in the plugin, and Claude Code auto-prepends each
installed plugin's `bin/` to `PATH` at session start. From a regular
terminal (no Claude Code session), symlink it once:

```bash
ln -sf ~/.claude/plugins/cache/claudemux/claudemux/0.1.0/bin/tm ~/.local/bin/tm
```

Make sure `~/.local/bin` is on your `PATH`. Replace `0.1.0` with the
installed version if it has been bumped.

## Local development

Two ways to point Claude Code at a local checkout instead of the
marketplace-installed copy.

**One-off** — attach a plugin directory directly:

```bash
git clone https://github.com/excitedjs/claudemux ~/src/claudemux
claude --plugin-dir ~/src/claudemux/plugins/claudemux
```

**Persistent (recommended for iterative dev)** — register the local repo
as a marketplace, then install:

```bash
claude plugin marketplace add ~/src/claudemux --scope local
claude
# in the REPL:
/plugin install claudemux@claudemux
```

`--scope local` keeps the registration to the current project;
`--scope user` is global.

**Iteration loop.** Skills, commands, hooks, and the `tm` script all hot-
reload via `/reload-plugins` — no Claude Code restart needed. If you
suspect a stale cache (e.g. `tm` not on `PATH` after a fresh install),
a full Claude Code restart is the nuclear option.

## Known limitations

- **Single dispatcher root.** `DEV_DIR` assumes all your sibling repos
  share one parent directory. Multi-root setups need manual path passing.
- **macOS / Linux only.** Several scripts use BSD `stat`. Windows is
  unsupported.
- **Cron only fires inside the dispatcher REPL.** `CronCreate` from
  `claude -p` or an Agent Teams teammate returns success then never fires
  — host all recurring jobs on the dispatcher.

The dispatcher skill bakes in the larger list of foot-guns it has already
hit, so you don't have to re-discover them. See
[`plugins/claudemux/skills/dispatcher/SKILL.md`](plugins/claudemux/skills/dispatcher/SKILL.md).

## Uninstall

```
/plugin uninstall claudemux
```

Removes the plugin and its Stop hook together. Two things are left
behind on purpose — delete by hand if you don't want them:

- `~/.config/claudemux/config` — the recorded `DEV_DIR`.
- `CLAUDE.md` in your former dispatcher directory — left in place because
  you may want to keep the dispatcher policy as reference.

## License

MIT — see [LICENSE](LICENSE).
