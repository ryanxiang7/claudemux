/**
 * Codex rollout JSONL readers.
 *
 * Codex persists a thread under `$CODEX_HOME/sessions/YYYY/MM/DD/` as an
 * append-only `rollout-<timestamp>-<thread-id>.jsonl` file. The app-server
 * protocol still owns live turns; these helpers are read-only fallbacks for
 * status surfaces that need durable last-reply and token-usage data.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readdirSync, readFileSync, statSync } from 'node:fs'

// Layer-3 BUSY fallback bridges short gaps between rollout writes and live
// thread status. Long turns without rollout writes should be covered by
// `thread/read` active; if that signal is unavailable, the fallback ages out
// quickly instead of leaving stale busy rows around for a full minute.
export const CODEX_ROLLOUT_BUSY_WINDOW_MS = 20_000

export interface RolloutTokenUsage {
  readonly tokensUsed: number
  readonly tokensTotal: number
  readonly pct: number
}

export interface CodexRolloutSnapshot {
  readonly path: string
  readonly mtimeMs: number
  readonly lastAssistantText: string | null
  readonly tokenUsage: RolloutTokenUsage | null
}

export interface CodexRolloutFile {
  readonly path: string
  readonly mtimeMs: number
  readonly threadId: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringProp(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key]
  return typeof value === 'string' ? value : null
}

function numberProp(obj: Record<string, unknown>, key: string): number | null {
  const value = obj[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function codexHome(env: NodeJS.ProcessEnv): string {
  return env['CLAUDEMUX_CODEX_HOME'] || env['CODEX_HOME'] || join(homedir(), '.codex')
}

export function codexSessionsRoot(env: NodeJS.ProcessEnv): string {
  return env['CLAUDEMUX_CODEX_SESSIONS_ROOT'] || join(codexHome(env), 'sessions')
}

function sortedNumericDirs(root: string): string[] {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => Number(b) - Number(a))
}

const ROLLOUT_THREAD_RE =
  /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

function rolloutThreadId(name: string): string | null {
  const match = ROLLOUT_THREAD_RE.exec(name)
  return match === null ? null : match[1]!
}

function findInDay(
  dayDir: string,
  suffix: string,
  exactThreadId: string,
): CodexRolloutFile | null {
  let entries
  try {
    entries = readdirSync(dayDir, { withFileTypes: true })
  } catch {
    return null
  }

  let newest: CodexRolloutFile | null = null
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const name = entry.name
    if (!name.startsWith('rollout-') || !name.endsWith(suffix)) continue
    const path = join(dayDir, name)
    let mtimeMs: number
    try {
      mtimeMs = statSync(path).mtimeMs
    } catch {
      continue
    }
    if (newest === null || mtimeMs > newest.mtimeMs) {
      newest = { path, mtimeMs, threadId: exactThreadId }
    }
  }
  return newest
}

export function findCodexRolloutFile(
  threadId: string,
  env: NodeJS.ProcessEnv,
): CodexRolloutFile | null {
  const suffix = `-${threadId}.jsonl`
  const root = codexSessionsRoot(env)
  for (const year of sortedNumericDirs(root)) {
    const yearDir = join(root, year)
    for (const month of sortedNumericDirs(yearDir)) {
      const monthDir = join(yearDir, month)
      for (const day of sortedNumericDirs(monthDir)) {
        const found = findInDay(join(monthDir, day), suffix, threadId)
        if (found !== null) return found
      }
    }
  }
  return null
}

function listInDay(dayDir: string): CodexRolloutFile[] {
  let entries
  try {
    entries = readdirSync(dayDir, { withFileTypes: true })
  } catch {
    return []
  }

  const files: CodexRolloutFile[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const threadId = rolloutThreadId(entry.name)
    if (threadId === null || !entry.name.startsWith('rollout-')) continue
    const path = join(dayDir, entry.name)
    try {
      files.push({ path, mtimeMs: statSync(path).mtimeMs, threadId })
    } catch {
      continue
    }
  }
  return files
}

export function listCodexRolloutFiles(env: NodeJS.ProcessEnv): readonly CodexRolloutFile[] {
  const root = codexSessionsRoot(env)
  const files: CodexRolloutFile[] = []
  for (const year of sortedNumericDirs(root)) {
    const yearDir = join(root, year)
    for (const month of sortedNumericDirs(yearDir)) {
      const monthDir = join(yearDir, month)
      for (const day of sortedNumericDirs(monthDir)) {
        files.push(...listInDay(join(monthDir, day)))
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return files
}

function phaseAllowed(phase: unknown): boolean {
  // Codex writes commentary before a final answer. Keeping it here lets
  // `tm last` show the latest assistant-visible text during an in-flight
  // turn; a later `final_answer` line wins because the parser keeps the
  // newest matching JSONL entry.
  return phase === 'final_answer' || phase === 'commentary'
}

function textFromContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const item of content) {
    if (!isPlainObject(item)) continue
    if (item['type'] !== 'output_text') continue
    const text = stringProp(item, 'text')
    if (text !== null) parts.push(text)
  }
  return parts.length === 0 ? null : parts.join('')
}

function assistantTextFromEntry(entry: unknown): string | null {
  if (!isPlainObject(entry)) return null
  const payload = entry['payload']
  if (!isPlainObject(payload)) return null

  if (payload['type'] === 'agent_message' && phaseAllowed(payload['phase'])) {
    return stringProp(payload, 'message')
  }
  if (payload['type'] === 'agentMessage' && phaseAllowed(payload['phase'])) {
    return stringProp(payload, 'text')
  }
  if (
    payload['type'] === 'message' &&
    payload['role'] === 'assistant' &&
    phaseAllowed(payload['phase'])
  ) {
    return textFromContent(payload['content'])
  }

  const item = payload['item']
  if (isPlainObject(item) && item['type'] === 'agentMessage' && phaseAllowed(item['phase'])) {
    return stringProp(item, 'text')
  }
  return null
}

function tokenCountFromSnake(info: Record<string, unknown>): RolloutTokenUsage | null {
  const last = info['last_token_usage']
  if (!isPlainObject(last)) return null
  const window = numberProp(info, 'model_context_window')
  if (window === null || window <= 0) return null
  const input = numberProp(last, 'input_tokens')
  const total = numberProp(last, 'total_tokens')
  // `total_tokens` includes generated assistant output, which becomes
  // conversation history for the next prompt. It therefore approximates
  // post-turn context fill better than `input_tokens`; keep input as a
  // compatibility fallback for older or partial rollout records.
  const used = total ?? input
  if (used === null) return null
  return { tokensUsed: used, tokensTotal: window, pct: Math.floor((used * 100) / window) }
}

function tokenCountFromCamel(tokenUsage: Record<string, unknown>): RolloutTokenUsage | null {
  const last = tokenUsage['last']
  if (!isPlainObject(last)) return null
  const window = numberProp(tokenUsage, 'modelContextWindow')
  if (window === null || window <= 0) return null
  const input = numberProp(last, 'inputTokens')
  const total = numberProp(last, 'totalTokens')
  const used = total ?? input
  if (used === null) return null
  return { tokensUsed: used, tokensTotal: window, pct: Math.floor((used * 100) / window) }
}

function tokenUsageFromEntry(entry: unknown): RolloutTokenUsage | null {
  if (!isPlainObject(entry)) return null
  const payload = entry['payload']
  if (isPlainObject(payload)) {
    if (payload['type'] === 'token_count' && isPlainObject(payload['info'])) {
      return tokenCountFromSnake(payload['info'])
    }
    if (
      payload['method'] === 'thread/tokenUsage/updated' &&
      isPlainObject(payload['params']) &&
      isPlainObject(payload['params']['tokenUsage'])
    ) {
      return tokenCountFromCamel(payload['params']['tokenUsage'])
    }
  }
  if (
    entry['type'] === 'thread/tokenUsage/updated' &&
    isPlainObject(entry['params']) &&
    isPlainObject(entry['params']['tokenUsage'])
  ) {
    return tokenCountFromCamel(entry['params']['tokenUsage'])
  }
  return null
}

export function readCodexRolloutSnapshot(
  threadId: string,
  env: NodeJS.ProcessEnv,
): CodexRolloutSnapshot | null {
  const rollout = findCodexRolloutFile(threadId, env)
  if (rollout === null) return null

  let content: string
  try {
    content = readFileSync(rollout.path, 'utf8')
  } catch {
    return null
  }

  let lastAssistantText: string | null = null
  let tokenUsage: RolloutTokenUsage | null = null
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    lastAssistantText = assistantTextFromEntry(entry) ?? lastAssistantText
    tokenUsage = tokenUsageFromEntry(entry) ?? tokenUsage
  }

  return { ...rollout, lastAssistantText, tokenUsage }
}

export function rolloutRecentlyActive(
  snapshot: CodexRolloutSnapshot | null,
  nowMs: number,
): boolean {
  if (snapshot === null) return false
  return nowMs - snapshot.mtimeMs <= CODEX_ROLLOUT_BUSY_WINDOW_MS
}
