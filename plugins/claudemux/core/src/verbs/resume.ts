/**
 * `tm resume <name> [checkpoint]` — relaunch a previous teammate session.
 */

import { formatResume } from './format'
import type { ResumeRequest, TeammateName } from '../engines/types'
import type { TmResult } from '../tm'
import type { VerbContext } from './context'
import { resolveTargetEngine } from './resolve'
import { findCodexRolloutFile } from '../engines/codex/rollout'

export interface ResumeArgs {
  readonly name: TeammateName
  readonly cwd: string | null
  readonly checkpoint: string | null
  readonly prompt: string | null
  readonly displayName: string | null
}

export async function resumeVerb(args: ResumeArgs, ctx: VerbContext): Promise<TmResult> {
  const resolved = await ctx.router.resolve(args.name)
  // After `tm kill`, a non-prefix Codex teammate has no base record left.
  // This narrow explicit-thread lookup preserves `tm resume <name> <thread-id>`;
  // no-id auto-pick lives inside CodexEngine and uses Codex's native thread/list RPC.
  const codexFromRollout =
    resolved === null &&
    args.checkpoint !== null &&
    ctx.engines.get('codex') !== undefined &&
    findCodexRolloutFile(args.checkpoint, ctx.engineContext.env) !== null
  const engine = codexFromRollout
    ? ctx.engines.get('codex')!
    : resolved?.engine ?? await resolveTargetEngine(args.name, ctx)
  if ('code' in engine) return engine

  const req: ResumeRequest = {
    name: args.name,
    cwd: args.cwd,
    checkpoint: args.checkpoint,
    prompt: args.prompt,
    displayName: args.displayName,
  }
  return formatResume(await engine.resume(req, ctx.engineContext))
}
