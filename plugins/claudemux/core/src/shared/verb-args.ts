/**
 * Shared CLI argument parsers for teammate verbs.
 *
 * These parsers sit outside any concrete engine because `tm spawn` and
 * `tm resume` carry cross-engine flags (`--engine`) even when the eventual
 * request is routed to Claude or Codex. Keeping them here prevents the CLI
 * layer from importing parser helpers out of `engines/claude/`.
 */

import type { TmResult } from '../tm'

type EngineFlag = 'claude' | 'codex'

function die(message: string): TmResult {
  return { code: 1, stdout: '', stderr: `tm: ${message}\n` }
}

/** Parsed arg vector for `tm compact`. */
export interface CompactArgs {
  repo: string
  timeout: string
}

/** Parsed arg vector for `tm resume`. */
export interface ResumeArgs {
  repo: string
  sid: string
  task: string
  prompt: string
  hasPrompt: boolean
  engine: EngineFlag | null
}

/** Parsed arg vector for `tm send`. */
export interface SendArgs {
  repo: string
  prompt: string
  hasPrompt: boolean
  paneQuiet: boolean
  timeout: string | null
}

/** Parsed arg vector for `tm spawn`. */
export interface SpawnArgs {
  engine: EngineFlag | null
  resumeSid: string
  task: string
  prompt: string
  hasPrompt: boolean
  timeout: string | null
}

/** Parsed arg vector for `tm wait`. */
export interface WaitArgs {
  repo: string
  timeout: string | null
  fresh: boolean
  paneQuiet: boolean
}

/**
 * `cmd_compact`'s arg loop: same positional-then-flag rule as `wait`.
 * `--timeout` with no value is bash's silent-exit-1 case; mirror that.
 */
export function parseCompactArgs(args: readonly string[]): CompactArgs | { error: TmResult } {
  const SILENT: TmResult = { code: 1, stdout: '', stderr: '' }
  let repo = ''
  let timeout = '1800'
  let i = 0
  while (i < args.length) {
    const arg = args[i]!
    if (arg === '--timeout') {
      if (i + 1 >= args.length) return { error: SILENT }
      timeout = args[i + 1]!
      i += 2
    } else if (arg.startsWith('--timeout=')) {
      timeout = arg.slice('--timeout='.length)
      i++
    } else if (arg.startsWith('-')) {
      return { error: die(`tm compact: unknown flag: ${arg}`) }
    } else if (repo === '') {
      repo = arg
      i++
    } else {
      timeout = arg
      i++
    }
  }
  return { repo, timeout }
}

/**
 * `cmd_resume`'s arg loop; two positionals (`<repo> [<sid>]`) plus
 * flags. Like `cmd_spawn`, `--task` is bash's silent-exit-1 path (no
 * `[[ $# -ge 2 ]]` guard); `--prompt` is the explicit-die path.
 * `--engine` is the explicit-die path too — it carries a required
 * `claude`/`codex` value, parallel to `tm spawn --engine`.
 */
export function parseResumeArgs(args: readonly string[]): ResumeArgs | { error: TmResult } {
  const SILENT: TmResult = { code: 1, stdout: '', stderr: '' }
  let repo = ''
  let sid = ''
  let task = ''
  let prompt = ''
  let hasPrompt = false
  let engine: EngineFlag | null = null
  let i = 0
  while (i < args.length) {
    const arg = args[i]!
    if (arg === '--prompt') {
      if (i + 1 >= args.length) return { error: die('tm resume: --prompt requires a value') }
      prompt = args[i + 1]!
      hasPrompt = true
      i += 2
    } else if (arg.startsWith('--prompt=')) {
      prompt = arg.slice('--prompt='.length)
      hasPrompt = true
      i++
    } else if (arg === '--task') {
      if (i + 1 >= args.length) return { error: SILENT }
      task = args[i + 1]!
      i += 2
    } else if (arg.startsWith('--task=')) {
      task = arg.slice('--task='.length)
      i++
    } else if (arg === '--engine') {
      if (i + 1 >= args.length) return { error: die('tm resume: --engine requires a value') }
      const value = args[i + 1]!
      if (value !== 'claude' && value !== 'codex') {
        return { error: die(`tm resume: --engine must be 'claude' or 'codex' (got: '${value}')`) }
      }
      engine = value
      i += 2
    } else if (arg.startsWith('--engine=')) {
      const value = arg.slice('--engine='.length)
      if (value !== 'claude' && value !== 'codex') {
        return { error: die(`tm resume: --engine must be 'claude' or 'codex' (got: '${value}')`) }
      }
      engine = value
      i++
    } else if (arg === '--') {
      i++
      break
    } else if (arg.startsWith('-')) {
      return { error: die(`unknown flag: ${arg}`) }
    } else if (repo === '') {
      repo = arg
      i++
    } else if (sid === '') {
      sid = arg
      i++
    } else {
      return {
        error: die(
          `tm resume: too many positional args (got '${arg}' after ` +
            `repo='${repo}' sid='${sid}')`,
        ),
      }
    }
  }
  return { repo, sid, task, prompt, hasPrompt, engine }
}

/**
 * Single-quote-escape a string for safe embedding in a bash command
 * line — used by the legacy-form error suggestion below.
 */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * `cmd_send`'s arg loop. Catches the legacy "tm send repo run tests"
 * form with a dedicated error — pre-0.3.0 callers passed prompts as
 * positional args, and this catches that habit explicitly rather than
 * swallowing the trailing positionals as a confusing "unknown arg".
 */
