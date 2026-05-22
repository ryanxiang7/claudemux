---
description: First-time claudemux setup: check dependencies, seed CLAUDE.md in the current directory, and guide Remote Control setup.
argument-hint: "[--force]"
---

You are guiding a human through first-time setup, not just executing a checklist.
Run safe checks and the bundled setup script yourself; keep package-manager
installs, `tmux` session startup, new `claude` launches, and teammate creation in
the user's hands because those actions may need passwords, new terminals, or a
fresh process that reads startup settings.

Use `AskUserQuestion` when it is available for a real decision or an action you
need the user to complete. If that tool is unavailable, ask the same question in
normal chat and wait for the answer. Keep questions concrete, include the exact
command the user should run, and recheck after the user says the action is done.

At the end, give a short setup report and the exact dispatcher start command.
The setup flow ends there; the user starts the dispatcher session next.

## Preflight: confirm the dispatcher directory

`/claudemux:setup` seeds `CLAUDE.md` into the current working directory. The
runtime later derives the dispatcher directory from the working directory of the
dispatcher session, so setup should run from the directory the user intends to
use as the dispatcher. A good dispatcher directory is usually the parent of
several sibling git repos, separate from any one repo and separate from `$HOME`.

Check the current working directory:

```bash
dispatcher_dir="$(pwd -P)"
echo "dispatcher: $dispatcher_dir"
find "$dispatcher_dir" -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null | head -10
[[ -d "$dispatcher_dir/.git" ]] && echo "warn: dispatcher directory is itself a git working tree"
[[ "$dispatcher_dir" == "$HOME" ]] && echo "warn: dispatcher directory is the home directory"
```

If any `warn:` line printed, or the `find` output shows zero sibling
subdirectories, pause before setup and ask:

> "claudemux will seed `CLAUDE.md` into `<dispatcher-dir>` and future dispatcher
> sessions will treat that directory as the repo parent. A typical dispatcher dir
> contains sibling repos and is separate from `$HOME` or any one repo. How do you
> want to proceed?"
>
> Options:
> - **"I'll re-run from the right directory"** — end the setup flow and give the
>   instruction: exit this Claude session, `cd` to the intended dispatcher
>   directory, run `claude`, then run `/claudemux:setup` again.
> - **"Continue with this dispatcher dir"** — record the confirmation and proceed.

If the current directory looks normal, continue without prompting.

## Step 0: verify system dependencies

claudemux needs `tmux`, `jq`, and the `claude` CLI. Check all of them first,
then give the user one clear install checklist for anything missing. Finish this
step before running the setup script because later checks and the dispatcher
workflow rely on these binaries.

```bash
echo "platform: $(uname -s)"
if command -v apt-get >/dev/null 2>&1; then
  echo "package-manager: apt-get"
elif command -v dnf >/dev/null 2>&1; then
  echo "package-manager: dnf"
elif command -v brew >/dev/null 2>&1; then
  echo "package-manager: brew"
else
  echo "package-manager: unknown"
fi

for bin in tmux jq claude; do
  command -v "$bin" >/dev/null 2>&1 && echo "$bin: OK" || echo "$bin: MISSING"
done
```

Suggest install commands by platform:

| Missing binary | macOS with Homebrew | Debian/Ubuntu/WSL | Fedora/RHEL | Other |
|---|---|---|---|---|
| `tmux` | `brew install tmux` | `sudo apt-get install -y tmux` | `sudo dnf install -y tmux` | ask the user to install `tmux` with their system package manager |
| `jq` | `brew install jq` | `sudo apt-get install -y jq` | `sudo dnf install -y jq` | ask the user to install `jq` with their system package manager |
| `claude` | follow https://claude.com/claude-code | same | same | same |

When one or more binaries are missing, ask once with a short list:

> "claudemux is missing these prerequisites: `<missing-list>`. Please run the
> matching install command(s) in your regular shell, then tell me when done so I
> can recheck."

> Options (single-select):
> - **"I've installed them"** — re-run the dependency check.
> - **"I'll handle this later"** — end setup with the missing prerequisites and
>   the install commands.

Loop until every required binary prints `OK`, or until the user chooses to stop.

## Step 1: run the bundled setup script

