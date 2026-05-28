---
"claudemux": minor
---

add `tm doctor --json` — the machine-readable doctor branch committed to dreamux in excitedjs/dreamux#9

- new structured `DoctorReport` (schema=1) emitted on stdout: `cliVersion`, `protocolVersion`, `node`, `binary`, `dispatcherDir`, `dirs`, `hooks`, `engines.claude`, `engines.codex`, `teammates`, `health`, `issues`
- issue codes (`HOOK_MISSING`, `HOOK_PROTOCOL_MISMATCH`, `HOOK_NEVER_FIRED`, `TMUX_MISSING`, `CODEX_MISSING`, `DISPATCHER_DIR_UNUSABLE`, `STALE_CODEX_DAEMON`, `NODE_TOO_OLD`) — the load-bearing routing keys; message text may change between releases
- health rollup: `unhealthy` when neither engine is usable or the dispatcher dir is missing → exit 5; `degraded` when at least one engine works but warnings exist; `ok` otherwise → exit 0 for both
- JSON mode is **read-only** — never reaps orphan Codex daemons (the text branch keeps its current reaping side-effect). A `STALE_CODEX_DAEMON` warning surfaces them; operators run `tm doctor` (text mode) to reap

Text mode (`tm doctor` without `--json`) is unchanged. All existing doctor tests in `cli.test.ts` continue to pass.

Foundation for the `--engine codex` filter and Claude-engine fail-fast sub-PRs, which both consume `protocolVersion` / `hooks.installed` checks the report exposes.
