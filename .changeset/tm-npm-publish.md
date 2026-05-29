---
"@excitedjs/tm": minor
---

Publish tm as the `@excitedjs/tm` npm package. The package includes only the tm CLI sources (`bin/tm`, `src/`, `resolver*.mjs`, `third_party/ws/`) via an explicit `files` allowlist; all Claude plugin files (hooks, skills, .claude-plugin, commands, templates) are excluded. Running `npx @excitedjs/tm` installs and runs tm without a build step — Node 22.7+ runs the TypeScript sources directly via `--experimental-transform-types`.
