**English** · [简体中文](./README.zh-CN.md)

# claudemux

> `claude` + `tmux`. One dispatcher Claude Code session talks to you. One
> teammate Claude Code per repo runs in its own `tmux` session. You
> orchestrate the fleet in plain language.

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

## Drive teammates from anywhere

Every teammate is a real `claude` REPL with a Remote Control URL. Open the
URL in a browser or the mobile app and you're talking to that teammate
directly — no terminal needed.

- Check on a long-running teammate from your phone on the subway.
- Hand a teammate the next task from a laptop in a cafe while the
  dispatcher keeps coordinating the rest of the fleet.
- Three devices, three windows, one fleet — in parallel.

`/claudemux:setup` flips on Claude Code's `remoteControlAtStartup`, so
every teammate registers its URL the moment it spawns.

## Install

In any Claude Code session:

```
/plugin marketplace add excitedjs/claudemux
/plugin install claudemux@claudemux
/reload-plugins
```

Then `cd` to the parent of your sibling repos and start the dispatcher:

```bash
cd ~/path/to/your/dev-dir
claude
```

In the REPL:

```
/claudemux:setup
```

## Quick start

Talk in plain language — the `dispatcher` skill picks up the intent:

> 派一个 teammate 去 repo-a 跑测试
>
> 看看 repo-b 现在在干啥
>
> 让 repo-a 跑 lint,同时让 repo-b 升级 react 到 19

Or call `tm` directly:

```bash
tm spawn repo-a                                # launch a teammate
tm ask   repo-a 'run yarn test in unit-test'   # send + wait + print reply
tm states                                      # fleet snapshot
tm kill  repo-a                                # done
```

## The `tm` script

`tm` is on `PATH` inside any Claude Code session. To use it from a regular
terminal, see [Outside Claude Code](#using-tm-outside-claude-code).

| Subcommand | What it does |
|---|---|
| `tm ls` | List running teammate sessions. |
| `tm states` | Fleet snapshot: repo, sid, busy, last-reply size + age, first 50 chars. |
| `tm spawn <repo> [--task <slug>] [--resume <sid>]` | Launch a teammate for `<repo>` in a fresh tmux session. `--task <slug>` gives the conversation a readable name (`<repo>-<slug>`; ASCII letters/digits + CJK Han allowed); default is `<repo>-<rand4>`. |
| `tm resume <repo> [<sid>] [--prompt "…"] [--task <slug>]` | Resume a prior conversation. Pass `sid` from your task ledger; without it, picks the newest jsonl by mtime. `--task` relabels the resumed conversation. |
| `tm send <repo> <prompt…>` | Send a prompt + Enter. |
| `tm ask [--quiet] [--timeout=N] <repo> <prompt…>` | Round-trip: send + wait + print the reply on stdout. Use `--quiet` for slash commands like `/compact` that don't fire Stop. |
| `tm wait-idle [--fresh] <repo> [timeout]` | Block until the teammate's Stop hook fires (= one turn finished). `--fresh` ignores any pre-existing idle signal. |
| `tm wait-quiet <repo> [timeout]` | Block until the teammate's pane shows no spinner for a few seconds. Use when the action doesn't end in a Stop event. |
| `tm last <repo>` | Print the full text of the teammate's last reply. Use this when you need the complete text — tmux scrollback truncates. |
| `tm status <repo> [lines]` | Capture-pane the teammate's live screen. |
| `tm poll <repo> <regex> [timeout]` | Block until pane content matches a regex. Fallback when wait-idle / wait-quiet don't apply. |
| `tm kill <repo>` | Kill the teammate's tmux session and clean up its state files. |
| `tm archive <id> [--status '<tag>']` | Move a closed task from `active-dispatcher-tasks.md` to the archive (outcome text on stdin). |
| `tm ctx <repo>… \| --all [--window 200k\|1m]` | Real context-window usage per teammate, read from the jsonl `usage` block. More accurate than the TUI percentage. |
| `tm history <repo> [<sid-or-prefix>]` | List past sessions for `<repo>` (newest first), or show details for one when a sid prefix is passed. |

Wait primitives and the on-disk state contract are documented in
[`plugins/claudemux/skills/dispatcher/SKILL.md`](plugins/claudemux/skills/dispatcher/SKILL.md).

## `/claudemux:optimize` — periodic self-review

A bundled skill that scans the dispatcher's recent conversations, spots
recurring foot-guns or undocumented conventions, and writes them into
your `CLAUDE.md` or project memory. Runs in a forked context, returns a
short report. Invoke manually, or schedule it with `CronCreate` for a
weekly pass.

## Requirements

| Tool | Why |
|---|---|
| Claude Code CLI | The plugin attaches to it. |
| `tmux` | Teammates live in tmux sessions. |
| `jq` | The Stop hook parses harness JSON. |
| `bash` | Plugin scripts use Bash features. |
| macOS or Linux | Scripts use BSD `stat`; Windows is unsupported. |

## Configuration

None. The dispatcher directory is wherever you `cd` and run `claude` —
`tm` derives it from `$PWD` at invocation. Move it by `cd`'ing
elsewhere; there is no global state file.

## Using `tm` outside Claude Code

`tm` lives at `bin/tm` in the plugin. From a regular terminal, symlink
it once:

```bash
ln -sf ~/.claude/plugins/cache/claudemux/claudemux/<version>/bin/tm ~/.local/bin/tm
```

Make sure `~/.local/bin` is on your `PATH`. Replace `<version>` with the
installed version.

## Known limitations

- **Single dispatcher root.** `tm spawn <repo>` resolves `<repo>` as
  `$PWD/<repo>`, so sibling repos must share one parent.
- **macOS / Linux only.** Scripts use BSD `stat`; GNU Linux needs
  `-c %Y` — PRs welcome.
- **Cron only fires inside the dispatcher REPL.** `CronCreate` from
  `claude -p` or an Agent Teams teammate returns success then never fires.

## Local development

### One-off

```bash
git clone https://github.com/excitedjs/claudemux ~/src/claudemux
claude --plugin-dir ~/src/claudemux/plugins/claudemux
```

### Persistent (recommended)

```bash
claude plugin marketplace add ~/src/claudemux --scope local
claude
# in the REPL:
/plugin install claudemux@claudemux
```

`/reload-plugins` hot-reloads skills, commands, hooks, and `tm` — no
restart needed.

Enable the pre-commit hook once after cloning:

```bash
git config core.hooksPath .githooks
```

It rejects feature-class changes (`bin/`, `hooks/`, `scripts/`,
`templates/`, `skills/*/SKILL.md`) that don't bump the plugin version in
the same commit. Bump with `bin/bump-version <patch|minor|major>`.

## Uninstall

```
/plugin uninstall claudemux
```

Removes the plugin and its hooks. Your dispatcher directory's
`CLAUDE.md` is left in place — delete it by hand if you don't want it.

## License

MIT — see [LICENSE](LICENSE).
