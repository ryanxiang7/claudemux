# Repository Instructions

## Communication

- Reply to the user in Chinese.
- Write repository instruction files and plugin-shipped agent documents in English.

## Verify Before Acting

- Treat user framing as a hypothesis. Check the actual files, scripts, and runtime contracts before changing behavior.
- When searching code, choose the narrowest repository or subdirectory scope first. This repository is the scope for claudemux work.

## Audience Boundaries

Before editing any Markdown in this repository, identify who reads that surface:

- `README.md` and `README.zh-CN.md` are human-facing product documentation. Explain user workflows, installation, and visible behavior.
- `plugins/claudemux/commands/*.md` frontmatter is human-facing slash-command UI. Keep `description` short and useful beside the command name; it is not a model auto-trigger contract.
- `plugins/claudemux/commands/*.md` body is read by Claude only after the user explicitly invokes the command. Write it as an execution guide for that command invocation. It may instruct Claude to run safe checks, ask the human to perform actions, wait for confirmation, and report results.
- `plugins/claudemux/skills/*/SKILL.md` frontmatter is model-facing skill routing metadata. Describe when the skill is relevant; keep behavioral policy and operational steps in the skill body.
- `plugins/claudemux/skills/*/SKILL.md` body is model-facing operational guidance. Assume the future agent has no prior conversation context. Give complete, actionable steps with the reason that makes each step necessary.
- `plugins/claudemux/skills/*/references/*.md` is on-demand model-facing detail. Put diagnostics, edge cases, and deeper mechanisms there when they would distract from the main skill flow.
- `plugins/claudemux/templates/CLAUDE.md.template` is always-loaded dispatcher memory copied into the user's dispatcher directory. Keep it short and durable: dispatcher identity, routing boundaries, and stable rules. Put long protocols and helper-specific mechanics in the dispatcher skill.
- `plugins/claudemux/bin/`, `plugins/claudemux/hooks/`, and `plugins/claudemux/scripts/` are executable contracts. Align command docs and skill instructions with their actual flags, stdout, and failure modes.

## Writing Agent Instructions

- Prefer "do this, because ..." over prohibition-heavy wording. Positive action plus reason is easier for future agents to follow.
- Keep development-process commentary out of shipped agent documents. Only write durable behavior rules and operational facts that make sense to a fresh agent.
- Do not explain why a rejected alternative is wrong. A fresh agent has never seen that alternative, so a warning like "do not convert this back to X" or "this used to be Y" names an unfamiliar thing and raises a question instead of answering one — it reads as noise. State the rule to follow now; drop the history of what it replaced. If a foot-gun genuinely needs guarding, encode the guard in the executable contract (script, hook, validation), not in prose aimed at a reader who lacks the context to act on it.
- Separate trigger text from behavior. If a surface is not actually used for automatic invocation, write it as user-visible documentation instead of trigger prose.
- Keep fixed command names, flags, paths, output strings, JSON keys, and code fences exact unless the task is to change that contract.

## Slash Command Methodology

- Treat `/claudemux:setup` as a guided human onboarding flow. Claude may run safe checks and the bundled setup script; the human handles package-manager installs, starting `tmux`, launching a fresh `claude`, and creating teammates because those actions may need passwords, new terminals, or startup-time settings.
- `/claudemux:setup` operates on the current working directory. If the cwd looks wrong, guide the user to exit, `cd` to the intended dispatcher directory, launch `claude`, and run the command again.
- Keep slash-command final reports short and actionable: what was checked, what changed, what remains manual, and the exact next command for the human.