export function parseSendArgs(args: readonly string[]): SendArgs | { error: TmResult } {
  let paneQuiet = false
  let timeout: string | null = null
  let repo = ''
  let prompt = ''
  let hasPrompt = false
  let i = 0
  while (i < args.length) {
    const arg = args[i]!
    if (arg === '--pane-quiet') {
      paneQuiet = true
      i++
    } else if (arg === '--timeout') {
      if (i + 1 >= args.length) return { error: die('tm send: --timeout requires a value') }
      timeout = args[i + 1]!
      i += 2
    } else if (arg.startsWith('--timeout=')) {
      timeout = arg.slice('--timeout='.length)
      i++
    } else if (arg === '--prompt') {
      if (i + 1 >= args.length) return { error: die('tm send: --prompt requires a value') }
      prompt = args[i + 1]!
      hasPrompt = true
      i += 2
    } else if (arg.startsWith('--prompt=')) {
      prompt = arg.slice('--prompt='.length)
      hasPrompt = true
      i++
    } else if (arg === '--') {
      i++
      repo = args[i] ?? ''
      i++
      break
    } else if (arg.startsWith('-')) {
      return { error: die(`tm send: unknown flag: ${arg}`) }
    } else if (repo === '') {
      repo = arg
      i++
    } else {
      // Legacy form: `tm send <repo> <free text>`. Echo the whole remaining
      // argv so the suggested rewrite preserves every token. The escape
      // uses POSIX-safe shell single-quoting.
      const tail = args.slice(i).join(' ')
      return {
        error: die(
          'tm send: prompt is now a --prompt flag, not a positional arg. ' +
            `Did you mean: tm send ${repo} --prompt ${shellSingleQuote(tail)} ?`,
        ),
      }
    }
  }
  return { repo, prompt, hasPrompt, paneQuiet, timeout }
}

/**
 * `cmd_spawn`'s arg loop. `--prompt` is the only value-bearing flag
 * bash validates explicitly (`[[ $# -ge 2 ]] || die`); `--task` and
 * `--resume` use `"${2:-}"; shift 2`, which under `set -e` exits
 * silently when the value is missing because `shift 2` past the end
 * returns non-zero.
 */
export function parseSpawnArgs(rest: readonly string[]): SpawnArgs | { error: TmResult } {
  const SILENT: TmResult = { code: 1, stdout: '', stderr: '' }
  let resumeSid = ''
  let task = ''
  let prompt = ''
  let hasPrompt = false
  let timeout: string | null = null
  let engine: EngineFlag | null = null
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (arg === '--resume') {
      if (i + 1 >= rest.length) return { error: SILENT }
      resumeSid = rest[i + 1]!
      i++
    } else if (arg === '--engine') {
      if (i + 1 >= rest.length) return { error: die('tm spawn: --engine requires a value') }
      const value = rest[i + 1]!
      if (value !== 'claude' && value !== 'codex') {
        return { error: die(`tm spawn: --engine must be 'claude' or 'codex' (got: '${value}')`) }
      }
      engine = value
      i++
    } else if (arg.startsWith('--engine=')) {
      const value = arg.slice('--engine='.length)
      if (value !== 'claude' && value !== 'codex') {
        return { error: die(`tm spawn: --engine must be 'claude' or 'codex' (got: '${value}')`) }
      }
      engine = value
    } else if (arg === '--task') {
      if (i + 1 >= rest.length) return { error: SILENT }
      task = rest[i + 1]!
      i++
    } else if (arg === '--timeout') {
      if (i + 1 >= rest.length) return { error: die('tm spawn: --timeout requires a value') }
      timeout = rest[i + 1]!
      i++
    } else if (arg.startsWith('--timeout=')) {
      timeout = arg.slice('--timeout='.length)
    } else if (arg.startsWith('--task=')) {
      task = arg.slice('--task='.length)
    } else if (arg === '--prompt') {
      if (i + 1 >= rest.length) return { error: die('tm spawn: --prompt requires a value') }
      prompt = rest[i + 1]!
      hasPrompt = true
      i++
    } else if (arg.startsWith('--prompt=')) {
      prompt = arg.slice('--prompt='.length)
      hasPrompt = true
    } else {
      return { error: die(`unknown flag: ${arg}`) }
    }
  }
  return { engine, resumeSid, task, prompt, hasPrompt, timeout }
}

/**
 * `cmd_wait`'s arg loop; positional after `<repo>` is a positional
 * timeout. `--timeout` with no value is bash's silent-exit-1 case
 * (`${2:-}; shift 2` trips `set -e`); mirror it so the conformance
 * differential stays clean.
 */
export function parseWaitArgs(args: readonly string[]): WaitArgs | { error: TmResult } {
  const SILENT: TmResult = { code: 1, stdout: '', stderr: '' }
  let repo = ''
  let timeout: string | null = null
  let fresh = false
  let paneQuiet = false
  let i = 0
  while (i < args.length) {
    const arg = args[i]!
    if (arg === '--fresh') {
      fresh = true
      i++
    } else if (arg === '--pane-quiet') {
      paneQuiet = true
      i++
    } else if (arg === '--timeout') {
      if (i + 1 >= args.length) return { error: SILENT }
      timeout = args[i + 1]!
      i += 2
    } else if (arg.startsWith('--timeout=')) {
      timeout = arg.slice('--timeout='.length)
      i++
    } else if (arg.startsWith('-')) {
      return { error: die(`tm wait: unknown flag: ${arg}`) }
    } else if (repo === '') {
      repo = arg
      i++
    } else {
      timeout = arg
      i++
    }
  }
  return { repo, timeout, fresh, paneQuiet }
}
