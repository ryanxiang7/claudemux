/**
 * `tm history <name> [index]` — turn-by-turn history. Decision 0024
 * §"`history` and `mem` stay" keeps the verb alive on both engines.
 * The Claude engine reads `~/.claude/projects/<encoded>/*.jsonl`;
 * the Codex engine returns `not-supported` until upstream exposes
 * thread enumeration.
 */

import { formatHistory } from './format'
import type { HistoryRequest, TeammateName } from '../engines/types'
import type { TmResult } from '../tm'
import type { VerbContext } from './context'
import { resolveTargetEngine } from './resolve'
import { hasCodexHistoryForCwd } from '../engines/codex/history'

export interface HistoryArgs {
  readonly name: TeammateName
  readonly cwd: string | null
  /** `null` = list view; non-null = engine-specific detail selector. */
  readonly index: string | null
}

export async function historyVerb(args: HistoryArgs, ctx: VerbContext): Promise<TmResult> {
  const resolved = await ctx.router.resolve(args.name)
  const codexFromHistory =
    resolved === null &&
    args.cwd !== null &&
    ctx.engines.get('codex') !== undefined &&
    hasCodexHistoryForCwd(args.cwd, ctx.engineContext.env)
  const engine = codexFromHistory
    ? ctx.engines.get('codex')!
    : resolved?.engine ?? await resolveTargetEngine(args.name, ctx)
  if ('code' in engine) return engine

  const req: HistoryRequest = { name: args.name, cwd: args.cwd, index: args.index }
  return formatHistory(await engine.history(req, ctx.engineContext))
}
