# claudemux

> A Claude Code plugin for **multi-repo orchestration**. Run one dispatcher
> session in the parent directory of your repos; spawn, message, and wait on
> tmux teammates across every repo from one place.

`claudemux` is what happens when you have a dozen sibling git repos under one
directory and want a single Claude Code instance to coordinate work across
them — routing tasks, watching MRs, hosting cron jobs, and driving long-lived
teammates in their own `tmux` sessions that you can pick up later from the web
or mobile.

The name is `claude` + `tmux`. The architecture is a *dispatcher* (the
top-level Claude Code session you talk to) plus *teammates* (per-repo Claude
sessions in `tmux`).

## What it gives you

| Component | What it does |
|---|---|
| `dispatcher` skill | Operations manual that triggers automatically when you ask the dispatcher to spawn / message / kill / poll teammates, or to set up scheduled work. Bakes in the hard limits (cron only fires in TUI REPLs, Agent Teams cwd cannot be set at spawn, two-step Enter for `tmux send-keys`, etc.) |
| `tm` script | One-command interface to the teammate fleet: `tm spawn`, `tm send`, `tm wait-idle`, `tm status`, `tm kill`, `tm poll`, `tm ls` |
| `setup` script | One-shot installer that records your dispatcher dir, installs the idle-signal Stop hook, and writes the dispatcher's working agreement (`CLAUDE.md`) into your dispatcher dir |
| Idle-signal Stop hook | Lets `tm wait-idle <repo>` block until a teammate finishes a turn, instead of polling a regex against `capture-pane` output |

## Architecture in one diagram

```
            ┌──────────────────────────────────────┐
            │  $DEV_DIR        (dispatcher dir)    │
            │  • CLAUDE.md     (working agreement) │
            │  • repo-a/                           │
            │  • repo-b/                           │
            │  • repo-c/                           │
            └──────────────────────────────────────┘
                        ▲
            cd here, run claude → this is the
            "dispatcher" — your orchestrator
                        │
                        │  tm spawn repo-a
                        ▼
            ┌─────────────────────┐  ┌──────────────────────┐
            │ tmux: teammate-repo-a│ │ tmux: teammate-repo-b│
            │   claude in repo-a/  │ │   claude in repo-b/  │
            │   (interactive REPL) │ │   (interactive REPL) │
            └─────────────────────┘  └──────────────────────┘
                  ▲                          ▲
                  │ tm send repo-a "<prompt>"
                  │ tm wait-idle repo-a 600
                  │
            Each teammate auto-registers its own Claude Code
            Remote Control session, so you can also drive it
            directly from claude.ai/code or the mobile app —
            in parallel with the dispatcher.
```

## Requirements

| Tool | Why |
|---|---|
| Claude Code CLI | The plugin attaches to it |
| `tmux` | Teammates run in tmux sessions |
| `jq` | The plugin's Stop hook uses `jq` to parse `session_id` from stdin |
| Bash 4+ | The scripts use Bash features (associative arrays not needed; just `[[ ]]`, `${BASH_SOURCE[0]}`, etc.) |
| macOS or Linux | The scripts use `stat -f %m` (BSD); on GNU systems swap to `stat -c %Y` |

## Install

Inside any Claude Code session, register this repo as a marketplace and
install the plugin:

```
/plugin marketplace add excitedjs/claudemux
/plugin install claudemux@claudemux
```

The `marketplace add` command clones the GitHub repo into Claude Code's
plugin cache; no manual `git clone` needed. After install, restart Claude
Code once so the bundled Stop hook activates.

## Bind to your dispatcher directory

After installing, run `/claudemux:setup` from inside the directory you want
as your dispatcher root (the parent of all your sibling repos):

```bash
cd ~/path/to/your/dev-dir
claude
# inside the Claude Code REPL:
/claudemux:setup
```

`/claudemux:setup` is idempotent. It:

1. Records `DEV_DIR=<current-dir>` in `~/.config/claudemux/config` so `tm`
   can find your dispatcher directory from any shell.
2. Copies `CLAUDE.md` into your dispatcher directory from the bundled
   template (skipped if one already exists — pass `--force` to overwrite).
3. Ensures `/tmp/claude-idle/` exists for the idle-signal hook.
4. **Asks you whether to enable Claude Code Remote Control at startup**
   (the `remoteControlAtStartup` key in `~/.claude/settings.json`).
   Each claudemux teammate registers its own Remote Control URL, which is
   how you drive teammates from claude.ai/code or mobile — so the plugin
   works best with it on. If you say yes, claudemux backs up your settings
   file and flips the flag with `jq`; if the edit is blocked (permissions,
   missing `jq`, etc.) you get the one-liner to do it yourself. If you say
   no, your settings stay untouched.

