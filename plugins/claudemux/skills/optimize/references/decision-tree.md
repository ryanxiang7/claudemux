# Promotion Decision Tree (dispatcher-scoped)

For each finding (recurring foot-gun, undocumented convention, drifted skill instruction, missing memory), decide in priority order which carrier it should live in. The order matters — pick the highest-priority match.

All paths below are relative to `$DEV_DIR` (resolved as described in `SKILL.md` — claudemux config first, then `$PWD`). `$PROJECT_MEMORY` is `~/.claude/projects/<encoded-$DEV_DIR>/memory/`.

## 1. → Project CLAUDE.md (`$DEV_DIR/CLAUDE.md`)

Eligible when the finding is a **behavioral rule** that should fire in EVERY dispatcher session, not gated on a specific skill being triggered. Examples:

- "Never grep across `$DEV_DIR` — too many repos"
- "Cron firing rules and limits"
- "Don't combine prompt + Enter in one tmux send-keys call"

Keep the CLAUDE.md addition short (1–3 sentences) and lead with the rule, then a one-line *why*. Concrete recall over taxonomy.

**Requires user confirmation** before any substantive change (rewrites, deletions, or any single addition > ~3 sentences). Small additions (≤ 3 sentences) under an existing section may be applied directly.

## 2. → Local dispatcher notes (`$DEV_DIR/.claude/local-dispatcher-notes.md`)

Eligible when the finding is **only relevant when the dispatcher is actively spawning/managing teammates** or running a specific orchestration flow, but does not warrant editing CLAUDE.md (too narrow) or project memory (not a fact, more like a procedural addition). Examples:

- "When sentinel-waiting for a teammate, do Y not Z"
- "Add a foot-gun bullet about /compact + wait-idle"
- "Prefer `tm ask` over `tm send + wait-idle + last` triplet for one-shot Q&A"

Apply directly only when the change is a small addition (≤ 5 lines, appended to the file). Anything larger requires user confirmation. **Never** rewrite the notes file from scratch.

This carrier exists because the dispatcher skill itself lives inside the claudemux plugin install directory, which is read-only and gets overwritten on plugin update. The notes file is user-owned and survives upgrades.

When a finding would benefit FUTURE plugin users (not just this dispatcher), surface it as a "propose to upstream the dispatcher skill" item in the report rather than writing to local notes — the user can then submit a plugin change.

## 3. → Plugin-level skill change — propose only (`${CLAUDE_PLUGIN_ROOT}/skills/dispatcher/SKILL.md` or `scripts/tm`)

Eligible when the finding would be valuable to ALL users of the claudemux plugin, not just this dispatcher. Examples:

- A new `tm` subcommand that solves a recurring pattern
- A foot-gun general enough that every dispatcher would benefit
- A correction to plugin-skill text that misleads in the general case

**Always requires user confirmation.** The plugin install dir is read-only; the proposal should be a concrete diff the user can apply manually in the claudemux source repo (or paste into a PR). When testing such a change, always sanity-check `scripts/tm` with `bash -n` before declaring done — a broken `tm` paralyses every future dispatcher session.

## 4. → Project memory (`$PROJECT_MEMORY/*.md`)

The default storage for findings that are too **situational** to be a CLAUDE.md rule, too **dispatcher-internal** to belong in a sibling repo, and too **standalone** to fold into the dispatcher skill. Examples:

- "User prefers driving teammates directly via RC; dispatcher should not relay"
- "active-dispatcher-tasks.md is the live ledger location — read it on boot"
- "Project doubao-office-x-feishu is in Spike 1 phase; artifacts X, Y"

Memory writes are **auto-applied** (no user confirmation) for: new files, additions to existing files, and routine cleanups (broken links, stale "Active" → "Recently done" transitions). Deletions of an entire memory file require user confirmation.

Always update `MEMORY.md` (the index) when adding or removing files; never write content directly into `MEMORY.md`.

## 5. → New skill in this workspace (`$DEV_DIR/.claude/skills/<new>/`)

Eligible when ≥ 5 memories cluster around the same domain AND are repeatedly retrieved together AND can't be cleanly absorbed into the dispatcher skill or local notes. Examples:

- A self-contained "bits-devops watcher" workflow that runs across many tasks
- A repeatable multi-step ritual that has its own tools and references

**Always requires user confirmation.** Never auto-create. When proposing, write a one-paragraph proposal containing: the cluster of memories, the proposed skill name and scope, and the trigger description.

## 6. → Retain in memory

When density is insufficient (< 5 related memories) or the finding is too cross-cutting for any of the above, keep it as a project memory and observe. Re-evaluate next run.

## Out-of-scope (never touch)

- This plugin's install directory (`${CLAUDE_PLUGIN_ROOT}`) — read-only
- Global `~/.claude/CLAUDE.md`
- Global skills in `~/.claude/skills/`
- Memory directories of sibling repo projects (`~/.claude/projects/<encoded-$DEV_DIR>-<repo>/`)
- Any file outside `$DEV_DIR/`, `$DEV_DIR/.claude/`, and `$PROJECT_MEMORY/`

Self-evolve handles global promotion; this skill only operates inside the dispatcher workspace.

## Anti-patterns

- A memory directly related to the dispatcher skill is sitting in `memory/` instead of in the local notes → absorb into notes, delete the original.
- Two near-duplicate memories about the same convention → merge into one.
- An "Active" ledger entry whose teammate session no longer exists → move to "Recently done" or mark stale.
- A foot-gun bullet repeated across multiple memories → promote to a single line in the local notes file's "Common foot-guns" section.
- Attempting to edit a file under `${CLAUDE_PLUGIN_ROOT}` → that's read-only; either propose the change for upstream or add to local notes instead.
