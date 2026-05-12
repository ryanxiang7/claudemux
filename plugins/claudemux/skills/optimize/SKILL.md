---
name: optimize
description: |
  Periodic self-review of the dispatcher workspace. Scans recent dispatcher conversations only (the jsonl files whose cwd equals $DEV_DIR — the parent of all sibling repos, configured by /claudemux:setup — NOT per-repo teammate sessions), identifies usage habits, recurring foot-guns, and drifted conventions, then promotes the findings into $DEV_DIR/CLAUDE.md, dispatcher project memory (~/.claude/projects/<encoded-$DEV_DIR>/memory/), and a user-owned dispatcher notes file at $DEV_DIR/.claude/local-dispatcher-notes.md. Runs in a forked context so the heavy log analysis does not pollute the parent dispatcher session. Trigger this skill when the user asks to "review dispatcher", "optimize dispatcher", "let dispatcher self-reflect", "派活流程审查", "dispatcher 自我反省", "dispatcher 复盘", "/claudemux:optimize", or when a scheduled cron callback fires asking for the periodic review.
context: fork
---

# Dispatcher Self-Optimize

## Why this skill exists

The dispatcher accumulates lessons from every task it routes — recurring foot-guns, half-formed conventions the user stated once and never repeated, ledger drift, skill instructions that didn't quite fire when they should have. Without a periodic pass, those lessons stay buried in jsonl history and the next session re-learns them from scratch.

This skill is that periodic pass. It runs inside a forked context (`context: fork` in frontmatter) so the log scan + cross-reading does not consume context in the parent dispatcher session.

## Resolve $DEV_DIR first

Every path below is relative to `$DEV_DIR` — the dispatcher directory (parent of all sibling repos). Resolve it once at the start of the run:

```bash
# 1. Honor an explicit override (for ad-hoc runs against a different tree).
# 2. Otherwise source the claudemux config written by /claudemux:setup.
# 3. Otherwise fall back to the current working directory.
if [[ -z "${DEV_DIR:-}" ]]; then
    [[ -f "$HOME/.config/claudemux/config" ]] && source "$HOME/.config/claudemux/config"
fi
: "${DEV_DIR:=$PWD}"
ENCODED_DEV_DIR=$(printf '%s' "$DEV_DIR" | tr / -)
PROJECT_MEMORY="$HOME/.claude/projects/$ENCODED_DEV_DIR/memory"
LOCAL_NOTES="$DEV_DIR/.claude/local-dispatcher-notes.md"
```

