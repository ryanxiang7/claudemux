---
description: First-time setup for the claudemux plugin. Trigger when the user has just installed claudemux and needs to bootstrap a dispatcher, when the user says "刚装好 claudemux / 初始化一下 / 第一次跑 / 帮我配 claudemux / setup dispatcher / first-time setup", or when the user wants to verify a claudemux install on a new machine. Checks system dependencies (tmux, jq, claude CLI) and walks the user through installing what's missing; seeds CLAUDE.md from the bundled template into the current directory; ensures /tmp/claude-idle/ exists; optionally enables Claude Code Remote Control with the user's consent. Defaults to the current working directory; pass --dev-dir <path> to target somewhere else. Idempotent — safe to re-run.
argument-hint: "[--dev-dir <path>] [--force]"
---

Do these steps in order. Stop and report at the end — don't start tmux, claude, or any teammate yourself.

## Preflight: confirm the dispatcher directory

`/claudemux:setup` seeds `CLAUDE.md` into the current working directory, and `tm` later derives the dispatcher dir from `$PWD` at runtime. So `$PWD` *is* the dispatcher dir — if the user is currently in the wrong place, setup will write to the wrong place.

Check whether `$PWD` looks like a sane dispatcher dir:

```bash
pwd
ls -d */ 2>/dev/null | head -10        # any sibling subdirectories?
[[ -d "$PWD/.git" ]] && echo "warn: $PWD is itself a git working tree"
[[ "$PWD" == "$HOME" ]] && echo "warn: $PWD is the home directory"
```

If any `warn:` line printed, or `ls -d */` shows zero sibling directories, use the AskUserQuestion tool to soft-prompt the user **before** proceeding:

> "Your current cwd is `<pwd>`. claudemux will seed `CLAUDE.md` here and treat this as the dispatcher dir. That looks unusual (the dispatcher dir is normally the parent of several sibling git repos, not a git repo itself or the home directory). How do you want to proceed?"
>
> Options:
> - **"Let me re-run from the right directory"** — stop the setup flow here. Tell the user to exit the current claude session, `cd` to the intended dispatcher dir, and run `/claudemux:setup` again. Do not proceed to Step 0.
> - **"Continue here — this really is my dispatcher dir"** — note their confirmation and proceed to Step 0.

If nothing looks wrong (no `warn:` and sibling directories present), silently continue to Step 0 without bothering the user.

## Step 0: verify system dependencies

claudemux needs `tmux`, `jq`, and the `claude` CLI on the user's machine. Check each one and walk the user through installing whatever is missing — these are blocking prerequisites; do not skip ahead.

First detect the platform so the install commands you suggest are right:

```bash
uname -s   # Darwin = macOS, Linux = Linux/WSL
```

Then for each required binary:

```bash
command -v tmux >/dev/null && echo "tmux: OK" || echo "tmux: MISSING"
command -v jq   >/dev/null && echo "jq: OK"   || echo "jq: MISSING"
command -v claude >/dev/null && echo "claude: OK" || echo "claude: MISSING"
```

For every binary that prints `MISSING`, use the **AskUserQuestion** tool to walk the user through installing it. You are not running the install command for the user — `brew` / `apt-get` may need sudo and a password the harness cannot supply. Print the right command for their platform and wait for the user to run it themselves.

Example wording for missing `tmux` on macOS:

> "claudemux needs `tmux` but it's not installed on this machine. Install it now? I'll print the command; please run it in your shell and tell me when it's done."
>
> Options (single-select):
> - **"I'll run `brew install tmux`"** — wait for the user to confirm, then recheck `command -v tmux`.
> - **"I'll handle it later"** — abort setup with a clear note that the dispatcher cannot run without it.

The install commands to suggest, by platform:

| Binary | macOS (Darwin) | Linux (Debian/Ubuntu) | Linux (RHEL/Fedora) |
|---|---|---|---|
| `tmux` | `brew install tmux` | `sudo apt-get install -y tmux` | `sudo dnf install -y tmux` |
| `jq` | `brew install jq` | `sudo apt-get install -y jq` | `sudo dnf install -y jq` |
| `claude` | follow https://claude.com/claude-code | same | same |

After the user reports the install is done, recheck with `command -v`. Loop until every required binary is present or the user explicitly aborts. Do not silently proceed with a missing dependency — the next steps will break.

## Step 1: run the bundled setup script

