/**
 * `tm resume <name> [checkpoint]` — relaunch a previous teammate session.
 *
 * Engine selection priority (literal per the resume-probing design):
 *   1. explicit `--engine` flag       — caller's override, wins unconditionally
 *   2. checkpoint-from-rollout        — a Codex thread-id maps to a rollout
 *      (existing `codexFromRollout` logic — preserves `tm resume <name> <thread-id>`
 *      after `tm kill` has removed the base record)
 *   3. router resolution              — an existing teammate's recorded engine
 *   4. cwd probing                    — both engines are asked whether they
 *      hold history for the teammate's cwd; single candidate auto-routes,
 *      double candidate is an ambiguity error, no candidate is "no resumable
 *      session" — see decision context in the PR.
 *   5. not-found                      — when probing cannot run (cwd unknown)
 *      and the identity router cannot resolve the name.
 */

import { hasClaudeHistoryForCwd } from '../engines/claude/history'
import { hasCodexHistoryForCwd } from '../engines/codex/history'
import { legacyCodexPrefixWarning } from '../identity/legacy-codex-prefix'
import { formatResume } from './format'
import { findCodexRolloutFile } from '../engines/codex/rollout'
import { resolveTargetEngine } from './resolve'
import type { Engine } from '../engines/engine'
import type { EngineKind, ResumeRequest, TeammateName } from '../engines/types'
import type { TmResult } from '../tm'
import type { VerbContext } from './context'

export interface ResumeArgs {
  readonly name: TeammateName
  readonly cwd: string | null
  readonly checkpoint: string | null
  readonly prompt: string | null
  readonly displayName: string | null
  /** `tm resume --engine claude|codex` — overrides every other selector. */
  readonly engineHint: EngineKind | null
  /** `~/.claude/projects` (or test override) — needed for Claude-side probing. */
  readonly projectsDir: string
  /**
   * Whether `cwd` was derived from a real source (a Codex base record /
   * meta, or an existing dispatcher subdirectory) rather than the
   * `codexCwd` last-resort fallback to the dispatcher dir itself.
   * Probing must skip itself when this is `false`, or it would match
   * the dispatcher's own transcripts and false-route.
   */
  readonly cwdProbeable: boolean
}

function die(message: string): TmResult {
  return { code: 1, stdout: '', stderr: `tm: ${message}\n` }
}

async function dispatchResume(engine: Engine, args: ResumeArgs, ctx: VerbContext): Promise<TmResult> {
  const req: ResumeRequest = {
    name: args.name,
    cwd: args.cwd,
    checkpoint: args.checkpoint,
    prompt: args.prompt,
    displayName: args.displayName,
  }
  // Resume's engine resolution is the only point we know the final engine
  // kind for this teammate — wire the legacy-prefix warning here so it
  // fires on every routing branch (--engine, checkpoint reverse-lookup,
  // router, cwd probing) without duplicating the check at each callsite.
  const warning = legacyCodexPrefixWarning('resume', args.name, engine.kind)
  const result = formatResume(await engine.resume(req, ctx.engineContext))
  return warning === '' ? result : { ...result, stderr: warning + result.stderr }
}

export async function resumeVerb(args: ResumeArgs, ctx: VerbContext): Promise<TmResult> {
  // 1. Explicit --engine wins unconditionally — caller's override.
  if (args.engineHint !== null) {
    const engine = ctx.engines.get(args.engineHint)
    if (engine === undefined) {
      return die(`resume: --engine ${args.engineHint} is not registered in this process`)
    }
    return dispatchResume(engine, args, ctx)
  }

  // 2. Checkpoint reverse-lookup — a passed thread-id that maps to a
  // Codex rollout. Preserves `tm resume <name> <thread-id>` after kill.
  const codex = ctx.engines.get('codex')
  if (
    args.checkpoint !== null &&
    codex !== undefined &&
    findCodexRolloutFile(args.checkpoint, ctx.engineContext.env) !== null
  ) {
    return dispatchResume(codex, args, ctx)
  }

  // 3. Router — an existing teammate's recorded engine.
  const resolved = await ctx.router.resolve(args.name)
  if (resolved !== null) {
    return dispatchResume(resolved.engine, args, ctx)
  }

  // 4. cwd probing — single candidate auto-routes; double = ambiguity error.
  // Probing is only meaningful when there is no checkpoint to disambiguate,
  // and only safe when the cwd actually points at the teammate's repo.
  if (args.checkpoint === null && args.cwd !== null && args.cwdProbeable) {
    const claude = ctx.engines.get('claude')
    const codexHas = codex !== undefined && hasCodexHistoryForCwd(args.cwd, ctx.engineContext.env)
    const claudeHas = claude !== undefined && hasClaudeHistoryForCwd(args.cwd, args.projectsDir)

    if (codexHas && claudeHas) {
      return die(
        `resume: ambiguous — both codex and claude have resumable history for ` +
          `cwd ${args.cwd}. Pass --engine codex|claude, or give an explicit ` +
          `<sid> (claude) / <thread-id> (codex).`,
      )
    }
    if (codexHas) return dispatchResume(codex!, args, ctx)
    if (claudeHas) return dispatchResume(claude!, args, ctx)
    return die(
      `resume: no resumable session for ${args.name} — no Claude transcript ` +
        `under projectsDir and no Codex rollout for cwd ${args.cwd}. ` +
        `To start a new session, use 'tm spawn ${args.name} [--engine codex|claude]'.`,
    )
  }

  // 5. Not found — cwd is unknown (or checkpoint passed but unmatched). The
  // production router may have migrated a live pre-identity teammate above;
  // if resolution is still empty, there is no engine-safe target.
  const engine = await resolveTargetEngine(args.name, ctx)
  if ('code' in engine) return engine
  return dispatchResume(engine, args, ctx)
}
