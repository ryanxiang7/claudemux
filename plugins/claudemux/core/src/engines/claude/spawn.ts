/**
 * `tm spawn` — launch a teammate (or relaunch via `--resume <sid>`),
 * record its sid + cwd, and either return as soon as `SessionStart`
 * fires or hand off to a sync `tm send` when `--prompt` is set.
 *
 * Repository discipline: this verb writes the `<name>.cwd` /
 * `<name>.sid` markers and the empty `<sid>.last` sentinel; the
 * SessionStart hook separately produces the `<name>.ready` marker the
 * poll below blocks on. Tearing those apart is what makes
 * `tm spawn --prompt` atomic — the pre-send sleep happens against a
 * REPL that has already booted.
 *
 * This module is Claude-only. The engine router owns cross-engine dispatch.
 */

import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { claudeSend } from './send'
import { readLastAssistantText, transcriptFile } from './ctx'
import { clearIdle, isDirectory } from './idle'
import { newSid, randSuffix, sanitizeTaskSlug } from './identifiers'
import { sleepMs } from './clock'
import { dieRepoNotFound } from './repo-fs'
import { die, sessionExists } from './tmux'
import { parseSpawnArgs } from '../../shared/verb-args'
import {
  cwdFile,
  idleDir,
  lastFileFor,
  readyFile,
  sidFile,
  tmuxSessionName,
} from '../../persistence/paths'
import { join } from 'node:path'
import type { ClaudeVerbEnv } from './env'
import { EXIT_SYNC_WAIT_EXPIRED, type TmResult } from '../../tm'

interface ClaudeLaunchArgs {
  readonly repo: string
  readonly resumeSid: string
  readonly continueLatest: boolean
  readonly task: string
  readonly prompt: string
  readonly hasPrompt: boolean
  /**
   * Caller-supplied `--timeout` (seconds, decimal string) for the inner
   * `tm send` handoff on the `--prompt` sync path. `null` means "use the
   * `tm send` default" (1800s). MUST be honored or `tm spawn --prompt
   * --timeout N` silently waits 1800s and the dispatcher's 124 classifier
   * never fires inside the window it was scheduled against.
   */
  readonly timeout: string | null
}

/**
 * Single-quote-escape a string for safe embedding in a bash command
 * line. `tm`'s shell-out builds the `claude --session-id ... -n '...'`
 * string and passes it to `tmux send-keys`; the native form constructs
 * the same string so the running REPL's argv is byte-equal to bash's.
 */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * `tm`'s `teammate_launch_flags`: the flag string between
 * `claude --session-id|--resume <sid>` and an optional `-n '<name>'`.
 * A bare tool name in `--disallowedTools` drops it from the model's
 * context entirely.
 */
function teammateLaunchFlags(mdExcludes: string): string {
  return `--settings ${shellSingleQuote(mdExcludes)} --disallowedTools AskUserQuestion`
}

/**
 * The maximum time `tm spawn` blocks waiting for the SessionStart hook
 * to touch `<name>.ready`. 36s comfortably covers the slowest cold boot
 * observed for `claude` on Opus 4.7 with a 1M context window and a
 * stack of user-scope plugins (~19s on the reporter's machine), while
 * still being short enough that "claude is definitely wedged" is the
 * only thing this bound can legitimately mask.
 */
const READY_POLL_BUDGET_MS = 36_000
const READY_POLL_INTERVAL_MS = 300

/**
 * Run `tm spawn`'s readiness poll: block until `<name>.ready` appears
 * or `READY_POLL_BUDGET_MS` elapse. Returns the ms it took to fire, or
 * `null` on timeout — the caller prints the verb's stderr accordingly.
 */
async function pollReady(name: string): Promise<number | null> {
  const rf = readyFile(name)
  const attempts = Math.ceil(READY_POLL_BUDGET_MS / READY_POLL_INTERVAL_MS)
  for (let i = 1; i <= attempts; i++) {
    if (existsSync(rf)) return i * READY_POLL_INTERVAL_MS
    await sleepMs(READY_POLL_INTERVAL_MS)
  }
  return null
}

/**
 * The Claude-side `tm spawn` body. Callers must have already routed
 * the codex fork; this function handles only the Claude / tmux path.
 *
 * `args` is the full arg vector — `<repo>` then `--task` / `--prompt`
 * / `--resume` etc. (Same shape `NATIVE_VERBS.spawn` accepted.)
 */
export async function claudeSpawn(
  args: readonly string[],
  env: ClaudeVerbEnv,
): Promise<TmResult> {
  const repo = args[0] ?? ''
  if (repo.length === 0) {
    return die('usage: tm spawn <repo> [--task <slug>] [--prompt "..."]')
  }
  const parsed = parseSpawnArgs(args.slice(1))
  if ('error' in parsed) return parsed.error
  return claudeLaunch({
    repo,
    resumeSid: parsed.resumeSid,
    continueLatest: false,
    task: parsed.task,
    prompt: parsed.prompt,
    hasPrompt: parsed.hasPrompt,
    timeout: parsed.timeout,
  }, env)
}

