---
"claudemux": minor
---

add `PROTOCOL_VERSION` substrate for the `/tmp/teammate-*` + `/tmp/claude-idle/*` cross-process file protocol

- new constant `PROTOCOL_VERSION` exported from `core/src/persistence/paths.ts` — the source of truth for the protocol the CLI and the Bash hooks share
- new plain-text file `hooks/protocol-version` mirroring the constant; read by the hooks at runtime because Bash cannot import a TypeScript module
- new CLI flag `tm --protocol-version` prints the integer as a single line on stdout (no JSON, no verb dispatch) so hook scripts and future `tm doctor --json` consumers can probe the CLI cheaply
- `scripts/sync-plugin-version.mjs` extended to mirror the constant into the hook file at release time; a vitest unit test fails CI if the two ever drift

No behavior change in any existing verb. Foundation for the multi-PR `tm` CLI / claudemux plugin decoupling tracked in excitedjs/dreamux#9.
