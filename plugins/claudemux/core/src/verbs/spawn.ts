/**
 * `tm spawn <name> --engine <k>` — atomic teammate spawn. Decision
 * multi-engine-tui-architecture §"Round-trips are atomic by default" makes a `--prompt` an
 * atomic first turn; `--no-wait` is gone. Engine selection is the
 * explicit `--engine` flag (decision codex-engine-flag §1, carried forward).
 *
 * Phase 1 lands the skeleton: parse a `SpawnRequest`, look the engine
 * up in the registry, dispatch. With the Phase 1 empty registry, the
 * verb falls through to `noEngineRegistered()`; Phase 2 registers the
 * concrete Claude / Codex engines and the spawn round-trip becomes
 * live.
 */

import { noEngineRegistered } from './format'
import { legacyCodexPrefixWarning } from '../identity/legacy-codex-prefix'
import type {
  EngineKind,
  SpawnRequest,
  SpawnResult,
  TeammateName,
} from '../engines/types'
import type { TmResult } from '../tm'
import type { VerbContext } from './context'

export interface SpawnArgs {
  readonly name: TeammateName
  readonly engine: EngineKind
  readonly cwd: string
  readonly resumeCheckpoint: string | null
  readonly prompt: string | null
  readonly timeoutMs: number | null
  readonly displayName: string | null
}

export async function spawnVerb(args: SpawnArgs, ctx: VerbContext): Promise<TmResult> {
  const engine = ctx.engines.get(args.engine)
  if (engine === undefined) return noEngineRegistered()
  if (engine.kind !== 'claude' && args.resumeCheckpoint !== null) {
    return {
      code: 1,
      stdout: '',
      stderr: 'tm: tm spawn: --resume is not supported for codex teammates\n',
    }
  }
  if (engine.kind !== 'claude' && args.displayName !== null) {
    return {
      code: 1,
      stdout: '',
      stderr:
        'tm: tm spawn: --task is not supported for codex teammates — codex has no ' +
        'task-slug concept. Encode the slug into the teammate name ' +
        `(e.g. '${args.name}-${args.displayName}') or omit --task.\n`,
    }
  }

  // Naming-convention nudge — see identity/legacy-codex-prefix.ts. Empty
  // string when the name does not match, so the no-warning path stays a
  // single string concat.
  const warning = legacyCodexPrefixWarning('spawn', args.name, args.engine)

  const req: SpawnRequest = {
    name: args.name,
    cwd: args.cwd,
    resumeCheckpoint: args.resumeCheckpoint,
    prompt: args.prompt,
    timeoutMs: args.timeoutMs,
    displayName: args.displayName,
  }
  const result: SpawnResult = await engine.spawn(req, ctx.engineContext)
  if (result.tmResult !== undefined) {
    return { ...result.tmResult, stderr: warning + result.tmResult.stderr }
  }

  switch (result.kind) {
    case 'spawned':
      return { code: 0, stdout: `spawned: ${result.name}\n`, stderr: warning }
    case 'already-exists':
      if (args.engine === 'codex') {
        return {
          code: 1,
          stdout: '',
          stderr: `${warning}tm: codex teammate '${args.name}' already exists (engine=${result.existingEngine})\n`,
        }
      }
      return {
        code: 1,
        stdout: '',
        stderr: `${warning}tm: '${args.name}' already exists as a ${result.existingEngine} teammate\n`,
      }
    case 'failed':
      return { code: 1, stdout: '', stderr: `${warning}tm: ${result.message}\n` }
  }
}