export async function claudeContinue(
  repo: string,
  opts: {
    readonly task: string
    readonly prompt: string
    readonly hasPrompt: boolean
    readonly timeout: string | null
  },
  env: ClaudeVerbEnv,
): Promise<TmResult> {
  return claudeLaunch({
    repo,
    resumeSid: '',
    continueLatest: true,
    task: opts.task,
    prompt: opts.prompt,
    hasPrompt: opts.hasPrompt,
    timeout: opts.timeout,
  }, env)
}

async function claudeLaunch(req: ClaudeLaunchArgs, env: ClaudeVerbEnv): Promise<TmResult> {
  const { repo, resumeSid, continueLatest, task, prompt, hasPrompt, timeout } = req
  const path = join(env.dispatcherDir, repo)
  if (!isDirectory(path)) return dieRepoNotFound('spawn', repo, path, env.dispatcherDir)

  // Physical-path normalization (`cd && pwd -P`) — the SessionStart hook
  // byte-matches against the cwd Claude Code emits in its hook payload,
  // which is always the physical path (macOS resolves `/tmp` → `/private/
  // tmp` at that level), so the recorded `.cwd` must be physical too.
  const cwdPhys = realpathSync(path)
  const dispatcherPhys = realpathSync(env.dispatcherDir)
  const mdExcludes = JSON.stringify({
    claudeMdExcludes: [
      `${dispatcherPhys}/CLAUDE.md`,
      `${dispatcherPhys}/CLAUDE.local.md`,
    ],
  })

  // Display-name selection: `--task` → `<repo>-<sanitized>`, else
  // `<repo>-<rand4>` for a fresh spawn, else empty (preserve on resume/continue).
  let displayName = ''
  if (task.length > 0) {
    const slug = sanitizeTaskSlug(task)
    if (slug.length === 0) {
      return die(
        `tm spawn: --task '${task}' has no usable characters after sanitization ` +
          '(allowlist: ASCII letters/digits + CJK Unified Ideographs)',
      )
    }
    displayName = `${repo}-${slug}`
  } else if (resumeSid.length === 0 && !continueLatest) {
    displayName = `${repo}-${randSuffix()}`
  }

  const name = tmuxSessionName(repo)
  if (await sessionExists(name, env.runTmux)) {
    if (hasPrompt) {
      return die(
        `${repo} already exists (tmux=${name}) — atomic bootstrap rejected ` +
          'because the teammate is already running. Use ' +
          `'tm send ${repo} --prompt "…"' to drive an existing teammate, or ` +
          `'tm kill ${repo}' first to start over.`,
      )
    }
    return {
      code: 0,
      stdout:
        `${repo} already exists (tmux=${name}; use 'tm status ${repo}' to view, ` +
        `or 'tm kill ${repo}' first)\n`,
      stderr: '',
    }
  }

  // Clear the readiness signal BEFORE launching `claude`. The SessionStart
  // hook re-touches the file once the REPL is up; the poll below blocks on it.
  const rf = readyFile(repo)
  rmSync(rf, { force: true })

  // Record the teammate's physical cwd in place *before* spawning so the
  // hook fires can find it on its first attempt.
  const cf = cwdFile(repo)
  mkdirSync(dirname(cf), { recursive: true })
  writeFileSync(cf, `${cwdPhys}\n`)

  // `-P -F '#{session_id}'` returns the new session's internal id; use it
  // as the subsequent `send-keys` target so prefix-match cannot wrong-route.
  // `-e CLAUDEMUX_TEAMMATE_REPO=...` is the positive identity gate the
  // on-session-start hook reads to discriminate "this teammate" from "the
  // dispatcher happens to share the cwd".
  let paneId = ''
  try {
    const newSession = await env.runTmux([
      'new-session',
      '-d',
      '-s',
      name,
      '-c',
      cwdPhys,
      '-e',
      `CLAUDEMUX_TEAMMATE_REPO=${repo}`,
      '-P',
      '-F',
      '#{session_id}',
    ])
    if (newSession.code !== 0) {
      return die(`tmux new-session failed: ${newSession.stderr.trim() || newSession.stdout.trim()}`)
    }
    paneId = newSession.stdout.split('\n')[0] ?? ''
  } catch (err) {
    return die(`tmux new-session failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (paneId.length === 0) return die(`tmux new-session returned no session id for ${repo}`)

  const sid = resumeSid.length > 0 ? resumeSid : continueLatest ? '' : newSid()
  const launchFlags = teammateLaunchFlags(mdExcludes)
  const nameArg = displayName.length > 0 ? ` -n ${shellSingleQuote(displayName)}` : ''
  const launchCmd =
    continueLatest
      ? `claude --continue ${launchFlags}${nameArg}`
      : resumeSid.length > 0
      ? `claude --resume ${sid} ${launchFlags}${nameArg}`
      : `claude --session-id ${sid} ${launchFlags}${nameArg}`
  await env.runTmux(['send-keys', '-t', paneId, launchCmd, 'Enter'])

  let stderr = ''
  if (continueLatest) {
    const nameNote = displayName.length > 0 ? `, name=${displayName}` : ''
    stderr +=
      `spawned: ${repo} (tmux=${name}, cwd=${cwdPhys}, continued latest sid=pending${nameNote})\n`
  } else if (resumeSid.length > 0) {
    const nameNote = displayName.length > 0 ? `, name=${displayName}` : ''
    stderr += `spawned: ${repo} (tmux=${name}, cwd=${cwdPhys}, resumed sid=${sid}${nameNote})\n`
  } else {
    const nameNote = displayName.length > 0 ? `, name=${displayName}` : ''
    stderr += `spawned: ${repo} (tmux=${name}, cwd=${cwdPhys}, sid=${sid}${nameNote})\n`
  }

  if (!continueLatest) {
    const sf = sidFile(repo)
    mkdirSync(dirname(sf), { recursive: true })
    writeFileSync(sf, `${sid}\n`)
    clearIdle(sid)
  }

  // `.last` seed. `clearIdle` above just removed the prior file; without
  // a re-seed here, `tm last` / `tm send`'s "(no text reply…)" sentinel
  // is the only thing the dispatcher can observe until the on-stop hook
  // writes a fresh extraction — and that hook can return empty (tool-only
  // turn, transcript-walk halting on a meta user entry) and `rm` the
  // file, leaving the dispatcher with nothing.
  //
  //   - Fresh spawn: write the empty sentinel. `tm last` reports the
  //     "no reply yet" state until the first real Stop.
  //   - Resume: extract the prior turn's assistant text from the
  //     existing transcript and seed `.last` with it (or the empty
  //     sentinel when no such text exists). The dispatcher can read the
  //     pre-relaunch deliverable immediately, and a hook miss on the
  //     next turn leaves that prior text in place rather than a
  //     missing file.
  //   - Continue-latest: sid is unknown until SessionStart fires and
  //     writes `.sid`, so there is nothing to key the marker by yet.
  //     The on-stop hook will create `.last` once it has a sid.
  if (!continueLatest) {
    mkdirSync(idleDir(), { recursive: true })
    if (resumeSid.length === 0) {
      writeFileSync(lastFileFor(sid), '')
    } else {
      const jsonl = transcriptFile(env.projectsDir, cwdPhys, sid)
      const prior = readLastAssistantText(jsonl)
      writeFileSync(lastFileFor(sid), prior.length > 0 ? `${prior}\n` : '')
    }
  }

  const readyAfter = await pollReady(repo)
  if (readyAfter !== null) {
    stderr += `ready: ${repo} (tmux=${name}, SessionStart fired after ~${readyAfter} ms)\n`
  } else {
    const budgetSec = Math.round(READY_POLL_BUDGET_MS / 1000)
    stderr +=
      `WARN: ${repo} (tmux=${name}) has not signalled ready in ${budgetSec}s. ` +
      'claude may still be starting (1M context, plugin discovery) or wedged ' +
      "on a permission dialog — the verb continues. A subsequent sync 'tm send' / " +
      "'tm spawn --prompt' / 'tm compact' will surface a real hang: it blocks " +
      `until its --timeout expires (default 1800s) and exits ${EXIT_SYNC_WAIT_EXPIRED} ` +
      `(sync wait expired). 'tm status ${repo}' shows the live pane if you need to verify.\n`
  }

  if (!hasPrompt) {
    return { code: 0, stdout: '', stderr }
  }

  // Atomic bootstrap: settle, then hand off to `tm send`. `cmd_send`'s
  // stdout (and its `ctx:` stderr echo) become the spawn verb's
  // stdout/stderr so the dispatcher sees one round-trip's worth of
  // output for the whole sequence.
  //
  // `--timeout` MUST ride along — without it, `tm spawn --prompt --timeout N`
  // silently waits the 1800s send default and the dispatcher's 124 classifier
  // never fires inside the window it was scheduled against. The Codex engine
  // already propagates the same field; this keeps the two engines symmetric.
  await sleepMs(3000)
  const sendArgs: string[] = [repo, '--prompt', prompt]
  if (timeout !== null) sendArgs.push('--timeout', timeout)
  const sendResult = await claudeSend(sendArgs, env)
  return {
    code: sendResult.code,
    stdout: sendResult.stdout,
    stderr: stderr + sendResult.stderr,
  }
}
