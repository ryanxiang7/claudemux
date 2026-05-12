#!/usr/bin/env bash
# scan-dispatcher.sh — generate MD session logs from the dispatcher's own
# conversations (cwd == $DEV_DIR), and ONLY those — not the per-repo
# teammate sessions whose cwd is $DEV_DIR/<repo>.
#
# Why a wrapper exists: self-evolve's scan-transcripts.js takes --project as
# a substring match, so passing the dispatcher's encoded cwd would also match
# every encoded `<dispatcher>-<repo>`. The clean fix is to scan with the
# broad filter, then prune output files whose embedded `project:` frontmatter
# is not exactly $DEV_DIR.
#
# Usage:
#   scan-dispatcher.sh [days=7] [output_dir=/tmp/dispatcher-optimize-logs]
#
# Resolves $DEV_DIR in priority order:
#   1. $DEV_DIR (env override) or $CLAUDEMUX_DEV_DIR (matches tm script var)
#   2. ~/.config/claudemux/config (written by /claudemux:setup)
#   3. $PWD as last-resort fallback

set -euo pipefail

DAYS="${1:-7}"
OUT="${2:-/tmp/dispatcher-optimize-logs}"

if [[ -z "${DEV_DIR:-}" ]]; then
    DEV_DIR="${CLAUDEMUX_DEV_DIR:-}"
fi
if [[ -z "${DEV_DIR:-}" && -f "$HOME/.config/claudemux/config" ]]; then
    # shellcheck disable=SC1091
    source "$HOME/.config/claudemux/config"
fi
: "${DEV_DIR:=$PWD}"

# Project dir naming convention: slashes → dashes (including the leading /).
PROJECT_FILTER=$(printf '%s' "$DEV_DIR" | tr / -)

SCANNER="$HOME/.claude/skills/self-evolve/scripts/scan-transcripts.js"
[[ -f "$SCANNER" ]] || { echo "scan-dispatcher: self-evolve scanner not found at $SCANNER — install self-evolve or run optimize manually without this step" >&2; exit 1; }

mkdir -p "$OUT"
rm -f "$OUT"/*.md

echo "scan-dispatcher: \$DEV_DIR=$DEV_DIR"
echo "scan-dispatcher: scanning last $DAYS days into $OUT"
node "$SCANNER" \
  --project "$PROJECT_FILTER" \
  --days "$DAYS" \
  --output "$OUT" \
  --min-turns 2

# Post-filter: keep only sessions whose frontmatter `project:` is exactly
# $DEV_DIR. The frontmatter `project:` value comes from the cwd field in
# the first JSONL event (scan-transcripts records absolute path).
kept=0
dropped=0
for f in "$OUT"/*.md; do
    [[ -f "$f" ]] || continue
    proj=$(awk '/^project:/ { sub(/^project:[[:space:]]*/, ""); print; exit }' "$f")
    if [[ "$proj" == "$DEV_DIR" ]]; then
        kept=$(( kept + 1 ))
    else
        rm "$f"
        dropped=$(( dropped + 1 ))
    fi
done

echo "scan-dispatcher: kept $kept dispatcher session(s), pruned $dropped teammate session(s)"
echo "$OUT"