Once all deps are present:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh" $ARGUMENTS
```

That copies `CLAUDE.md.template` into the dispatcher dir (skipped if a matching CLAUDE.md already exists; pass `--force` to overwrite a differing one), ensures `/tmp/claude-idle/` exists, and removes any leftover `~/.config/claudemux/config` from older versions.

Read the script's stdout and react:

| Output line | What it means | What to do |
|---|---|---|
| `wrote <path>/CLAUDE.md from template` | fresh install | continue |
| `CLAUDE.md already matches template — skipping` | already set up | continue |
| `CLAUDE.md exists and differs from template — leaving in place` | user has a customized CLAUDE.md | ask via AskUserQuestion whether to overwrite (re-run with `--force`) or keep their version |
| `setup.sh: dispatcher dir does not exist: <path>` | user passed a `--dev-dir` to a non-existent directory | ask the user to confirm or correct the path |

## Step 2: offer to enable Remote Control

Claude Code Remote Control lets the user drive each dispatcher / teammate session from claude.ai/code or the mobile app. It's controlled by the user-level setting `remoteControlAtStartup` in `~/.claude/settings.json`. claudemux assumes it's on — every teammate gets its own remote URL automatically.

Check the current state:

```bash
jq -r '.remoteControlAtStartup // false' ~/.claude/settings.json 2>/dev/null || echo "false"
```

If it already prints `true`, skip to Step 3 and note "Remote Control already enabled."

Otherwise, ask the user with the AskUserQuestion tool:

> "claudemux works best with Claude Code Remote Control enabled at startup, so every dispatcher and teammate session gets its own remote URL. Enable it now? (I'll back up settings.json before editing.)"

Options:
- "Yes, enable it" — set `remoteControlAtStartup: true`
- "No, leave settings.json alone" — skip; user can run `/config` or `claude --rc` later

If the user says **yes**: prefer to have **the user flip it themselves**, not Claude. Claude Code's auto-mode classifier flags any edit to `~/.claude/settings.json` as Self-Modification and pops up a permission prompt, which is more friction than just telling the user the one-line answer. Hand them either of these and let them pick:

**Option A (recommended):** Run `/config` from inside any Claude Code session and toggle "Remote Control at startup" there. One click, no permission prompt.

**Option B:** Add this key to `~/.claude/settings.json` (merge with whatever's already there):

```json
{
  "remoteControlAtStartup": true
}
```

Only if the user explicitly says "you do it for me" — and you've warned them that the Self-Modification permission prompt will appear — attempt the automated edit:

```bash
cp ~/.claude/settings.json ~/.claude/settings.json.bak-$(date +%Y%m%d-%H%M%S) \
  && jq '.remoteControlAtStartup = true' ~/.claude/settings.json > /tmp/cmx-rc.tmp \
  && mv /tmp/cmx-rc.tmp ~/.claude/settings.json
```

If the auto-edit fails (permission denied, classifier blocks, jq error, missing `~/.claude/settings.json`), do **not** retry silently — fall back to Option A or B above and tell the user exactly what failed.

If the user says **no**: note "Remote Control not changed."

## Step 3: report

Print a short summary (5–7 lines):

- Dispatcher directory that was seeded (from `setup.sh` stdout).
- Whether `CLAUDE.md` was written / skipped / already matched.
- Remote Control state: already-on / now-on / skipped-by-user / failed-needs-manual-edit.
- A reminder that Remote Control only takes effect on the **next** `claude` launch (the setting is read once at startup), not in the current session.
- The exact command for the user to start their dispatcher (use the absolute path from `setup.sh` stdout, not `$PWD`):

  ```
  tmux new-session -s dispatcher -c "<dispatcher-dir>"
  # inside the new pane:
  claude
  ```

End there. Do not launch tmux, claude, or any teammate from this setup flow — the user runs that command themselves and the new `claude` session takes over.

## Re-running

`/claudemux:setup` is fully idempotent: `setup.sh` skips writing `CLAUDE.md` when the existing copy already matches the template, `mkdir -p /tmp/claude-idle` is harmless on an existing dir, and the legacy-config cleanup is a no-op when nothing is left to remove. If the user later says "再跑一次 setup" / "再帮我配一下" / "verify the install", just re-run the command — no special handling needed.

The one branch that does need user input is `setup.sh` reporting `CLAUDE.md exists and differs from template — leaving in place`: ask via AskUserQuestion whether to overwrite (re-run with `--force`) or keep the customized CLAUDE.md.
