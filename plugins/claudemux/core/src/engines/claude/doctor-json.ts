/**
 * `tm doctor --json` — the machine-readable variant of `tm doctor`.
 *
 * This module is the **read-only** branch of the doctor verb. The text
 * branch in `doctor.ts` keeps its current behavior verbatim, including
 * the side effect of reaping orphan Codex daemons; the JSON branch must
 * not mutate any on-disk state, because its consumers (dreamux's
 * preflight, the `/claudemux:setup` health check) poll it on a cadence
 * and would silently lose otherwise-recoverable daemons to a poll that
 * happened to fire right after a transient pid-check failure.
 *
 * The schema printed by `renderDoctorJson` is the contract committed to
 * dreamux in excitedjs/dreamux#9 (`schema: 1`); changing it is a
 * breaking change of `tm doctor --json` and must move with a CLI minor
 * bump. The `issues[].code` enum is the load-bearing piece — message
 * text may change between releases, but consumers route off `code`.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { isDirectory } from './idle'
import {
  isProcessAlive as codexProcessAlive,
  listDaemons as listCodexDaemons,
  readDaemonState as readCodexState,
} from '../codex/supervisor'
import {
  codexRegistryRoot,
  readBaseRecord as readCodexBaseRecord,
} from '../codex/persistence'
import { idleDir, PROTOCOL_VERSION } from '../../persistence/paths'
import { iterTeammates } from './tmux'
import { spawnCapture } from '../../proc'
import type { ClaudeVerbEnv } from './env'
import type { TmResult } from '../../tm'

export interface DoctorPaths {
  /** Absolute path to the `<plugin-root>/bin/tm` launcher. */
  tmWrapper: string
  /** Absolute path to `<plugin-root>/.claude-plugin/plugin.json`. */
  pluginJson: string
}

/** Issue code enum — the load-bearing part of the contract. */
export type IssueCode =
  | 'NODE_TOO_OLD'
  | 'HOOK_MISSING'
  | 'HOOK_PROTOCOL_MISMATCH'
  | 'HOOK_NEVER_FIRED'
  | 'TMUX_MISSING'
  | 'CODEX_MISSING'
  | 'DISPATCHER_DIR_UNUSABLE'
  | 'STALE_CODEX_DAEMON'

export interface DoctorIssue {
  readonly code: IssueCode
  readonly severity: 'warn' | 'error'
  readonly message: string
  readonly action: string
}

export interface DoctorReport {
  readonly schema: 1
  readonly cliVersion: string
  readonly protocolVersion: number
  readonly node: { readonly version: string; readonly path: string }
  readonly binary: {
    readonly path: string
    /** `npm` when the launcher resolved through a global npm install; `plugin-fallback` when it ran from a plugin checkout. */
    readonly kind: 'npm' | 'plugin-fallback' | 'unknown'
  }
  readonly dispatcherDir: string
  readonly dirs: {
    readonly idle: string
    readonly teammateRoot: string
    readonly codexRegistry: string
  }
  readonly hooks: {
    readonly installed: boolean
    readonly pluginRoot: string | null
    readonly pluginVersion: string | null
    readonly protocolVersion: number | null
    readonly events: readonly string[]
    readonly lastFireUtc: string | null
  }
  readonly engines: {
    readonly claude: {
      readonly supported: true
      readonly requiresHooks: true
      readonly ready: boolean
      readonly tmux: { readonly installed: boolean; readonly version: string | null }
    }
    readonly codex: {
      readonly supported: boolean
      readonly requiresHooks: false
      readonly binaryPath: string | null
      readonly binaryVersion: string | null
    }
  }
  readonly teammates: { readonly claude: number; readonly codex: number }
  readonly health: 'ok' | 'degraded' | 'unhealthy'
  readonly issues: readonly DoctorIssue[]
}

/** Minimum Node version the CLI runs on — mirrors `bin/tm`'s 22.7 gate. */
const MIN_NODE_MAJOR = 22
const MIN_NODE_MINOR = 7

/**
 * Walk up the binary's path looking for `/node_modules/` segments or
 * `npm` cache markers — heuristic, but the only thing distinguishing a
 * global npm install from a plugin checkout at runtime is the path.
 */
