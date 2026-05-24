import { realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { isNonNegativeInteger } from '../engines/claude/clock'
import { readBaseRecord, readCodexMeta } from '../engines/codex/persistence'
import type { EngineKind } from '../engines/types'
import type { NativeEnv } from '../env'
import { validateTeammateName } from '../identity/name'
import type { TmResult } from '../tm'
import type { VerbContext } from '../verbs/context'
import { die } from './errors'

/**
 * Whether `tm`'s help pre-scan would intercept these verb arguments.
 * The scan walks left to right: a `-h`/`--help` triggers help; a
 * `--prompt` value or the first non-flag positional stops it (help
 * text must not swallow prompt data that happens to contain `--help`).
 *
 * Exported because `main.ts` needs it too: a verb that reads stdin
 * (only `archive`) must not slurp stdin when the invocation is going
 * to print help, since the help dispatch never reaches the reader and
 * a pipe held open by an upstream producer would block the launcher
 * forever.
 */
export function triggersHelp(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === '-h' || arg === '--help') return true
    if (arg === '--prompt' || arg.startsWith('--prompt=')) return false
    if (!arg.startsWith('-')) return false
  }
  return false
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function secondsToMs(value: string | null): number | null {
  return value === null ? null : Number(value) * 1000
}

export function parseTimeoutMs(
  label: string,
  value: string | null,
): number | null | { error: TmResult } {
  if (value === null) return null
  if (!isNonNegativeInteger(value)) {
    return { error: die(`${label}: --timeout must be a non-negative integer (got: '${value}')`) }
  }
  return secondsToMs(value)
}

export function codexNameFailure(name: string): string | null {
  const validation = validateTeammateName(name)
  return validation.kind === 'ok'
    ? null
    : `invalid codex teammate name '${name}': ${validation.reason}`
}

export async function inferSpawnEngine(
  name: string,
  requested: EngineKind | null,
  ctx: VerbContext,
): Promise<EngineKind> {
  if (requested !== null) return requested
  const resolved = await ctx.router.resolve(name)
  if (resolved !== null) return resolved.engine.kind
  return 'claude'
}

export function spawnCwd(name: string, engine: EngineKind, env: NativeEnv): string {
  if (engine === 'codex') {
    const repoPath = join(env.dispatcherDir, name)
    return isDirectory(repoPath) ? realpathSync(repoPath) : realpathSync(env.dispatcherDir)
  }
  return join(env.dispatcherDir, name)
}

function normalizeExistingCwd(cwd: string): string {
  try {
    return realpathSync(cwd)
  } catch {
    return cwd
  }
}

export function codexCwd(name: string, env: NativeEnv): string {
  const baseCwd = readBaseRecord(name)?.cwd
  if (baseCwd !== undefined) return normalizeExistingCwd(baseCwd)
  const metaCwd = readCodexMeta(name)?.cwd
  if (metaCwd !== undefined) return normalizeExistingCwd(metaCwd)
  try {
    // Killed non-prefix Codex teammates have no base record; use the same cwd
    // inference as spawn/resume so rollout-history routing can still find them.
    return spawnCwd(name, 'codex', env)
  } catch {
    return process.cwd()
  }
}

export function resumeCwdProbeable(name: string, env: NativeEnv): boolean {
  const repoPath = join(env.dispatcherDir, name)
  return readBaseRecord(name) !== null || readCodexMeta(name) !== null || isDirectory(repoPath)
}

export type CtxWindowOverride = '' | '200k' | '1m'
export type CtxArgs =
  | { repos: string[]; windowOverride: CtxWindowOverride; all: boolean }
  | { error: TmResult }

export function parseCtxArgs(args: readonly string[]): CtxArgs {
  const repos: string[] = []
  let windowOverride: CtxWindowOverride | string = ''
  let all = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--all') {
      all = true
    } else if (arg === '--window') {
      if (i + 1 >= args.length) return { error: { code: 1, stdout: '', stderr: '' } }
      windowOverride = args[i + 1]!
      i++
    } else if (arg.startsWith('--window=')) {
      windowOverride = arg.slice('--window='.length)
    } else if (arg.startsWith('-')) {
      return { error: die(`tm ctx: unknown flag: ${arg}`) }
    } else {
      repos.push(arg)
    }
  }
  if (windowOverride !== '' && windowOverride !== '200k' && windowOverride !== '1m') {
    return { error: die('tm ctx: --window must be 200k or 1m') }
  }
  return { repos, windowOverride: windowOverride as CtxWindowOverride, all }
}

export type ReloadArgs =
  | { readonly all: boolean; readonly repos: readonly string[] }
  | { readonly error: TmResult }

export function parseReloadTargets(rest: readonly string[]): ReloadArgs {
  let all = false
  const repos: string[] = []
  for (const arg of rest) {
    if (arg === '--all') all = true
    else if (arg === '-h' || arg === '--help') {
      return { error: die('usage: tm reload <repo>... | --all') }
    } else if (arg.startsWith('-')) {
      return { error: die(`tm reload: unknown flag: ${arg}`) }
    } else {
      repos.push(arg)
    }
  }

  if (all) {
    if (repos.length > 0) return { error: die('tm reload: --all conflicts with explicit repos') }
  } else if (repos.length === 0) {
    return { error: die('usage: tm reload <repo>... | --all') }
  }
  return { all, repos }
}