If any write below would land outside `$DEV_DIR`, `$DEV_DIR/.claude/`, or the project memory dir, treat it as a bug and stop — those three are the only writable roots for this skill. The plugin install directory (this skill's own files) is read-only; never try to self-edit.

## Scope — what's in, what's out

In scope (read AND modify):

| Carrier | Path |
|---|---|
| Project CLAUDE.md | `$DEV_DIR/CLAUDE.md` |
| Project memory | `$PROJECT_MEMORY/*.md` (where `$PROJECT_MEMORY` resolves as above) |
| Local dispatcher notes | `$DEV_DIR/.claude/local-dispatcher-notes.md` (user-owned, free-form) |
| New skills in this workspace | `$DEV_DIR/.claude/skills/<new>/` (with user confirmation) |

In scope (read only — signal source):

- `~/.claude/projects/$ENCODED_DEV_DIR/*.jsonl` (dispatcher's own conversations only)

Out of scope — never touch:

- This plugin's install directory (`${CLAUDE_PLUGIN_ROOT}` — the dispatcher / optimize skills themselves are read-only)
- Global `~/.claude/CLAUDE.md` and global skills under `~/.claude/skills/`
- Memory directories of sibling repo projects (`~/.claude/projects/$ENCODED_DEV_DIR-<repo>/`)
- Teammate session jsonls inside those projects
- Any file outside the three "in scope (modify)" paths

The boundary matters: self-evolve handles global promotion. This skill is dispatcher-only. Drifting outside scope conflates the two and makes both harder to reason about.

## Execution flow

### 1. Generate dispatcher session logs

Run the bundled scanner, which wraps self-evolve's `scan-transcripts.js` and post-filters to keep only sessions whose `cwd == $DEV_DIR`:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/optimize/scripts/scan-dispatcher.sh" 7 /tmp/dispatcher-optimize-logs
```

Arguments: `[days=7] [output_dir=/tmp/dispatcher-optimize-logs]`. The wrapper itself resolves `$DEV_DIR` from the claudemux config (same priority order as above) — you don't need to pass it. The 7-day window is a sensible default; widen it on the first run if the dispatcher has been quiet recently, narrow it when running daily.

If no logs are produced (no recent dispatcher sessions), stop here and report "no signal".

Prerequisite: the self-evolve scanner at `~/.claude/skills/self-evolve/scripts/scan-transcripts.js` must exist. If it doesn't, the wrapper exits non-zero and points at the missing path; install self-evolve (or skip this skill) — claudemux does not bundle it.

### 2. Read all the signal sources

In the forked context, read these in parallel where possible:

- Every `*.md` file in `/tmp/dispatcher-optimize-logs/` (the session logs)
- `$DEV_DIR/CLAUDE.md` (current project CLAUDE.md)
- `${CLAUDE_PLUGIN_ROOT}/skills/dispatcher/SKILL.md` (dispatcher skill body — read-only, but you still need it to know what's already documented)
- `${CLAUDE_PLUGIN_ROOT}/skills/dispatcher/scripts/tm` (the helper script — read-only)
- `$DEV_DIR/.claude/local-dispatcher-notes.md` (if it exists — user's freeform additions)
- `$PROJECT_MEMORY/MEMORY.md` (memory index)
- Every `*.md` file linked from `MEMORY.md`

You need both sides — the lessons in the logs and the current state of the carriers — to decide what's already captured and what's not.

### 3. Identify candidate findings

For each log, look along these axes:

| Axis | Example |
|---|---|
| User correction not yet captured as a feedback memory or CLAUDE.md rule | "stop doing X" said once, no memory written |
| Recurring foot-gun the dispatcher hit more than once | Cron fired the wrong way; teammate spawn missed a step |
| Ledger drift | Active entry whose teammate no longer exists; intent line gone stale |
| Skill instruction that should have triggered but didn't | dispatcher skill description failed to match a clear-cut request |
| Implicit correction at rollback markers (`↩` in the log) | User rolled back and retried — what was the implicit fix? |
| Convention stated in conversation but not encoded anywhere | "I prefer X" mentioned a few times, no rule |
| Repeated work pattern that would benefit from a `tm` subcommand or helper | Same 3-line bash incantation typed across sessions |

For each candidate, write a one-line summary plus one or two log excerpts as evidence. If you can't point at evidence, don't promote it.

### 4. Apply the decision tree

Use `references/decision-tree.md` (in this skill) to pick the carrier for each finding. Summary:

| Carrier | Auto-apply | Requires user confirmation |
|---|---|---|
| Project memory file (new/edit) | yes | wholesale deletion of an existing file |
| Project memory (MEMORY.md index update) | yes | — |
| Local dispatcher notes — small addition (≤ 5 lines, append) | yes | rewrites, deletions |
| Dispatcher CLAUDE.md — small addition (≤ 3 sentences, existing section) | yes | rewrites, deletions, larger additions |
| Plugin-level skill change (`dispatcher/SKILL.md` or `scripts/tm`) | NEVER auto-apply | always propose a diff for the user to apply manually; the plugin install dir is read-only |
| New skill in workspace | NEVER auto-apply | always propose with full proposal |

The "auto-apply" entries write directly. The "requires confirmation" entries are collected into the final report as proposals with concrete diffs the user can approve in one turn.

Before applying any change, dedup: if the rule is already in CLAUDE.md, the dispatcher skill, or the local notes file, don't re-add. If a memory already says the same thing, edit it in place instead of creating a duplicate.

Why "local dispatcher notes" rather than editing the dispatcher skill: the skill is shipped inside the claudemux plugin install dir, which is read-only and gets overwritten on plugin update. The local notes file is user-owned and survives upgrades. The dispatcher skill's body points at it, so additions there are reachable by future dispatcher sessions without modifying the plugin.

### 5. Post-promotion cleanup

When a memory's content has been absorbed into CLAUDE.md or the local dispatcher notes, delete the memory file and remove its line from `MEMORY.md`. The whole point of promotion is that the lesson lives in a more efficient carrier — leaving the original around defeats the purpose. (Anti-pattern: "I promoted it but kept the memory too" → next pass sees it again.)

### 6. Clean up scratch state

```bash
rm -f /tmp/dispatcher-optimize-logs/*.md
```

### 7. Return a concise report

Output to the parent context (the dispatcher) a short structured summary, NOT a dump of everything you read. Format:

```
# Dispatcher review (<date>, <N> sessions over last <D> days)

## Auto-applied
- [<carrier>] <one-line change summary>
- [memory:new] feedback-<topic>.md — <why>
- [local-notes] added foot-gun bullet on X
...

## Awaiting your confirmation
### <P0 — most important first>
<finding>, evidence: <one or two log excerpts>
Proposed change: <concrete diff or text snippet>
Carrier: <which file>

### <P1>
...

## Observations not yet promoted
<short notes on patterns you saw but didn't have enough density to promote yet>
```

Keep the report under ~200 lines. The user reads this, not the underlying logs.

## Scheduling

Once the user has confirmed the skill works manually, schedule it via `CronCreate` from the dispatcher (cron only fires inside the dispatcher REPL, never inside teammates or `claude -p`):

```
CronCreate({
  prompt: "Run /claudemux:optimize on the last 7 days of dispatcher conversations. This is the scheduled weekly review.",
  schedule: "23 4 * * 1"   // every Monday at 04:23 — off-minute to avoid fleet aliasing
})
```

The dispatcher gets the callback as a turn; the prompt triggers this skill by description match; the skill body runs in its forked context; the parent dispatcher only sees the final report.

Avoid `:00` and `:30` minute marks — the platform-wide fleet aliases there. Pick a quirky minute (`23`, `47`, `7`).

Recurring `CronCreate` jobs auto-expire after 7 days. If you want this running indefinitely, the callback prompt can `CronCreate` itself again at the end of its run, or the user re-arms it weekly.

## Compatibility with manual invocation

`/claudemux:optimize` works as a one-shot manual run too — the user can ask anytime. Same flow, no behavioral difference between manual and cron-triggered.

When asked to do a partial run (e.g., "only review the last 24 hours" or "only look at task ledger drift"), narrow step 1's `days` arg or skip irrelevant axes in step 3 — the rest of the flow is unchanged.