function detectBinaryKind(tmWrapper: string): 'npm' | 'plugin-fallback' | 'unknown' {
  if (tmWrapper.includes('/node_modules/')) return 'npm'
  if (tmWrapper.includes('/.npm/') || tmWrapper.includes('/npm/')) return 'npm'
  if (tmWrapper.includes('/.claude/plugins/')) return 'plugin-fallback'
  if (tmWrapper.includes('/plugins/claudemux/')) return 'plugin-fallback'
  return 'unknown'
}

/** Parse `plugin.json`'s version, returning the string + a presence flag. */
function probePluginJson(pluginJson: string): { present: boolean; version: string | null } {
  try {
    if (!statSync(pluginJson).isFile()) return { present: false, version: null }
    const parsed = JSON.parse(readFileSync(pluginJson, 'utf8')) as { version?: unknown }
    const v = typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : null
    return { present: true, version: v }
  } catch {
    return { present: false, version: null }
  }
}

/** Read `<plugin-root>/hooks/protocol-version` as an integer, returning `null` on miss. */
function probeHookProtocolVersion(pluginRoot: string): number | null {
  try {
    const raw = readFileSync(join(pluginRoot, 'hooks', 'protocol-version'), 'utf8')
    const parsed = Number.parseInt(raw.trim(), 10)
    return Number.isFinite(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Parse `<plugin-root>/hooks/hooks.json` and return the registered event names. */
function probeHookEvents(pluginRoot: string): readonly string[] {
  try {
    const raw = readFileSync(join(pluginRoot, 'hooks', 'hooks.json'), 'utf8')
    const parsed = JSON.parse(raw) as { hooks?: Record<string, unknown> }
    return parsed.hooks !== undefined ? Object.keys(parsed.hooks) : []
  } catch {
    return []
  }
}

/**
 * Most recent mtime across the hook-observed log files. `null` when the
 * idle dir does not exist or contains nothing the hooks would have
 * written. Reported as an ISO-8601 UTC string.
 */
function probeLastHookFire(): string | null {
  const dirs = [idleDir()]
  let newest = 0
  for (const dir of dirs) {
    if (!isDirectory(dir)) continue
    try {
      for (const entry of readdirSync(dir)) {
        try {
          const s = statSync(join(dir, entry))
          if (s.mtimeMs > newest) newest = s.mtimeMs
        } catch {
          // unreadable entry — keep walking
        }
      }
    } catch {
      // unreadable dir — keep walking
    }
  }
  // The on-stop hook also appends to /tmp/claude-idle/_on-stop.log and
  // /tmp/claudemux-sid-changes.log; check those too because a fresh
  // boot may have written the log before any per-sid file.
  for (const candidate of ['/tmp/claudemux-sid-changes.log']) {
    try {
      const s = statSync(candidate)
      if (s.mtimeMs > newest) newest = s.mtimeMs
    } catch {
      // missing — fine
    }
  }
  if (newest === 0) return null
  return new Date(newest).toISOString()
}

/** `tmux -V` exit + version. */
async function probeTmux(
  runTmux: ClaudeVerbEnv['runTmux'],
): Promise<{ installed: boolean; version: string | null }> {
  try {
    const r = await runTmux(['-V'])
    if (r.code !== 0) return { installed: false, version: null }
    const version = r.stdout.split('\n')[0]?.trim() ?? null
    return { installed: true, version }
  } catch {
    return { installed: false, version: null }
  }
}

/** `codex --version` and a resolved binary path, when the binary is on `PATH`. */
async function probeCodex(): Promise<{ path: string | null; version: string | null }> {
  let path: string | null = null
  try {
    const which = await spawnCapture(['command', '-v', 'codex'])
    if (which.code === 0) {
      const line = which.stdout.split('\n')[0]?.trim() ?? ''
      if (line.length > 0) path = line
    }
  } catch {
    // shell builtin missing — try direct
  }
  if (path === null) {
    try {
      const which = await spawnCapture(['which', 'codex'])
      if (which.code === 0) {
        const line = which.stdout.split('\n')[0]?.trim() ?? ''
        if (line.length > 0) path = line
      }
    } catch {
      // both missing — codex truly not on PATH
    }
  }
  if (path === null) return { path: null, version: null }
  let version: string | null = null
  try {
    const v = await spawnCapture(['codex', '--version'])
    if (v.code === 0) {
      const first = v.stdout.split('\n')[0]?.trim() ?? ''
      if (first.length > 0) version = first
    }
  } catch {
    // version probe failed — return the path, leave version null
  }
  return { path, version }
}

/** Codex teammate count with a stale-daemon side-list (read-only — never reaps). */
function probeCodexTeammates(): { live: number; stale: string[] } {
  const stale: string[] = []
  let live = 0
  for (const name of listCodexDaemons()) {
    const state = readCodexState(name)
    if (state === null || !codexProcessAlive(state.pid)) {
      stale.push(name)
      continue
    }
    // Defence in depth: if a daemon's base record is missing it would have
    // failed mid-spawn; treat as stale rather than counted.
    if (readCodexBaseRecord(name) === null) {
      stale.push(name)
      continue
    }
    live += 1
  }
  return { live, stale }
}

/**
 * Build the structured doctor report. Pure: no file mutations, no
 * orphan reaping, no daemon-killing — every consumer (dreamux preflight,
 * `/claudemux:setup` health check, hook self-test) can poll this at
 * whatever cadence they want without worrying about losing state to a
 * transient failure.
 */
export async function collectDoctorReport(
  env: ClaudeVerbEnv,
  paths: DoctorPaths,
): Promise<DoctorReport> {
  const { tmWrapper, pluginJson } = paths
  const pluginRoot = dirname(dirname(pluginJson))

  const plugin = probePluginJson(pluginJson)
  const hookProtocolVersion = probeHookProtocolVersion(pluginRoot)
  const hookEvents = probeHookEvents(pluginRoot)
  const hookFile = existsSync(join(pluginRoot, 'hooks', 'hooks.json'))
  const lastFireUtc = probeLastHookFire()
  const tmux = await probeTmux(env.runTmux)
  const codex = await probeCodex()
  const codexTeammates = probeCodexTeammates()

  // Claude teammates: read tmux sessions with the claudemux prefix.
  // `iterTeammates` returns the names (without prefix) so we just count
  // them; failure (tmux missing / server not running) yields 0, which
  // matches reality (no Claude teammates reachable).
  let claudeTeammates = 0
  try {
    const sessions = await iterTeammates(env.runTmux)
    claudeTeammates = sessions.length
  } catch {
    claudeTeammates = 0
  }

  const hookInstalled = plugin.present && hookFile

  const issues: DoctorIssue[] = []

  // --- node version ---
  const nodeVersion = process.versions.node
  const [majStr, minStr] = nodeVersion.split('.')
  const nodeMajor = Number.parseInt(majStr ?? '0', 10)
  const nodeMinor = Number.parseInt(minStr ?? '0', 10)
  if (
    !Number.isFinite(nodeMajor) ||
    nodeMajor < MIN_NODE_MAJOR ||
    (nodeMajor === MIN_NODE_MAJOR && nodeMinor < MIN_NODE_MINOR)
  ) {
    issues.push({
      code: 'NODE_TOO_OLD',
      severity: 'error',
      message: `Node ${nodeVersion} is below the supported ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}`,
      action: `Upgrade Node to ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} or newer`,
    })
  }

  // --- hooks ---
  if (!hookInstalled) {
    issues.push({
      code: 'HOOK_MISSING',
      severity: 'error',
      message: `claudemux plugin hooks not found (looked at ${pluginRoot})`,
      action: 'Install the claudemux Claude Code plugin via /plugin marketplace',
    })
  } else if (hookProtocolVersion !== null && hookProtocolVersion !== PROTOCOL_VERSION) {
    issues.push({
      code: 'HOOK_PROTOCOL_MISMATCH',
      severity: 'error',
      message: `tm protocolVersion=${PROTOCOL_VERSION} but installed hooks protocolVersion=${hookProtocolVersion}`,
      action: 'Run /claudemux:setup to re-align the plugin and the tm CLI',
    })
  } else if (hookInstalled && lastFireUtc === null) {
    issues.push({
      code: 'HOOK_NEVER_FIRED',
      severity: 'warn',
      message: 'hooks are installed but no SessionStart/Stop fire has been recorded yet',
      action: 'Launch a Claude session to confirm the hooks load (this warning clears on first fire)',
    })
  }

  // --- tmux ---
  if (!tmux.installed) {
    issues.push({
      code: 'TMUX_MISSING',
      severity: 'error',
      message: 'tmux is not on PATH — the Claude-engine teammate path needs it',
      action: 'Install tmux (`brew install tmux` / `apt install tmux`) and retry',
    })
  }

  // --- codex ---
  if (codex.path === null) {
    issues.push({
      code: 'CODEX_MISSING',
      severity: 'error',
      message: 'codex binary not on PATH — the Codex-engine teammate path needs it',
      action: 'Install Codex (https://github.com/openai/codex) and ensure `codex` is on PATH',
    })
  }

  // --- dispatcher dir ---
  if (!isDirectory(env.dispatcherDir)) {
    issues.push({
      code: 'DISPATCHER_DIR_UNUSABLE',
      severity: 'error',
      message: `dispatcher dir ${env.dispatcherDir} is not a readable directory`,
      action: 'Re-run /claudemux:setup from the intended dispatcher directory',
    })
  }

  // --- stale codex daemons (warn only; no auto-reap in JSON mode) ---
  for (const name of codexTeammates.stale) {
    issues.push({
      code: 'STALE_CODEX_DAEMON',
      severity: 'warn',
      message: `codex teammate '${name}' has a registry entry but no live daemon`,
      action: `Run \`tm doctor\` (text mode) to reap, or \`tm kill ${name}\` to clear it explicitly`,
    })
  }

  const claudeReady =
    hookInstalled &&
    hookProtocolVersion === PROTOCOL_VERSION &&
    tmux.installed
  const codexSupported = codex.path !== null

  // Health rollup. "unhealthy" only when neither engine can be driven;
  // a missing dispatcher dir is also unhealthy because every verb falls
  // off the cliff at the cwd check. "degraded" covers "at least one
  // engine still works, but something needs attention".
  let health: DoctorReport['health']
  if (!claudeReady && !codexSupported) health = 'unhealthy'
  else if (issues.some((i) => i.code === 'DISPATCHER_DIR_UNUSABLE')) health = 'unhealthy'
  else if (issues.length > 0) health = 'degraded'
  else health = 'ok'

  return {
    schema: 1,
    cliVersion: plugin.version ?? 'unknown',
    protocolVersion: PROTOCOL_VERSION,
    node: { version: nodeVersion, path: process.execPath },
    binary: { path: tmWrapper, kind: detectBinaryKind(tmWrapper) },
    dispatcherDir: env.dispatcherDir,
    dirs: {
      idle: idleDir(),
      teammateRoot: '/tmp',
      codexRegistry: codexRegistryRoot(),
    },
    hooks: {
      installed: hookInstalled,
      pluginRoot: plugin.present ? pluginRoot : null,
      pluginVersion: plugin.version,
      protocolVersion: hookProtocolVersion,
      events: hookEvents,
      lastFireUtc,
    },
    engines: {
      claude: {
        supported: true,
        requiresHooks: true,
        ready: claudeReady,
        tmux,
      },
      codex: {
        supported: codexSupported,
        requiresHooks: false,
        binaryPath: codex.path,
        binaryVersion: codex.version,
      },
    },
    teammates: { claude: claudeTeammates, codex: codexTeammates.live },
    health,
    issues,
  }
}

/** Render the report as a single JSON line followed by a newline. */
export function renderDoctorJson(report: DoctorReport): TmResult {
  // `unhealthy` is the only exit-non-zero path: every other state still
  // wants exit 0 so a CI gate can rely on "doctor returned ok || I
  // surface the warnings myself".
  const code = report.health === 'unhealthy' ? 5 : 0
  return {
    code,
    stdout: `${JSON.stringify(report)}\n`,
    stderr: '',
  }
}
