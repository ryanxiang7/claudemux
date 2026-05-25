/**
 * Naming-style suggestion for the legacy `codex-` teammate prefix.
 *
 * Background: before the explicit `--engine codex` flag landed
 * (decision codex-engine-flag), a teammate name of the form `codex-foo`
 * implicitly meant "this is a Codex teammate". Decision
 * multi-engine-tui-architecture retired that name-based routing — engine
 * identity is now the per-teammate JSON `engine` field — and the
 * teammate name is just an arbitrary label with no behavioural meaning.
 *
 * The prefix shape still circulates in user habit and dispatcher
 * scripts. Two visually distinct conventions (`codex-foo` vs the nested
 * `codex/foo`) for the same intent make humans think there is a choice
 * to remember. This helper emits a one-line stderr suggestion on
 * creation paths (`tm spawn`, `tm resume`) when the resolved engine is
 * `codex` and the name carries the legacy prefix. It does not promise
 * a future hard error, does not change behaviour, and does not reserve
 * any name shape — the `codex-` prefix is a normal label and `tm spawn
 * codex-foo --engine codex` continues to be a fully supported call.
 * The line is informational: it points at the nested form for users
 * who would prefer to use it.
 *
 * Why only creation paths? The user picks the name once at spawn /
 * resume; suggesting an alternative on every `tm send codex-foo ...`
 * afterwards would be pure noise without giving the user any new lever
 * to act on.
 */

import type { EngineKind, TeammateName } from '../engines/types'

/**
 * `tm spawn:` / `tm resume:` prefix is supplied by the caller so the
 * stderr line is attributable to the verb the user actually invoked.
 */
export function legacyCodexPrefixWarning(
  verb: 'spawn' | 'resume',
  name: TeammateName,
  engine: EngineKind,
): string {
  if (engine !== 'codex') return ''
  if (!name.startsWith('codex-')) return ''
  const suffix = name.slice('codex-'.length)
  const suggested = suffix.length === 0 ? 'codex/<name>' : `codex/${suffix}`
  return (
    `tm ${verb}: note — name '${name}' uses the legacy 'codex-' prefix from ` +
    `before --engine was explicit. Both shapes are supported; if you want ` +
    `to group codex teammates under a namespace, the nested form ` +
    `'${suggested}' is the typical choice.\n`
  )
}