The Stop hook itself ships with the plugin (`hooks/hooks.json`), so it is
installed and uninstalled automatically with the plugin. Apart from the
opt-in Remote Control toggle above, `/claudemux:setup` does not modify
`~/.claude/settings.json`.

### Put `tm` on your PATH (optional)

The `tm` script is the day-to-day driver for teammates. If you'd rather
type bare `tm` than the full plugin path, symlink it once. From inside a
Claude Code session, `${CLAUDE_PLUGIN_ROOT}` is exported and points at the
plugin's install directory — use a `!` shell command in the REPL:

```
! mkdir -p ~/.local/bin && ln -sf "${CLAUDE_PLUGIN_ROOT}/skills/dispatcher/scripts/tm" ~/.local/bin/tm
```

(Make sure `~/.local/bin` is on your `PATH`.)

## Quick start

```bash
# In your dispatcher directory, start the dispatcher session
tmux new-session -s dispatcher -c "$YOUR_DEV_DIR"
# In the pane:
claude
```

Now talk to the dispatcher in plain language:

> 派一个 teammate 去 repo-a,跑测试

> 看看 repo-b 现在在干啥

> 帮我开两个并行 teammate,一个修 repo-a 的 i18n bug,一个在 repo-b 升 react 19

The `dispatcher` skill auto-triggers on these intents. Or use the `tm` script
directly:

```bash
tm spawn repo-a              # launch a teammate
tm send  repo-a 'run yarn test in the unit-test package'
tm wait-idle repo-a 1800     # block until that turn finishes
tm status repo-a 200         # peek at the tail of the screen
tm kill   repo-a             # done
```

## How `tm wait-idle` works

Every Claude Code session emits a Stop event at the end of each turn. The
plugin installs a global Stop hook that `touch`es `/tmp/claude-idle/<session_id>`
on every Stop event.

`tm send` records the teammate's session id and *deletes* its idle file
before submitting the prompt, so that a later `tm wait-idle` blocks until a
*new* idle file appears (i.e. *this* prompt has finished), not a stale one
from a previous turn.

The Stop hook fires for every Claude Code session, including the dispatcher
itself. That's harmless — nothing ever waits on the dispatcher's own idle
signal.

## What's NOT installed

The plugin does not seed or migrate any AutoMemory. Those files
(`~/.claude/projects/<dispatcher-dir-sanitized>/memory/`) are personal state:
the in-flight task ledger, your user / feedback / project memories. They grow
organically as the dispatcher works.

## Foot-guns the dispatcher skill already knows about

Captured in the skill so you don't re-discover them:

- `tmux send-keys -t <s> '<prompt>' Enter` silently fails to submit
  (`Enter` becomes a newline). Always use `tm send`, or two separate
  `send-keys` calls.
- `CronCreate` inside `claude -p` or inside an Agent Teams teammate returns
  success and never fires. Host cron on the dispatcher (interactive TUI).
- Polling for "is the teammate done?" by regex against `capture-pane` is
  fragile — prefer `tm wait-idle`, which reads the hook-driven signal file.
- Don't `grep` / `find` across the dispatcher dir — it contains many
  unrelated repos. Always narrow to a specific repo first.

The full set is in [`skills/dispatcher/SKILL.md`](skills/dispatcher/SKILL.md).

## Contributing / local development

To hack on the plugin source itself, clone this repo and load it directly
with `--plugin-dir`:

```bash
git clone https://github.com/excitedjs/claudemux ~/src/claudemux
claude --plugin-dir ~/src/claudemux/plugins/claudemux
```

`--plugin-dir` loads from disk for one session — no marketplace registration
needed. Changes to skills/commands take effect after `/reload-plugins`;
changes to hooks require restarting Claude Code.

## Uninstall

```
/plugin uninstall claudemux
```

`/plugin uninstall` removes the plugin and its Stop hook together (the hook
ships inside the plugin). Two things are NOT cleaned up automatically:

- `~/.config/claudemux/config` — the recorded `DEV_DIR`. Delete by hand if
  you want.
- `CLAUDE.md` in your former dispatcher directory — left in place because
  you may want to keep the dispatcher policy as reference. Delete by hand.

## License

MIT — see [LICENSE](LICENSE).
