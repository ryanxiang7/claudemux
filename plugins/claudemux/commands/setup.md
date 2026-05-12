---
description: Bind claudemux to a dispatcher directory on this machine — writes ~/.config/claudemux/config, seeds CLAUDE.md from the bundled template, and optionally enables Claude Code Remote Control (with the user's consent). Run once after /plugin install. Defaults to the current working directory; pass --dev-dir <path> to override.
argument-hint: "[--dev-dir <path>] [--force]"
---

Do these steps in order. Stop and report at the end — don't start tmux, claude, or any teammate.

## Step 1: run the bundled setup script

```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/dispatcher/scripts/setup" $ARGUMENTS
```

That writes `~/.config/claudemux/config` (records the dispatcher dir so `tm` can find it), copies `CLAUDE.md.template` into the dispatcher dir (skipped if one already exists; pass `--force` to overwrite), and ensures `/tmp/claude-idle/` exists.

## Step 2: offer to enable Remote Control

Claude Code Remote Control lets the user drive each dispatcher / teammate session from claude.ai/code or the mobile app. It's controlled by the user-level setting `remoteControlAtStartup` in `~/.claude/settings.json`. claudemux relies on it being on (each teammate's Remote Control URL is what makes the dispatcher pattern work end-to-end).

Check the current state:

```bash
jq -r '.remoteControlAtStartup // false' ~/.claude/settings.json 2>/dev/null || echo "false"
```

If it already prints `true`, skip to step 3 and just note "Remote Control already enabled."

Otherwise, **ask the user with the AskUserQuestion tool**:

> "claudemux works best with Claude Code Remote Control enabled at startup, so every dispatcher and teammate session gets its own remote URL. Enable it now? (claudemux will edit `~/.claude/settings.json`; jq will back the file up first.)"

Offer two options:
- "Yes, enable it" — set `remoteControlAtStartup: true`
- "No, leave settings.json alone" — skip; user can run `/config` or `claude --rc` later

If the user says **yes**: back up settings.json, then `jq` it in place. Sketch:

```bash
cp ~/.claude/settings.json ~/.claude/settings.json.bak-$(date +%Y%m%d-%H%M%S) \
  && jq '.remoteControlAtStartup = true' ~/.claude/settings.json > /tmp/cmx-rc.tmp \
  && mv /tmp/cmx-rc.tmp ~/.claude/settings.json
```

If that command fails for any reason — `jq` not installed, permission denied, auto-mode classifier blocks the edit, anything — **do not retry silently**. Tell the user exactly what failed and give them the one-line fix to run themselves:

```
jq '.remoteControlAtStartup = true' ~/.claude/settings.json \
  | sponge ~/.claude/settings.json
# or: open ~/.claude/settings.json and add "remoteControlAtStartup": true
```

If the user says **no**: just note "Remote Control not changed."

## Step 3: report

A 3-4 line summary:

- Dispatcher directory that was bound (from step 1 output).
- Whether `CLAUDE.md` was written / skipped / already matched.
- Remote Control state: already-on / now-on / skipped-by-user / failed-tell-user-to-edit-manually.
- One next step — usually "run /reload-plugins so the plugin's Stop hook activates". If Remote Control was just enabled by step 2, mention that it only takes effect on the *next* Claude Code launch (it's read once at startup), not via /reload-plugins.
