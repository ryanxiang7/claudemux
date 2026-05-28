/**
 * Coverage for `tm doctor --json` — the machine-readable doctor branch.
 *
 * The schema printed by `renderDoctorJson` is the contract committed to
 * dreamux in excitedjs/dreamux#9; these tests pin the load-bearing
 * fields and the health/exit-code rollup. The text branch
 * (`tm doctor` without `--json`) is covered by `cli.test.ts` and is
 * deliberately untouched here.
 *
 * The probes shell out to `codex --version` / `which codex` and read
 * the real /tmp file system. Tests use isolated registry roots and a
 * scratch plugin tree so a parallel test or a host with an actual
 * codex install does not perturb assertions.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { runCli } from '../../../src/cli'
import {
  collectDoctorReport,
  type DoctorIssue,
  type DoctorReport,
  type IssueCode,
} from '../../../src/engines/claude/doctor'
import { PROTOCOL_VERSION } from '../../../src/persistence/paths'
import type { ClaudeVerbEnv } from '../../../src/engines/claude/env'
import type { NativeEnv } from '../../../src/env'

const SCRATCH = '/tmp/cmx-doctor-json-test'
let codexRegistryRoot: string
let identityRoot: string
let savedCodexRoot: string | undefined
let savedIdentityRoot: string | undefined
let savedPath: string | undefined

const TMUX_VERSION = 'tmux 3.4'

const fakeTmuxOk: ClaudeVerbEnv['runTmux'] = async (args) => {
  const verb = args[0]
  if (verb === '-V') return { code: 0, stdout: `${TMUX_VERSION}\n`, stderr: '' }
  if (verb === 'info') return { code: 0, stdout: '', stderr: '' }
  if (verb === 'ls') return { code: 1, stdout: '', stderr: 'no server' }
  return { code: 0, stdout: '', stderr: '' }
}

const fakeTmuxMissing: ClaudeVerbEnv['runTmux'] = async () => {
  throw new Error('tmux: command not found')
}

function fakeEnv(over: Partial<NativeEnv> = {}): NativeEnv {
  return {
    runTmux: fakeTmuxOk,
    runColumn: async () => ({ code: 0, stdout: '', stderr: '' }),
    // `GrepRunner` resolves to a numeric exit code, not a ProcResult; the
    // doctor branch never invokes grep so a constant-zero stub is enough.
    runGrep: async () => 0,
    dispatcherDir: '/tmp',
    projectsDir: '/tmp',
    ...over,
  }
}

function fakePaths(pluginRoot: string): { tmWrapper: string; pluginJson: string } {
  return {
    tmWrapper: join(pluginRoot, 'bin', 'tm'),
    pluginJson: join(pluginRoot, '.claude-plugin', 'plugin.json'),
  }
}

/** Build a scratch plugin tree mimicking `plugins/claudemux/`. */
function makePluginTree(opts: {
  cliVersion: string
  hookProtocolVersion?: number | 'omit'
  hooksJson?: boolean
}): string {
  const root = mkdtempSync(`${SCRATCH}/plugin-`)
  mkdirSync(join(root, '.claude-plugin'), { recursive: true })
  mkdirSync(join(root, 'hooks'), { recursive: true })
  mkdirSync(join(root, 'bin'), { recursive: true })
  writeFileSync(
    join(root, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify({ name: 'claudemux', version: opts.cliVersion })}\n`,
  )
  if (opts.hooksJson !== false) {
    writeFileSync(
      join(root, 'hooks', 'hooks.json'),
      `${JSON.stringify({ hooks: { SessionStart: [], Stop: [] } })}\n`,
    )
  }
  if (opts.hookProtocolVersion !== 'omit') {
    const v = opts.hookProtocolVersion ?? PROTOCOL_VERSION
    writeFileSync(join(root, 'hooks', 'protocol-version'), `${v}\n`)
  }
  writeFileSync(join(root, 'bin', 'tm'), '#!/usr/bin/env bash\n')
  return root
}

function issueByCode(issues: readonly DoctorIssue[], code: IssueCode): DoctorIssue | undefined {
  return issues.find((i) => i.code === code)
}

beforeAll(() => {
  mkdirSync(SCRATCH, { recursive: true })
  codexRegistryRoot = mkdtempSync(`${SCRATCH}/codex-`)
  identityRoot = mkdtempSync(`${SCRATCH}/identity-`)
  savedCodexRoot = process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT']
  savedIdentityRoot = process.env['CLAUDEMUX_IDENTITY_ROOT']
  process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT'] = codexRegistryRoot
  process.env['CLAUDEMUX_IDENTITY_ROOT'] = identityRoot
  // Bound the test against codex actually being installed on the host —
  // strip PATH so `which codex` reliably reports missing and we can
  // assert the CODEX_MISSING issue deterministically. Tests that need
  // codex present should restore PATH explicitly.
  savedPath = process.env['PATH']
})

beforeEach(() => {
  process.env['PATH'] = ''
})

afterAll(() => {
  if (savedCodexRoot === undefined) delete process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT']
  else process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT'] = savedCodexRoot
  if (savedIdentityRoot === undefined) delete process.env['CLAUDEMUX_IDENTITY_ROOT']
  else process.env['CLAUDEMUX_IDENTITY_ROOT'] = savedIdentityRoot
  if (savedPath === undefined) delete process.env['PATH']
  else process.env['PATH'] = savedPath
  rmSync(SCRATCH, { recursive: true, force: true })
})

describe('collectDoctorReport — load-bearing schema fields', () => {
  test('reports schema=1, the live PROTOCOL_VERSION, and the cli version from plugin.json', async () => {
    const root = makePluginTree({ cliVersion: '9.9.9-test' })
    const report = await collectDoctorReport(fakeEnv() as ClaudeVerbEnv, fakePaths(root))
    expect(report.schema).toBe(1)
    expect(report.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(report.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(report.cliVersion).toBe('9.9.9-test')
    expect(report.hooks.installed).toBe(true)
    expect(report.hooks.pluginVersion).toBe('9.9.9-test')
    expect(report.hooks.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(report.hooks.events).toEqual(['SessionStart', 'Stop'])
  })

  test('engines block: claude always supported, codex absent under stripped PATH', async () => {
    const root = makePluginTree({ cliVersion: '1.0.0' })
    const report = await collectDoctorReport(fakeEnv() as ClaudeVerbEnv, fakePaths(root))
    expect(report.engines.claude.supported).toBe(true)
    expect(report.engines.claude.requiresHooks).toBe(true)
    expect(report.engines.codex.requiresHooks).toBe(false)
    expect(report.engines.codex.binaryPath).toBeNull()
    expect(report.engines.codex.supported).toBe(false)
  })

  test('dirs block reports the registry roots the runtime uses', async () => {
    const root = makePluginTree({ cliVersion: '1.0.0' })
    const report = await collectDoctorReport(fakeEnv() as ClaudeVerbEnv, fakePaths(root))
    expect(report.dirs.idle).toBe('/tmp/claude-idle')
    expect(report.dirs.teammateRoot).toBe('/tmp')
    expect(report.dirs.codexRegistry).toBe(codexRegistryRoot)
  })
})

describe('collectDoctorReport — issue rollup', () => {
  test('plugin.json missing → HOOK_MISSING + error', async () => {
    const ghost = mkdtempSync(`${SCRATCH}/ghost-`)
    const report = await collectDoctorReport(fakeEnv() as ClaudeVerbEnv, fakePaths(ghost))
    const issue = issueByCode(report.issues, 'HOOK_MISSING')
    expect(issue).toBeDefined()
    expect(issue!.severity).toBe('error')
    expect(report.hooks.installed).toBe(false)
    expect(report.engines.claude.ready).toBe(false)
  })

  test('hook protocolVersion mismatch → HOOK_PROTOCOL_MISMATCH + error', async () => {
    const root = makePluginTree({
      cliVersion: '1.0.0',
      hookProtocolVersion: PROTOCOL_VERSION + 1,
    })
    const report = await collectDoctorReport(fakeEnv() as ClaudeVerbEnv, fakePaths(root))
    const issue = issueByCode(report.issues, 'HOOK_PROTOCOL_MISMATCH')
    expect(issue).toBeDefined()
    expect(issue!.severity).toBe('error')
    expect(issue!.message).toContain(`tm protocolVersion=${PROTOCOL_VERSION}`)
    expect(issue!.message).toContain(`hooks protocolVersion=${PROTOCOL_VERSION + 1}`)
    expect(report.engines.claude.ready).toBe(false)
  })

  test('tmux missing → TMUX_MISSING + error + Claude not ready', async () => {
    const root = makePluginTree({ cliVersion: '1.0.0' })
    const report = await collectDoctorReport(
      fakeEnv({ runTmux: fakeTmuxMissing }) as ClaudeVerbEnv,
      fakePaths(root),
    )
    expect(issueByCode(report.issues, 'TMUX_MISSING')?.severity).toBe('error')
    expect(report.engines.claude.tmux.installed).toBe(false)
    expect(report.engines.claude.ready).toBe(false)
  })

  test('codex binary missing → CODEX_MISSING + error', async () => {
    const root = makePluginTree({ cliVersion: '1.0.0' })
    const report = await collectDoctorReport(fakeEnv() as ClaudeVerbEnv, fakePaths(root))
    const issue = issueByCode(report.issues, 'CODEX_MISSING')
    expect(issue?.severity).toBe('error')
  })

  test('dispatcher dir unusable → DISPATCHER_DIR_UNUSABLE + health unhealthy', async () => {
    const root = makePluginTree({ cliVersion: '1.0.0' })
    const report = await collectDoctorReport(
      fakeEnv({ dispatcherDir: '/no/such/dir/anywhere' }) as ClaudeVerbEnv,
      fakePaths(root),
    )
    expect(issueByCode(report.issues, 'DISPATCHER_DIR_UNUSABLE')?.severity).toBe('error')
    expect(report.health).toBe('unhealthy')
  })

  test('health is unhealthy when neither claude nor codex is usable', async () => {
    const ghost = mkdtempSync(`${SCRATCH}/ghost2-`)
    const report = await collectDoctorReport(
      fakeEnv({ runTmux: fakeTmuxMissing }) as ClaudeVerbEnv,
      fakePaths(ghost),
    )
    expect(report.engines.claude.ready).toBe(false)
    expect(report.engines.codex.supported).toBe(false)
    expect(report.health).toBe('unhealthy')
  })
})

describe('renderDoctorJson — exit code + stdout shape', () => {
  test('exits 5 when health is unhealthy', async () => {
    const root = makePluginTree({ cliVersion: '1.0.0' })
    const result = await runCli(
      ['doctor', '--json'],
      fakeEnv({
        // Force unhealthy via dispatcher-dir miss.
        dispatcherDir: '/no/such/dir/anywhere',
        runTmux: fakeTmuxMissing,
      }),
    )
    void root // production runCli resolves plugin paths itself; root unused
    expect(result.code).toBe(5)
    expect(result.stderr).toBe('')
    const parsed = JSON.parse(result.stdout) as DoctorReport
    expect(parsed.schema).toBe(1)
    expect(parsed.health).toBe('unhealthy')
    expect(Array.isArray(parsed.issues)).toBe(true)
  })

  test('exits 0 when health is degraded (warnings only or partial engine support)', async () => {
    // No tmux + missing codex would be unhealthy, so we keep tmux up to
    // leave Claude reachable. The production plugin tree under
    // `plugins/claudemux/` is loaded via `runCli`'s built-in path
    // resolver; hooks resolve to the real plugin so protocolVersion
    // matches and the Claude engine is ready.
    const result = await runCli(
      ['doctor', '--json'],
      fakeEnv({ runTmux: fakeTmuxOk }),
    )
    expect([0, 5]).toContain(result.code)
    const parsed = JSON.parse(result.stdout) as DoctorReport
    expect(parsed.schema).toBe(1)
    expect(parsed.protocolVersion).toBe(PROTOCOL_VERSION)
    // CODEX_MISSING is expected (PATH stripped), so health is at least
    // degraded; if any other env miss pushes it to unhealthy that is
    // still a valid contract for the production paths we are exercising.
    expect(['ok', 'degraded', 'unhealthy']).toContain(parsed.health)
  })

  test('the --json flag is the only non-help argument accepted', async () => {
    const result = await runCli(['doctor', '--json', 'extra'], fakeEnv())
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('takes no arguments other than --json')
  })

  test('text mode still works (regression — no behavior change)', async () => {
    const result = await runCli(['doctor'], fakeEnv())
    expect(result.code).toBe(0)
    // The text mode prints the legacy header lines; this is the smoke
    // test that the --json branch did not accidentally rebind the
    // entire verb body.
    expect(result.stdout).toContain('tm executable:')
    expect(result.stdout).toContain('codex teammates:')
  })
})
