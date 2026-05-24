/**
 * The CLI front end — `tm <verb> [args...]`, as a library.
 *
 * `tm` is invoked once per command and exits; the dispatcher reads its
 * stdout, stderr, and exit code. This module is the per-invocation
 * router: parse the argument vector, route to the right handler, and
 * produce a `TmResult`. No state is held between invocations: it lives
 * in tmux, the `/tmp` protocol files, and the Claude Code projects
 * directory.
 *
 * The process entrypoint that wires `process.argv` / `process.stdin` /
 * `process.exitCode` to `runCli` is [`main.ts`](./main.ts); this
 * module exports `runCli` and `productionEnv` so a test or harness can
 * drive a single invocation in-process with controlled inputs.
 */

import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { runColumn } from './column'
import { runGrep } from './grep'
import { HELP_TEXTS, OVERVIEW_HELP, REMOVED_VERB_MESSAGES } from './help'
import { pluginJsonPath, tmWrapperPath } from './plugin-root'
import type { TmResult } from './tm'
import { runTmux } from './tmux'
import { productionRegistry } from './engines/production'
import type { NativeEnv } from './env'
import type { Engine } from './engines/engine'

import { archiveVerb } from './verbs/archive'
import { askVerb } from './verbs/ask'
import { pollVerb } from './verbs/poll'
import type { EngineContext } from './engines/types'
import { ProductionTeammateRouter } from './identity/router'
import { ProductionIdentityStore } from './persistence/identity-writer'
import type { VerbContext } from './verbs/context'
import { lsVerb } from './verbs/ls'
import { statesVerb } from './verbs/states'
import { statusVerb } from './verbs/status'
import { killVerb } from './verbs/kill'
import { spawnVerb } from './verbs/spawn'
import { sendVerb } from './verbs/send'
import { waitVerb } from './verbs/wait'
import { compactVerb } from './verbs/compact'
import { resumeVerb } from './verbs/resume'
import { lastVerb } from './verbs/last'
import { ctxVerb } from './verbs/ctx'
import { historyVerb } from './verbs/history'
import { memVerb } from './verbs/mem'
import { reloadVerb } from './verbs/reload'
import { isNonNegativeInteger } from './engines/claude/clock'
import { parseCompactArgs } from './engines/claude/compact'
import { claudeDoctor } from './engines/claude/doctor'
import { parseResumeArgs } from './engines/claude/resume'
import { parseSendArgs } from './engines/claude/send'
import { parseSpawnArgs } from './engines/claude/spawn'
import { parseWaitArgs } from './engines/claude/wait'
import { createClaudeIdentityMigrator } from './engines/claude/identity-migration'
import { readBaseRecord, readCodexMeta } from './engines/codex/persistence'
import { createCodexIdentityMigrator } from './engines/codex/identity-migration'
import type { EngineKind } from './engines/types'
import { validateTeammateName } from './identity/name'
import { formatContext, formatReload, noEngineRegistered } from './verbs/format'

/**
 * The verb-side context the engine-routed verbs consume. The router reads
 * the identity JSON; the migrators only materialise that JSON for live
 * teammates spawned before the identity store existed.
 */
function productionVerbContext(env: NativeEnv): VerbContext {
  const registry = env.engines ?? productionRegistry(env)

  const migrateCodexIdentity = createCodexIdentityMigrator(env)
  const migrateClaudeIdentity = createClaudeIdentityMigrator(env)
  const router = new ProductionTeammateRouter(registry, async (name) => {
    await migrateCodexIdentity(name)
    await migrateClaudeIdentity(name)
  })

  const engineContext: EngineContext = { now: () => Date.now(), env: process.env }
  return {
    engines: registry,
    router,
    engineContext,
    identity: new ProductionIdentityStore(),
    runColumn: env.runColumn,
  }
}

/** A `tm: <message>` error result, exit 1. */
function die(message: string): TmResult {
  return { code: 1, stdout: '', stderr: `tm: ${message}\n` }
}

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

/** A removed verb's migration message + exit 2. */
function removedVerb(message: string): TmResult {
  return { code: 2, stdout: '', stderr: message }
}

/** The unknown-subcommand error: stderr line + overview on stdout + exit 1. */
function unknownVerb(verb: string): TmResult {
  return { code: 1, stdout: OVERVIEW_HELP, stderr: `tm: unknown subcommand: ${verb}\n` }
}

