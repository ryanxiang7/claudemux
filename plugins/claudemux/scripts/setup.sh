#!/usr/bin/env bash
# setup.sh — seed CLAUDE.md and the idle dir for a claudemux dispatcher.
#
# The "dispatcher directory" is wherever the user runs `claude` from to drive
# teammates. Nothing records its path globally; `tm` and the SessionStart hook
# derive it at runtime ($PWD for `tm`, each teammate session's recorded cwd
# for the hook).
#
# Idempotent steps:
#   1. Copy CLAUDE.md.template to <dispatcher-dir>/CLAUDE.md (skipped if the
#      existing CLAUDE.md already matches; pass --force to overwrite a
#      differing one).
#   2. Ensure /tmp/claude-idle/ exists (the directory `tm wait-idle` polls).
#   3. Remove ~/.config/claudemux/config if present (no longer read; the
#      runtime derives the dispatcher dir from cwd).
#   4. Print verification next steps.
#
# Not done here:
#   - Installing hooks. They ship with the plugin (hooks/hooks.json) and
#     follow the plugin's install/uninstall lifecycle.
#   - Starting tmux, claude, or any teammate.
#   - Editing ~/.claude/settings.json. The /claudemux:setup command's Step 2
#     handles Remote Control opt-in.
#   - Checking system dependencies (tmux, jq, claude). Step 0 of the
#     /claudemux:setup command handles those with explicit user prompts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE="$PLUGIN_ROOT/templates/CLAUDE.md.template"
IDLE_DIR="/tmp/claude-idle"
LEGACY_CONFIG_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/claudemux/config"

force=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --force) force=1; shift ;;
        -h|--help)
            cat <<EOF
setup.sh — seed CLAUDE.md + idle dir for a claudemux dispatcher.

Usage:
  $(basename "$0") [--force]

Options:
  --force           Overwrite ./CLAUDE.md even if it already exists.

Paths:
  template          $TEMPLATE
EOF
            exit 0 ;;
        *) echo "setup.sh: unknown flag: $1" >&2; exit 1 ;;
    esac
done

DISPATCHER_DIR="$PWD"
[[ -d "$DISPATCHER_DIR" ]] || { echo "setup.sh: dispatcher dir does not exist: $DISPATCHER_DIR" >&2; exit 1; }
DISPATCHER_DIR="$(cd "$DISPATCHER_DIR" && pwd)"
TARGET_CLAUDE_MD="$DISPATCHER_DIR/CLAUDE.md"

say() { echo "[setup] $*"; }

# --- 1. silently remove any legacy config file ---
# Older versions wrote ~/.config/claudemux/config with a DEV_DIR= line. The
# runtime no longer reads it; remove so a future operator does not assume it
# is still authoritative.
if [[ -f "$LEGACY_CONFIG_FILE" ]]; then
    rm -f "$LEGACY_CONFIG_FILE"
    say "removed legacy $LEGACY_CONFIG_FILE"
fi

# --- 2. CLAUDE.md ---
if [[ ! -f "$TEMPLATE" ]]; then
    echo "setup.sh: missing template at $TEMPLATE" >&2
    exit 1
fi

if [[ -f "$TARGET_CLAUDE_MD" && $force -eq 0 ]]; then
    if cmp -s "$TEMPLATE" "$TARGET_CLAUDE_MD"; then
        say "CLAUDE.md already matches template — skipping"
    else
        say "CLAUDE.md exists and differs from template — leaving in place (use --force to overwrite)"
        say "  diff: diff $TARGET_CLAUDE_MD $TEMPLATE"
    fi
else
    cp "$TEMPLATE" "$TARGET_CLAUDE_MD"
    say "wrote $TARGET_CLAUDE_MD from template"
fi

# --- 3. idle dir ---
mkdir -p "$IDLE_DIR"
say "ensured $IDLE_DIR exists"

# --- 4. report ---
cat <<EOF

[setup] done.

Verify by starting a dispatcher session:
  1. From a regular shell, open a tmux session whose cwd is the dispatcher dir:
       tmux new-session -s dispatcher -c "$DISPATCHER_DIR"
  2. Inside that pane, launch Claude Code:
       claude
  3. Once Claude is at the prompt, spawn a teammate against a sibling repo:
       tm spawn <repo>      # <repo> is a direct subdirectory of $DISPATCHER_DIR
  4. Send a prompt and wait for the reply:
       tm send <repo> 'echo hello'
       tm wait-idle <repo> 60
     wait-idle should return "idle: <sid>" within a minute.

Notes:
  * \`tm\` is on PATH automatically (Claude Code prepends each installed
    plugin's bin/ directory). \`tm spawn\` reads the dispatcher dir from
    \$PWD, so run it from inside the dispatcher tmux session.
  * The Stop hook touches /tmp/claude-idle/<sid> for every Claude Code
    session, including the dispatcher itself. Nothing waits on that signal.
  * AutoMemory and the live task ledger live under
    ~/.claude/projects/<cwd-sanitized>/memory/ — not managed by this script.
EOF
