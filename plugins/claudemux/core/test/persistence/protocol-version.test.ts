/**
 * Lockstep coverage for the `/tmp/teammate-*` + `/tmp/claude-idle/*`
 * cross-process file protocol version.
 *
 * `PROTOCOL_VERSION` in `src/persistence/paths.ts` is the source of
 * truth; `plugins/claudemux/hooks/protocol-version` is the plain-text
 * echo the Bash hooks read at runtime. `scripts/sync-plugin-version.mjs`
 * mirrors the constant into the file. These tests fail CI the moment
 * the two drift, so a PR that bumps the constant without re-running
 * sync (or vice versa) cannot land — that is the entire point of
 * having a third file in the loop.
 *
 * `tm --protocol-version` is the runtime probe surface (hook bash, the
 * dreamux preflight) and must echo the same integer as the constant.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

import { runCli } from '../../src/cli'
import { PROTOCOL_VERSION } from '../../src/persistence/paths'
import type { NativeEnv } from '../../src/env'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
// test/persistence/ → test/ → core/ → plugins/claudemux/
const PLUGIN_ROOT = resolve(TEST_DIR, '..', '..', '..')

function fakeEnv(): NativeEnv {
  // `--protocol-version` short-circuits in `runCli` before any verb is
  // dispatched, so the runners are unreachable; supplying never-called
  // stubs satisfies TypeScript without dragging in real adapters.
  const unreached = async () => {
    throw new Error('protocol-version path must not touch a runner')
  }
  return {
    runTmux: unreached,
    runColumn: unreached,
    runGrep: unreached,
    dispatcherDir: '/tmp',
    projectsDir: '/tmp',
  }
}

describe('PROTOCOL_VERSION lockstep', () => {
  test('is a positive integer', () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true)
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(1)
  })

  test('matches the byte content of `hooks/protocol-version`', () => {
    const hookFile = join(PLUGIN_ROOT, 'hooks', 'protocol-version')
    const raw = readFileSync(hookFile, 'utf8')
    // The contract for the file is "single integer, single trailing
    // newline" — anything else is a sync bug.
    expect(raw).toMatch(/^\d+\n$/)
    const parsed = Number.parseInt(raw.trim(), 10)
    expect(parsed).toBe(PROTOCOL_VERSION)
  })

  test('`tm --protocol-version` prints the integer as one line', async () => {
    const result = await runCli(['--protocol-version'], fakeEnv())
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(`${PROTOCOL_VERSION}\n`)
  })

  test('`tm --protocol-version` ignores trailing args (degenerate read)', async () => {
    const result = await runCli(['--protocol-version', 'whatever', '--noise'], fakeEnv())
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${PROTOCOL_VERSION}\n`)
  })
})