/**
 * Route a `tm help <name>` invocation. Known verb (including `help`
 * itself) prints that verb's detail page; unknown verb prints a
 * stderr line + the overview + exits 1; no argument prints the
 * overview + exits 0.
 *
 * Every table lookup goes through `Object.hasOwn` — a bare
 * `HELP_TEXTS[verb]` walks the prototype chain, so a verb named
 * `toString` / `constructor` / `hasOwnProperty` would yield a function
 * from `Object.prototype` and crash the writer when the result's
 * `stdout` is shoved at `process.stdout.write`.
 */
function runHelpVerb(rest: readonly string[]): TmResult {
  const target = rest[0]
  if (target === undefined) return { code: 0, stdout: OVERVIEW_HELP, stderr: '' }
  if (target === 'help' || target === '-h' || target === '--help') {
    return { code: 0, stdout: OVERVIEW_HELP, stderr: '' }
  }
  if (Object.hasOwn(HELP_TEXTS, target)) {
    return { code: 0, stdout: HELP_TEXTS[target]!, stderr: '' }
  }
  return {
    code: 1,
    stdout: OVERVIEW_HELP,
    stderr: `tm: no help for unknown verb: ${target}\n`,
  }
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

function parseTimeoutMs(label: string, value: string | null): number | null | { error: TmResult } {
  if (value === null) return null
  if (!isNonNegativeInteger(value)) {
    return { error: die(`${label}: --timeout must be a non-negative integer (got: '${value}')`) }
  }
  return secondsToMs(value)
}

function codexNameFailure(name: string): string | null {
  const validation = validateTeammateName(name)
  return validation.kind === 'ok'
    ? null
    : `invalid codex teammate name '${name}': ${validation.reason}`
}

async function inferSpawnEngine(
  name: string,
  requested: EngineKind | null,
  ctx: VerbContext,
): Promise<EngineKind> {
  if (requested !== null) return requested
  const resolved = await ctx.router.resolve(name)
  if (resolved !== null) return resolved.engine.kind
  return 'claude'
}

function spawnCwd(name: string, engine: EngineKind, env: NativeEnv): string {
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

function codexCwd(name: string, env: NativeEnv): string {
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

interface FleetTarget {
  readonly name: string
  readonly engine: Engine
}

async function fleetTargets(ctx: VerbContext): Promise<TmResult | FleetTarget[]> {
  const engines = ctx.engines.registered()
  if (engines.length === 0) return noEngineRegistered()
  const listings = (await Promise.all(
    engines.map(async (engine) => ({
      engine,
      rows: await engine.list(ctx.engineContext),
    })),
  )).flatMap(({ engine, rows }) => rows.map((row) => ({ name: row.name, engine })))
  const seen = new Set<string>()
  const targets: FleetTarget[] = []
  for (const target of listings) {
    if (seen.has(target.name)) continue
    seen.add(target.name)
    targets.push(target)
  }
  return targets
}

async function combineResults(results: readonly Promise<TmResult>[]): Promise<TmResult> {
  let code = 0
  let stdout = ''
  let stderr = ''
  for (const result of await Promise.all(results)) {
    if (code === 0 && result.code !== 0) code = result.code
    stdout += result.stdout
    stderr += result.stderr
  }
  return { code, stdout, stderr }
}

type ReloadArgs = { readonly all: boolean; readonly repos: readonly string[] } | { readonly error: TmResult }

function parseReloadTargets(rest: readonly string[]): ReloadArgs {
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

// ─── Engine-routed teammate verbs ─────────────────────────────────────────

const ENGINE_VERBS: ReadonlySet<string> = new Set([
  'ls',
  'states',
  'status',
  'kill',
  'spawn',
  'send',
  'wait',
  'compact',
  'resume',
  'last',
  'ctx',
  'history',
  'mem',
  'reload',
])

async function dispatchEngineVerb(
  verb: string,
  rest: readonly string[],
  ctx: VerbContext,
  env: NativeEnv,
): Promise<TmResult> {
  switch (verb) {
    case 'ls':
      return lsVerb(ctx)
    case 'states':
      return statesVerb(ctx)
    case 'status': {
      if (rest.length === 0) {
        return { code: 1, stdout: '', stderr: 'tm: usage: tm status <repo> [lines=80]\n' }
      }
      const lines = rest[1]
      const parsed = lines === undefined ? null : Number(lines)
      const linesArg = parsed === null || !Number.isFinite(parsed) ? null : parsed
      return statusVerb(rest[0]!, ctx, { lines: linesArg })
    }
    case 'kill':
      if (rest.length === 0) return { code: 1, stdout: '', stderr: 'tm: usage: tm kill <repo>\n' }
      return killVerb(rest[0]!, ctx)
    case 'spawn': {
      const name = rest[0] ?? ''
      if (name.length === 0) {
        return die('usage: tm spawn <repo> [--task <slug>] [--prompt "..."]')
      }
      const parsed = parseSpawnArgs(rest.slice(1))
      if ('error' in parsed) return parsed.error
      const timeoutMs = parseTimeoutMs('tm spawn', parsed.timeout)
      if (timeoutMs !== null && typeof timeoutMs === 'object') return timeoutMs.error
      const engine = await inferSpawnEngine(name, parsed.engine, ctx)
      if (engine === 'codex') {
        const invalidName = codexNameFailure(name)
        if (invalidName !== null) return die(invalidName)
      }
      return spawnVerb(
        {
          name,
          engine,
          cwd: spawnCwd(name, engine, env),
          resumeCheckpoint: parsed.resumeSid.length === 0 ? null : parsed.resumeSid,
          prompt: parsed.hasPrompt ? parsed.prompt : null,
          timeoutMs,
          displayName: parsed.task.length === 0 ? null : parsed.task,
        },
        ctx,
      )
    }
    case 'send': {
      const parsed = parseSendArgs(rest)
      if ('error' in parsed) return parsed.error
      if (parsed.repo === '') {
        return die(
          'tm send: missing <repo>. Usage: tm send <repo> --prompt "..." ' +
            '[--pane-quiet] [--timeout N]',
        )
      }
      if (!parsed.hasPrompt) {
        return die(
          'tm send: missing --prompt. Usage: tm send <repo> --prompt "..." ' +
            '[--pane-quiet] [--timeout N]',
        )
      }
      const timeoutMs = parseTimeoutMs('tm send', parsed.timeout)
      if (timeoutMs !== null && typeof timeoutMs === 'object') return timeoutMs.error
      return sendVerb(
        {
          name: parsed.repo,
          prompt: parsed.prompt,
          timeoutMs,
          paneQuiet: parsed.paneQuiet,
        },
        ctx,
      )
    }
    case 'wait': {
      const parsed = parseWaitArgs(rest)
      if ('error' in parsed) return parsed.error
      if (parsed.repo === '') {
        return die('usage: tm wait <repo> [timeout=1800] [--fresh] [--pane-quiet] [--timeout N]')
      }
      const timeoutMs = parseTimeoutMs('tm wait', parsed.timeout)
      if (timeoutMs !== null && typeof timeoutMs === 'object') return timeoutMs.error
      return waitVerb(
        {
          name: parsed.repo,
          recoverFor: null,
          timeoutMs,
          fresh: parsed.fresh,
          paneQuiet: parsed.paneQuiet,
        },
        ctx,
      )
    }
    case 'compact': {
      const parsed = parseCompactArgs(rest)
      if ('error' in parsed) return parsed.error
      const timeoutMs = parseTimeoutMs('tm compact', parsed.timeout)
      if (timeoutMs !== null && typeof timeoutMs === 'object') return timeoutMs.error
      return compactVerb(parsed.repo, ctx, { timeoutMs })
    }
    case 'resume': {
      const parsed = parseResumeArgs(rest)
      if ('error' in parsed) return parsed.error
      if (parsed.repo === '') {
        return die(
          'usage: tm resume <repo> [<sid-or-thread-id>] [--task <slug>] [--prompt "..."] ' +
            '[--engine claude|codex]  (id may be omitted: claudemux probes both engines ' +
            'for a resumable session and routes the single candidate; if both engines have ' +
            'history, use --engine to disambiguate)',
        )
      }
      // `codexCwd`'s last-resort fallback is the dispatcher dir itself (when
      // neither a Codex record nor a real repo subdirectory exists). That
      // fallback is fine for the checkpoint-reverse path — the engine never
      // reads `cwd` if `checkpoint` matches a rollout — but it would make
      // the Claude-side probe match the dispatcher's own transcripts and
      // false-route. Flag whether the cwd is trustworthy so the probing
      // branch can skip itself in the dispatcher-fallback case and avoid
      // guessing an engine from the dispatcher's own transcripts.
      const repoPath = join(env.dispatcherDir, parsed.repo)
      const cwdProbeable =
        readBaseRecord(parsed.repo) !== null ||
        readCodexMeta(parsed.repo) !== null ||
        isDirectory(repoPath)
      return resumeVerb(
        {
          name: parsed.repo,
          cwd: codexCwd(parsed.repo, env),
          checkpoint: parsed.sid.length === 0 ? null : parsed.sid,
          prompt: parsed.hasPrompt ? parsed.prompt : null,
          displayName: parsed.task.length === 0 ? null : parsed.task,
          engineHint: parsed.engine,
          projectsDir: env.projectsDir,
          cwdProbeable,
        },
        ctx,
      )
    }
    case 'last': {
      const name = rest[0] ?? ''
      if (name.length === 0) return die('usage: tm last <repo>')
      return lastVerb(name, ctx)
    }
    case 'ctx': {
      const parsed = parseCtxArgs(rest)
      if ('error' in parsed) return parsed.error
      const results = parsed.repos.map((name) =>
        ctxVerb(name, ctx, { windowOverride: parsed.windowOverride }),
      )
      if (parsed.all) {
        const targets = await fleetTargets(ctx)
        if (!Array.isArray(targets)) return targets
        results.push(
          ...targets.map(async (target) =>
            formatContext(
              await target.engine.ctx(
                { name: target.name, windowOverride: parsed.windowOverride },
                ctx.engineContext,
              ),
            ),
          ),
        )
      }
      if (results.length === 0) {
        return die('usage: tm ctx <repo> [<repo>...] | --all  [--window 200k|1m]')
      }
      return combineResults(results)
    }
    case 'history': {
      const name = rest[0] ?? ''
      if (name.length === 0) return die('usage: tm history <repo> [<sid-or-thread-prefix>]')
      return historyVerb({ name, cwd: codexCwd(name, env), index: rest[1] ?? null }, ctx)
    }
    case 'mem': {
      const name = rest[0] ?? ''
      if (name.length === 0) return die('usage: tm mem <repo>')
      return memVerb(name, ctx)
    }
    case 'reload': {
      const parsed = parseReloadTargets(rest)
      if ('error' in parsed) return parsed.error
      let stdout = ''
      let stderr = ''
      if (parsed.all) {
        const targets = await fleetTargets(ctx)
        if (!Array.isArray(targets)) return targets
        if (targets.length === 0) {
          return { code: 0, stdout: '(no teammate sessions to reload)\n', stderr: '' }
        }
        for (const target of targets) {
          const result = formatReload(
            await target.engine.reload({ name: target.name }, ctx.engineContext),
          )
          stdout += result.stdout
          stderr += result.stderr
          if (result.code !== 0) return { code: result.code, stdout, stderr }
        }
      } else {
        for (const target of parsed.repos) {
          const result = await reloadVerb(target, ctx)
          stdout += result.stdout
          stderr += result.stderr
          if (result.code !== 0) return { code: result.code, stdout, stderr }
        }
      }
      return { code: 0, stdout, stderr }
    }
    default:
      return { code: 1, stdout: '', stderr: `tm: unsupported engine verb: ${verb}\n` }
  }
}

type CtxWindowOverride = '' | '200k' | '1m'
type CtxArgs =
  | { repos: string[]; windowOverride: CtxWindowOverride; all: boolean }
  | { error: TmResult }

function parseCtxArgs(args: readonly string[]): CtxArgs {
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

async function doctorDispatch(args: readonly string[], env: NativeEnv): Promise<TmResult> {
  return claudeDoctor(args, env, {
    tmWrapper: tmWrapperPath(),
    pluginJson: pluginJsonPath(),
  })
}

// ─── status (legacy compat) — exclusively for non-engine-verb fallback ─────
// The Claude `tm status` body lives at the engine layer (verbs/status.ts via
// ClaudeEngine.status). The codex fork is handled in ENGINE_VERBS dispatch
// through the engine registry. This file does NOT define another status path.

/**
 * Dispatch one CLI invocation. `argv` is the argument vector after the
 * program name (`process.argv.slice(2)`).
 *
 * Routing order:
 *   1. Bare `tm`                    → overview, exit 0
 *   2. `tm help [<verb>]`           → per-verb or overview, exit 0/1
 *   3. Help pre-scan on `rest`      → per-verb (if HELP_TEXTS) or overview, exit 0
 *   4. Removed verb                 → migration message, exit 2
 *   5. Engine-routed teammate verbs → verbs/<v>.ts → router/registry → engine
 *   6. Dispatcher-only / diagnostic  → local verb
 *   7. Unknown verb                  → stderr + overview, exit 1
 */
export async function runCli(
  argv: readonly string[],
  env: NativeEnv,
  stdin?: string,
): Promise<TmResult> {
  const [verb, ...rest] = argv
  // 1. Bare `tm` (or `tm ""`, mirroring bash `${1:-help}` which fires
  //    on both unset and null/empty) — fall through to the overview.
  if (verb === undefined || verb === '') {
    return { code: 0, stdout: OVERVIEW_HELP, stderr: '' }
  }

  // 2. The `help` / `-h` / `--help` verb forms.
  if (verb === 'help' || verb === '-h' || verb === '--help') {
    return runHelpVerb(rest)
  }

  // 3. Help pre-scan — `tm <verb> --help` prints that verb's detail.
  //    Every dispatch-table lookup below uses `Object.hasOwn` so a verb
  //    name that collides with an Object.prototype key does not walk
  //    the prototype chain.
  if (triggersHelp(rest)) {
    const text = Object.hasOwn(HELP_TEXTS, verb) ? HELP_TEXTS[verb]! : OVERVIEW_HELP
    return { code: 0, stdout: text, stderr: '' }
  }

  // 4. Removed verbs — migration error on stderr, exit 2.
  if (Object.hasOwn(REMOVED_VERB_MESSAGES, verb)) {
    return removedVerb(REMOVED_VERB_MESSAGES[verb]!)
  }

  // 5. Engine-routed teammate verbs — parse at the CLI boundary, then
  //    `verbs/<v>.ts` → `EngineRegistry` / router → concrete Engine methods.
  if (ENGINE_VERBS.has(verb)) {
    return dispatchEngineVerb(verb, rest, productionVerbContext(env), env)
  }

  // 6. Dispatcher-only / diagnostic verbs.
  switch (verb) {
    case 'archive':
      return archiveVerb(rest, stdin, {
        dispatcherDir: env.dispatcherDir,
        projectsDir: env.projectsDir,
      })
    case 'doctor':
      return doctorDispatch(rest, env)
    case 'poll':
      return pollVerb(rest, env)
    case 'ask':
      return askVerb(rest)
    default:
      // 7. Unknown verb.
      return unknownVerb(verb)
  }
}

/** The production `NativeEnv` — the real backends, resolved once per invocation. */
export function productionEnv(): NativeEnv {
  const env: NativeEnv = {
    runTmux,
    runColumn,
    runGrep,
    // `tm` resolves the dispatcher dir from `TM_DISPATCHER_DIR` or
    // `$PWD` (bash's `${TM_DISPATCHER_DIR:-$PWD}`). Two semantics matter:
    //   - `$PWD` is the *logical* cwd, preserving the symlink the user
    //     `cd`'d through; Node's `process.cwd()` would return the
    //     symlink-resolved physical path, and `~/.claude/projects`
    //     lookups would diverge between bash and native on a symlinked
    //     dispatcher tree.
    //   - bash `${VAR:-default}` triggers the default on *unset* OR
    //     *empty*, so `||` (which treats empty strings as falsy) is the
    //     right operator — `??` would let an accidentally-empty
    //     `TM_DISPATCHER_DIR` through and resolve `<repo>` paths against
    //     `""`.
    dispatcherDir: process.env.TM_DISPATCHER_DIR || process.env.PWD || process.cwd(),
    projectsDir: join(process.env.HOME ?? homedir(), '.claude', 'projects'),
  }
  return { ...env, engines: productionRegistry(env) }
}
