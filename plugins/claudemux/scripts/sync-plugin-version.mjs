/**
 * sync-plugin-version — keep derived plugin metadata pinned to single
 * sources of truth.
 *
 * Two distinct sync jobs, kept together because they fire from the
 * same release pipeline step and a partial run leaves the plugin
 * inconsistent:
 *
 *   1. `.claude-plugin/plugin.json#version` is mirrored from
 *      `package.json#version`. Bumped by `changeset version` on the
 *      package; the plugin manifest must match so the Claude Code
 *      marketplace shows the same release number as the npm package.
 *
 *   2. `hooks/protocol-version` is mirrored from the
 *      `PROTOCOL_VERSION` constant in
 *      `core/src/persistence/paths.ts`. That constant is the source
 *      of truth for the `/tmp/teammate-*` + `/tmp/claude-idle/*`
 *      cross-process file protocol shared by the CLI and the Bash
 *      hooks; the hook file is the plain-text echo the hooks read at
 *      runtime (`cat .../hooks/protocol-version`) because they cannot
 *      import a TypeScript module.
 *
 * Run from `plugins/claudemux/`. Idempotent.
 */
import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const manifestPath = ".claude-plugin/plugin.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

manifest.version = pkg.version;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const pathsTs = readFileSync("core/src/persistence/paths.ts", "utf8");
const protocolMatch = pathsTs.match(
  /export\s+const\s+PROTOCOL_VERSION\s*=\s*(\d+)\b/,
);
if (protocolMatch === null) {
  throw new Error(
    "sync-plugin-version: could not find `export const PROTOCOL_VERSION = <int>` " +
      "in core/src/persistence/paths.ts — the regex is intentionally narrow; if " +
      "the constant moved or changed shape, update this script too.",
  );
}
const protocolVersion = Number.parseInt(protocolMatch[1], 10);
writeFileSync("hooks/protocol-version", `${protocolVersion}\n`);