Once all deps are present:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh" $ARGUMENTS
```

That copies `CLAUDE.md.template` into the dispatcher dir, ensures
`/tmp/claude-idle/` exists, merges `TM_DISPATCHER_DIR=<dispatcher-dir>` into
the dispatcher root's `.claude/settings.json` (so Claude Code injects it as
env at every dispatcher launch — `tm` then resolves the dispatcher dir from
env instead of `$PWD`, immune to Bash-tool cwd drift), and removes any
leftover `~/.config/claudemux/config` from older versions.

Read stdout/stderr as evidence. Extract the dispatcher directory and status for
the final report. Treat any teammate verification lines printed by the script as
background; the setup report should hand off only the dispatcher start command.

| Output line | What it means | What to do |
|---|---|---|
| `[setup] wrote <path>/CLAUDE.md from template` | fresh install | continue |
| `[setup] CLAUDE.md already matches template — skipping` | already set up | continue |
| `[setup] CLAUDE.md exists and differs from template — leaving in place` | user has a customized `CLAUDE.md` | ask whether to keep it or overwrite with `--force`; if they choose overwrite, re-run the setup script with the same arguments plus `--force` |
| `[setup] wrote <path>/.claude/settings.json with TM_DISPATCHER_DIR=...` | fresh write of settings.json | continue |
| `[setup] merged TM_DISPATCHER_DIR=... into <path>/.claude/settings.json (other keys preserved)` | merged into a settings.json the user already had | continue |
| `[setup] <path>/.claude/settings.json already has TM_DISPATCHER_DIR=... — skipping` | re-running setup; nothing to change | continue |
| `[setup] updated TM_DISPATCHER_DIR in <path>/.claude/settings.json (<old> -> <new>)` | user moved the dispatcher dir; old value replaced | continue |
| `setup.sh: failed to update <path>/.claude/settings.json (is it valid JSON?...)` | existing settings.json is corrupt | hand the user the suggested `jq .` command and stop |

## Step 2: offer to enable Remote Control

Claude Code Remote Control lets the user drive each dispatcher / teammate session from claude.ai/code or the mobile app. It's controlled by the user-level setting `remoteControlAtStartup` in `~/.claude/settings.json`. claudemux assumes it's on — every teammate gets its own remote URL automatically.

Check the current state:

```bash
jq -r '.remoteControlAtStartup // false' ~/.claude/settings.json 2>/dev/null || echo "false"
```

If it prints `true`, record "Remote Control already enabled" for the final
report.

If it prints anything else, ask:

> "claudemux works best with Claude Code Remote Control enabled at startup, so
> every dispatcher and teammate session gets its own remote URL. Enable it for
> future Claude Code sessions?"

Options:
- **"Show me the `/config` path"** — tell the user to run `/config` in a Claude
  Code session and toggle "Remote Control at startup". Mark the final report as
  `manual step pending`.
- **"Leave it off for now"** — skip and mark the final report as
  `skipped by user`.

If the user explicitly asks you to edit the file for them, explain that editing
`~/.claude/settings.json` may trigger a Self-Modification permission prompt, then
attempt one guarded edit with a backup:

```bash
settings="$HOME/.claude/settings.json"
mkdir -p "$(dirname "$settings")"
if [[ -f "$settings" ]]; then
  cp "$settings" "$settings.bak-$(date +%Y%m%d-%H%M%S)"
else
  printf '{}\n' > "$settings"
fi
jq '.remoteControlAtStartup = true' "$settings" > /tmp/cmx-rc.tmp \
  && mv /tmp/cmx-rc.tmp "$settings"
```

After an automated edit, re-run the `jq -r` check. If the edit fails, report the
exact failure and give the `/config` path as the recovery step.

## Step 3: explain the dispatcher's own tmux server

This step is guidance, not an action you run — the user makes the choice at
launch time. Explain it, then carry it into the start command in the report.

The dispatcher and its teammates must not share one tmux server. A tmux
server crash takes down every session inside it at once; if the dispatcher
lives in the same server as the teammates, one crash ends the whole fleet
and nothing is left running to recover it. This is not hypothetical — it
has happened.

Deployment topology 3b fixes it structurally: run the dispatcher in its own
named tmux server with `tmux -L dispatcher`. `tm` already pins every teammate
session to the default tmux server, so once the dispatcher is in its own
`-L dispatcher` server a teammate-server crash leaves the dispatcher — and
its fleet-health sweep cron — alive to auto-resume the dead teammates.

Tell the user plainly: always start the dispatcher with `tmux -L dispatcher`.
Starting it with a bare `tmux new-session` puts it back in the shared default
server and silently loses the isolation. The start command in the report
below already uses the `-L dispatcher` form.

## Step 4: report

Print a short, human-facing summary:

- Dispatcher directory that was seeded.
- Whether `CLAUDE.md` was written / skipped / already matched.
- Whether `.claude/settings.json` was written / merged / already correct /
  updated from a previous value. Remind that `TM_DISPATCHER_DIR` is read at
  the next `claude` launch — the existing dispatcher session (if any) keeps
  its old env until restart. Once restarted, the dispatcher can run
  `tm doctor` to confirm the env is taking effect.
- Dependency state: all required binaries present.
- Remote Control state: already on / enabled / manual step pending /
  skipped by user / failed with manual recovery.
- Reminder: Remote Control is read at Claude Code startup, so changes apply to
  the next `claude` launch.
- The dispatcher runs in its own tmux server (`-L dispatcher`) so a
  teammate-server crash cannot take it down. `tm doctor` reports the topology
  once the dispatcher is up.
- The exact command for the user to start their dispatcher. Use the absolute
  dispatcher path from the preflight or setup script output:

  ```
  tmux -L dispatcher new-session -s dispatcher -c "<dispatcher-dir>"
  # inside the new pane:
  claude
  ```

End after this report. The next `claude` process is the dispatcher session.

## Re-running

`/claudemux:setup` is fully idempotent: `setup.sh` skips writing `CLAUDE.md` when the existing copy already matches the template, `mkdir -p /tmp/claude-idle` is harmless on an existing dir, and the legacy-config cleanup is a no-op when nothing is left to remove. If the user later says "再跑一次 setup" / "再帮我配一下" / "verify the install", just re-run the command — no special handling needed.

The branch that needs user input is `setup.sh` reporting `CLAUDE.md exists and
differs from template — leaving in place`: ask whether to overwrite with
`--force` or keep the customized `CLAUDE.md`.
