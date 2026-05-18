#!/usr/bin/env bash
# setup.sh — seed CLAUDE.md, idle dir, and TM_DISPATCHER_DIR for a
# claudemux dispatcher.
#
# The "dispatcher directory" is wherever the user runs `claude` from to drive
# teammates. There's no global registry; the runtime derives it at invocation
# (TM_DISPATCHER_DIR env if set, $PWD fallback for `tm`; each teammate
# session's recorded cwd for the SessionStart hook).
#
# Idempotent steps:
#   1. Copy CLAUDE.md.template to <dispatcher-dir>/CLAUDE.md (skipped if the
#      existing CLAUDE.md already matches; pass --force to overwrite a
#      differing one).
#   2. Ensure /tmp/claude-idle/ exists (the directory `tm wait` / `tm send` polls).
#   3. Merge TM_DISPATCHER_DIR=<dispatcher-dir> into the dispatcher root's
#      .claude/settings.json `env` block. Claude Code injects entries from
#      that file as env at every claude launch, so `tm` reads the right
#      dispatcher dir even when the Bash tool's cwd has drifted to a sibling
#      repo. Idempotent: jq merge preserves any other env / setting keys
#      the user already has.
#   4. Remove ~/.config/claudemux/config if present (no longer read; the
#      runtime derives the dispatcher dir from env or cwd).
#   5. Print verification next steps.
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

# --- 4. write TM_DISPATCHER_DIR into <dispatcher-dir>/.claude/settings.json ---
# Claude Code reads project-root .claude/settings.json on launch and injects
# its `env` block into the spawned claude process. Setting TM_DISPATCHER_DIR
# there means `tm` reads the correct dispatcher dir even when the dispatcher's
# Bash tool has `cd`ed into a sibling repo (Bash tool persists cwd across
# calls; without the env override, tm would resolve repo paths and the
# AutoMemory ledger relative to that drifted cwd).
#
# Idempotency: jq merges the key into any existing `.env` object, preserving
# all other keys (other env vars, hooks, permissions, anything else the user
# has in settings.json). The temp file + mv pattern keeps the write atomic so
# a SIGINT mid-write can't corrupt the file.
SETTINGS_DIR="$DISPATCHER_DIR/.claude"
SETTINGS_FILE="$SETTINGS_DIR/settings.json"
mkdir -p "$SETTINGS_DIR"

# `mktemp <target>.XXXXXX` keeps the temp file on the SAME filesystem as
# the target — guarantees the subsequent `mv` is an atomic inode rename,
# not a cross-FS copy+unlink. Default `mktemp` lands in $TMPDIR (often a
# different filesystem on macOS) and would silently degrade the
# atomicity claim. Apply to both branches so SIGINT or jq failure
# mid-write can't leave a half-written settings.json.
if [[ -f "$SETTINGS_FILE" ]]; then
    existing_val=$(jq -r '.env.TM_DISPATCHER_DIR // ""' "$SETTINGS_FILE" 2>/dev/null || echo "")
    if [[ "$existing_val" == "$DISPATCHER_DIR" ]]; then
        say "$SETTINGS_FILE already has TM_DISPATCHER_DIR=$DISPATCHER_DIR — skipping"
    else
        tmp=$(mktemp "$SETTINGS_FILE.XXXXXX")
        if jq --arg v "$DISPATCHER_DIR" \
              '.env = ((.env // {}) + {TM_DISPATCHER_DIR: $v})' \
              "$SETTINGS_FILE" > "$tmp"; then
            mv "$tmp" "$SETTINGS_FILE"
            if [[ -n "$existing_val" ]]; then
                say "updated TM_DISPATCHER_DIR in $SETTINGS_FILE ($existing_val -> $DISPATCHER_DIR)"
            else
                say "merged TM_DISPATCHER_DIR=$DISPATCHER_DIR into $SETTINGS_FILE (other keys preserved)"
            fi
        else
            rm -f "$tmp"
            echo "setup.sh: failed to update $SETTINGS_FILE (is it valid JSON? run 'jq . $SETTINGS_FILE' to check)" >&2
            exit 1
        fi
    fi
else
    tmp=$(mktemp "$SETTINGS_FILE.XXXXXX")
    if jq -n --arg v "$DISPATCHER_DIR" '{env: {TM_DISPATCHER_DIR: $v}}' > "$tmp"; then
        mv "$tmp" "$SETTINGS_FILE"
        say "wrote $SETTINGS_FILE with TM_DISPATCHER_DIR=$DISPATCHER_DIR"
    else
        rm -f "$tmp"
        echo "setup.sh: failed to write $SETTINGS_FILE" >&2
        exit 1
    fi
fi

# --- 5. report ---
cat <<EOF

[setup] done.

Verify by starting a dispatcher session:
  1. From a regular shell, open a tmux session whose cwd is the dispatcher dir:
       tmux new-session -s dispatcher -c "$DISPATCHER_DIR"
  2. Inside that pane, launch Claude Code:
       claude
  3. Once Claude is at the prompt, spawn a teammate against a sibling repo:
       tm spawn <repo>      # <repo> is a direct subdirectory of $DISPATCHER_DIR
  4. Send a prompt; the reply lands on stdout (tm send is sync round-trip):
       tm send <repo> --prompt 'echo hello'
     You should see the teammate's text reply within a minute.

Notes:
  * \`tm\` is on PATH automatically (Claude Code prepends each installed
    plugin's bin/ directory).
  * \`tm\` reads the dispatcher dir from TM_DISPATCHER_DIR (now written to
    $SETTINGS_FILE) and falls back to \$PWD if that env is unset. The env
    is what protects \`tm\` from Bash-tool cwd drift — sanity-check with
    \`tm doctor\` from inside the dispatcher claude session.
  * The Stop hook touches /tmp/claude-idle/<sid> for every Claude Code
    session, including the dispatcher itself. Nothing waits on that signal.
  * AutoMemory and the live task ledger live under
    ~/.claude/projects/<cwd-sanitized>/memory/ — not managed by this script.
EOF
