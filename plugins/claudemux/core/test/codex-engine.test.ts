/**
 * Contract tests for `CodexEngine`.
 *
 * The fake codex binary speaks enough app-server JSON-RPC to exercise the
 * Engine interface without an OpenAI account. Supervisor-only liveness tests
 * stay in `codex-supervisor.test.ts`; this file pins the cross-engine surface
 * Phase 2b exposes to the verb layer.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { CodexEngine } from '../src/engines/codex/engine'
import { EngineRegistry } from '../src/engines/registry'
import { ProductionTeammateRouter } from '../src/identity/router'
import {
  daemonAlive,
  readDaemonState,
  reapDaemon,
} from '../src/engines/codex/supervisor'
import {
  CodexTeammateRecord,
  codexBorrowLockFile,
  codexPidFile,
  codexStartedAtFile,
  codexTeammateDir,
  codexThreadFile,
  readBaseRecord,
  removeBaseRecord,
  writeBaseRecord,
} from '../src/engines/codex/persistence'
import { CODEX_ROLLOUT_BUSY_WINDOW_MS } from '../src/engines/codex/rollout'
import type { EngineContext } from '../src/engines/types'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE_CODEX = resolve(HERE, 'fixtures', 'codex-fake', 'codex')

let registryDir: string
let identityDir: string
let cwd: string
let sessionsRoot: string
let savedRegistryRoot: string | undefined
let savedIdentityRoot: string | undefined
let savedSessionsRoot: string | undefined
let engine: CodexEngine
let spawned: string[]
let counter = 0

function ctx(): EngineContext {
  return { now: () => Date.now(), env: process.env }
}

function ctxWithEnv(env: NodeJS.ProcessEnv): EngineContext {
  return { now: () => Date.now(), env }
}

function nameUnder(): string {
  return `codex/engine-${counter++}`
}

beforeEach(() => {
  registryDir = mkdtempSync('/tmp/cmxe-')
  identityDir = mkdtempSync('/tmp/cmxe-id-')
  sessionsRoot = mkdtempSync('/tmp/cmxe-sessions-')
  cwd = mkdtempSync('/tmp/cmxe-cwd-')
  savedRegistryRoot = process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT']
  savedIdentityRoot = process.env['CLAUDEMUX_IDENTITY_ROOT']
  savedSessionsRoot = process.env['CLAUDEMUX_CODEX_SESSIONS_ROOT']
  process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT'] = registryDir
  process.env['CLAUDEMUX_IDENTITY_ROOT'] = identityDir
  process.env['CLAUDEMUX_CODEX_SESSIONS_ROOT'] = sessionsRoot
  engine = new CodexEngine({ binPath: FAKE_CODEX, readyTimeoutMs: 5000 })
  spawned = []
})

afterEach(async () => {
  for (const name of spawned) {
    await reapDaemon(name)
    removeBaseRecord(name)
  }
  if (savedRegistryRoot === undefined) delete process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT']
  else process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT'] = savedRegistryRoot
  if (savedIdentityRoot === undefined) delete process.env['CLAUDEMUX_IDENTITY_ROOT']
  else process.env['CLAUDEMUX_IDENTITY_ROOT'] = savedIdentityRoot
  if (savedSessionsRoot === undefined) delete process.env['CLAUDEMUX_CODEX_SESSIONS_ROOT']
  else process.env['CLAUDEMUX_CODEX_SESSIONS_ROOT'] = savedSessionsRoot
  rmSync(registryDir, { recursive: true, force: true })
  rmSync(identityDir, { recursive: true, force: true })
  rmSync(sessionsRoot, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

function writeDaemonFiles(name: string, threadId: string): void {
  mkdirSync(codexTeammateDir(name), { recursive: true })
  writeFileSync(codexPidFile(name), `${process.pid}\n`)
  writeFileSync(codexStartedAtFile(name), '1\n')
  writeFileSync(codexThreadFile(name), `${threadId}\n`)
  writeBaseRecord(new CodexTeammateRecord({
    name,
    cwd,
    createdAt: 1,
    displayName: null,
  }))
}

function writeRollout(threadId: string, lines: readonly unknown[], mtimeMs = Date.now()): string {
  const dir = join(sessionsRoot, '2026', '05', '24')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `rollout-2026-05-24T00-00-00-${threadId}.jsonl`)
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
  const mtime = new Date(mtimeMs)
  utimesSync(file, mtime, mtime)
  return file
}

function connectionCounts(file: string): { opens: number; closes: number } {
  if (!existsSync(file)) return { opens: 0, closes: 0 }
  const lines = readFileSync(file, 'utf8').split('\n')
  return {
    opens: lines.filter((line) => line === 'open').length,
    closes: lines.filter((line) => line === 'close').length,
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  expect(predicate()).toBe(true)
}

describe('CodexEngine — core lifecycle', () => {
  test('spawn, send, list, status, wait timeout, and kill run through the Engine API', async () => {
    const name = nameUnder()
    spawned.push(name)

    const spawn = await engine.spawn(
      {
        name,
        cwd,
        resumeCheckpoint: null,
        prompt: null,
        timeoutMs: null,
        displayName: 'engine test',
      },
      ctx(),
    )
    expect(spawn).toMatchObject({ kind: 'spawned', name })
    expect(readBaseRecord(name)).toMatchObject({
      name,
      engine: 'codex',
      cwd,
      displayName: 'engine test',
    })
    const registry = new EngineRegistry()
    registry.register(engine)
    const routed = await new ProductionTeammateRouter(registry).resolve(name)
    expect(routed).toMatchObject({ name, engine })

    const send = await engine.send(
      { name, prompt: 'pong from codex', timeoutMs: 5000, paneQuiet: false },
      ctx(),
    )
    expect(send.kind).toBe('completed')
    if (send.kind === 'completed') {
      expect(send.text).toContain('fake reply: pong from codex')
      expect(send.items).toContainEqual({ kind: 'assistant-text', text: 'fake reply: pong from codex' })
    }

    const listing = await engine.list(ctx())
    expect(listing.map((row) => row.name)).toContain(name)
    const row = listing.find((candidate) => candidate.name === name)
    expect(row?.extras).toMatchObject({
      sidShort: 'thread-1',
      busy: 'no',
      preview: expect.stringMatching(/^pid=\d+$/),
    })
    expect(row?.extras['last']).toMatch(/^\d+s$/)
    writeFileSync(codexBorrowLockFile(name), `${process.pid}\n`)
    const busyRow = (await engine.list(ctx())).find((candidate) => candidate.name === name)
    expect(busyRow).toMatchObject({ state: 'busy', extras: { busy: 'yes' } })

    const status = await engine.status({ name, lines: null }, ctx())
    expect(status).toMatchObject({ kind: 'present', name, engine: 'codex', state: 'busy', cwd })
    if (status.kind === 'present') {
      expect(status.pane).toContain(`codex: ${name}`)
      expect(status.pane).toContain('socket reachable: yes')
      expect(status.diagnostics['socketReachable']).toBe('yes')
    }
    rmSync(codexBorrowLockFile(name), { force: true })

    const wait = await engine.wait(
      { name, recoverFor: null, timeoutMs: 10, fresh: false, paneQuiet: false },
      ctx(),
    )
    expect(wait).toMatchObject({ kind: 'timed-out' })

    const killed = await engine.kill({ name }, ctx())
    expect(killed).toEqual({ kind: 'killed' })
    expect(await engine.status({ name, lines: null }, ctx())).toEqual({ kind: 'not-found' })
  })

  test('duplicate spawn is rejected while the daemon is alive', async () => {
    const name = nameUnder()
    spawned.push(name)
    await engine.spawn(
      { name, cwd, resumeCheckpoint: null, prompt: null, timeoutMs: null, displayName: null },
      ctx(),
    )

    const duplicate = await engine.spawn(
      { name, cwd, resumeCheckpoint: null, prompt: null, timeoutMs: null, displayName: null },
      ctx(),
    )
    expect(duplicate).toEqual({ kind: 'already-exists', existingEngine: 'codex' })
  })

  test('resume starts a daemon, writes the thread id, and calls thread/resume', async () => {
    const name = nameUnder()
    const threadId = '019e5f5f-2e57-7abc-8def-123456789abc'
    const rpcLog = join(registryDir, 'resume-rpc.log')
    spawned.push(name)

    const resumed = await engine.resume(
      {
        name,
        cwd,
        checkpoint: threadId,
        prompt: null,
        displayName: 'resumed codex',
      },
      ctxWithEnv({ ...process.env, CODEX_FAKE_RPC_LOG: rpcLog }),
    )

    expect(resumed).toMatchObject({
      kind: 'resumed',
      checkpoint: threadId,
      tmResult: {
        code: 0,
        stdout: `resumed: ${threadId}\n`,
        stderr: expect.stringMatching(new RegExp(`^resumed: ${name} \\(pid=\\d+, socket=.*\\)\\n$`)),
      },
    })
    expect(readBaseRecord(name)).toMatchObject({
      name,
      engine: 'codex',
      cwd,
      displayName: 'resumed codex',
    })
    expect(readDaemonState(name)?.threadId).toBe(threadId)
    expect(readFileSync(codexThreadFile(name), 'utf8').trim()).toBe(threadId)
    expect(readFileSync(rpcLog, 'utf8').split('\n')).toContain('thread/resume')

    const send = await engine.send(
      { name, prompt: 'continue from resumed thread', timeoutMs: 5000, paneQuiet: false },
      ctx(),
    )
    expect(send).toMatchObject({ kind: 'completed' })
    expect(readDaemonState(name)?.threadId).toBe(threadId)
  })

  test('resume rejects an already running codex teammate', async () => {
    const name = nameUnder()
    spawned.push(name)
    await engine.spawn(
      { name, cwd, resumeCheckpoint: null, prompt: null, timeoutMs: null, displayName: null },
      ctx(),
    )

    const resumed = await engine.resume(
      {
        name,
        cwd,
        checkpoint: '019e5f5f-2e57-7abc-8def-123456789abc',
        prompt: null,
        displayName: null,
      },
      ctx(),
    )

    expect(resumed).toEqual({
      kind: 'failed',
      message: `codex teammate '${name}' is already running`,
    })
  })

  test('resume accepts UUIDv7-shaped thread ids but rejects non-UUID checkpoints', async () => {
    const acceptedName = nameUnder()
    const threadId = '019e5f5f-2e57-7abc-8def-123456789abc'
    spawned.push(acceptedName)

    const accepted = await engine.resume(
      {
        name: acceptedName,
        cwd,
        checkpoint: threadId,
        prompt: null,
        displayName: null,
      },
      ctx(),
    )
    expect(accepted).toMatchObject({ kind: 'resumed', checkpoint: threadId })

    const rejectedName = nameUnder()
    const rejected = await engine.resume(
      {
        name: rejectedName,
        cwd,
        checkpoint: 'not-a-thread-id',
        prompt: null,
        displayName: null,
      },
      ctx(),
    )
    expect(rejected).toEqual({
      kind: 'failed',
      message: 'codex thread id is not a valid uuid: not-a-thread-id',
    })
    expect(readBaseRecord(rejectedName)).toBeNull()
    expect(readDaemonState(rejectedName)).toBeNull()
  })

  test('concurrent same-name spawn keeps the winning daemon alive', async () => {
    const name = nameUnder()
    spawned.push(name)
    const slowCtx = ctxWithEnv({ ...process.env, CODEX_FAKE_BIND_DELAY_MS: '250' })

    const [first, second] = await Promise.all([
      engine.spawn(
        { name, cwd, resumeCheckpoint: null, prompt: null, timeoutMs: null, displayName: null },
        slowCtx,
      ),
      engine.spawn(
        { name, cwd, resumeCheckpoint: null, prompt: null, timeoutMs: null, displayName: null },
        slowCtx,
      ),
    ])

    const results = [first, second]
    expect(results.filter((result) => result.kind === 'spawned')).toHaveLength(1)
    const loser = results.find((result) => result.kind === 'already-exists')
    expect(loser).toEqual({ kind: 'already-exists', existingEngine: 'codex' })
    expect(daemonAlive(name)).toBe(true)
    expect(await engine.status({ name, lines: null }, ctx())).toMatchObject({
      kind: 'present',
      name,
      engine: 'codex',
    })
  })

  test('last and ctx read the persisted codex rollout for the current thread', async () => {
    const name = nameUnder()
    const threadId = '019e-rollout-last'
    writeDaemonFiles(name, threadId)
    const rollout = writeRollout(threadId, [
      {
        timestamp: '2026-05-24T00:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'agent_message',
          message: 'intermediate note',
          phase: 'commentary',
          memory_citation: null,
        },
      },
      {
        timestamp: '2026-05-24T00:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: 'final answer from rollout' }],
        },
      },
      {
        timestamp: '2026-05-24T00:00:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'agentMessage',
          text: 'camel agent message from rollout',
          phase: 'final_answer',
        },
      },
      {
        timestamp: '2026-05-24T00:00:04.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 12345,
              cached_input_tokens: 10000,
              output_tokens: 321,
              reasoning_output_tokens: 111,
              total_tokens: 12666,
            },
            model_context_window: 200000,
          },
        },
      },
    ])

    const last = await engine.last({ name }, ctx())
    expect(last).toEqual({ kind: 'text', text: 'camel agent message from rollout\n' })

    const context = await engine.ctx({ name, windowOverride: '' }, ctx())
    expect(context).toEqual({
      kind: 'usage',
      tokensUsed: 12666,
      tokensTotal: 200000,
      pct: 6,
    })

    const status = await engine.status({ name, lines: null }, ctx())
    expect(status).toMatchObject({
      kind: 'present',
      diagnostics: { thread: threadId, rollout },
    })
  })

  test('last reports not-found when the persisted thread has no rollout file', async () => {
    const name = nameUnder()
    writeDaemonFiles(name, '019e-missing-rollout')

    const last = await engine.last({ name }, ctx())

    expect(last).toMatchObject({
      kind: 'not-found',
      reason: expect.stringContaining("rollout for thread '019e-missing-rollout' not found"),
    })
  })

  test('list treats recent rollout writes as busy when RPC thread status is unavailable', async () => {
    const name = nameUnder()
    spawned.push(name)
    const nowMs = 1_800_000_000_000
    await engine.spawn(
      { name, cwd, resumeCheckpoint: null, prompt: null, timeoutMs: null, displayName: null },
      ctx(),
    )
    await engine.send(
      { name, prompt: 'seed a thread', timeoutMs: 5000, paneQuiet: false },
      ctx(),
    )
    const threadId = readDaemonState(name)?.threadId
    expect(threadId).toBeTypeOf('string')

    writeRollout(threadId!, [], nowMs - 5_000)
    const busy = (await engine.list({ now: () => nowMs, env: process.env }))
      .find((row) => row.name === name)
    expect(busy).toMatchObject({ state: 'busy', extras: { busy: 'yes' } })

    writeRollout(threadId!, [], nowMs - CODEX_ROLLOUT_BUSY_WINDOW_MS - 1_000)
    const idle = (await engine.list({ now: () => nowMs, env: process.env }))
      .find((row) => row.name === name)
    expect(idle).toMatchObject({ state: 'idle', extras: { busy: 'no' } })
  })

  test('list keeps busy when RPC thread status is idle but the rollout is fresh', async () => {
    const name = nameUnder()
    spawned.push(name)
    const nowMs = 1_800_000_000_000
    const threadReadCtx = ctxWithEnv({ ...process.env, CODEX_FAKE_THREAD_READ_STATUS: 'idle' })
    await engine.spawn(
      { name, cwd, resumeCheckpoint: null, prompt: null, timeoutMs: null, displayName: null },
      threadReadCtx,
    )
    await engine.send(
      { name, prompt: 'seed a thread', timeoutMs: 5000, paneQuiet: false },
      ctx(),
    )
    const threadId = readDaemonState(name)?.threadId
    expect(threadId).toBeTypeOf('string')

    writeRollout(threadId!, [], nowMs - 5_000)
    const busy = (await engine.list({ now: () => nowMs, env: process.env }))
      .find((row) => row.name === name)
    expect(busy).toMatchObject({
      state: 'busy',
      extras: { busy: 'yes', threadStatus: 'idle' },
    })

    writeRollout(threadId!, [], nowMs - CODEX_ROLLOUT_BUSY_WINDOW_MS - 1_000)
    const idle = (await engine.list({ now: () => nowMs, env: process.env }))
      .find((row) => row.name === name)
    expect(idle).toMatchObject({
      state: 'idle',
      extras: { busy: 'no', threadStatus: 'idle' },
    })
  })

  test('status closes a runtime-probe client that initializes after the timeout', async () => {
    const name = nameUnder()
    spawned.push(name)
    const connectionLog = join(registryDir, 'connections.log')
    const slowInitializeCtx = ctxWithEnv({
      ...process.env,
      CODEX_FAKE_CONNECTION_LOG: connectionLog,
      CODEX_FAKE_INITIALIZE_DELAY_MS: '400',
    })
    await engine.spawn(
      { name, cwd, resumeCheckpoint: null, prompt: null, timeoutMs: null, displayName: null },
      slowInitializeCtx,
    )
    await waitFor(() => connectionCounts(connectionLog).closes >= 1)
    const before = connectionCounts(connectionLog)

    const status = await engine.status({ name, lines: null }, ctx())

    expect(status).toMatchObject({
      kind: 'present',
      diagnostics: { socketReachable: 'no' },
    })
    await waitFor(() => connectionCounts(connectionLog).closes >= before.closes + 1)
    const after = connectionCounts(connectionLog)
    expect(after.opens).toBe(after.closes)
  })

  test('doctor reaps a crashed daemon registry entry', async () => {
    const name = nameUnder()
    spawned.push(name)
    await engine.spawn(
      { name, cwd, resumeCheckpoint: null, prompt: null, timeoutMs: null, displayName: null },
      ctx(),
    )
    const state = readDaemonState(name)
    expect(state).not.toBeNull()
    process.kill(state!.pid, 'SIGKILL')
    await new Promise((res) => setTimeout(res, 100))

    const report = await engine.doctor(ctx())
    expect(report.findings.some((finding) => finding.summary.includes(name))).toBe(true)
    expect(readDaemonState(name)).toBeNull()
    expect(readBaseRecord(name)).toBeNull()
  })
})
