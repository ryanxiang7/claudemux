# feishu-channel changelog

## 0.10.0 — 2026-05-25

- (patch) Detect an exited parent by stdin EOF instead of polling process.ppid, so an orphaned channel server reliably self-terminates
- (patch) doc-comment: fetch comment text with batchQuery so local-selection comments resolve
- (minor) feishu-channel: migrate the runtime from Bun to Node
- (minor) send Feishu replies as interactive cards rendered from Markdown
- (patch) comments: rewrite decision NNNN references to topic slugs
- (minor) harden reply markdown rendering: fence-aware chunking, legacy-text edit fallback, card size guard
- (minor) render headings and GFM tables as dedicated v2 card components
- (minor) enforce byte / element / cell limits in renderer to prevent oversized or partial card sends
