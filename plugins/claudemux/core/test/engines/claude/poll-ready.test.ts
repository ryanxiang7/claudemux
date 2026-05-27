/**
 * Regression coverage for `pollReady` in
 * [`src/engines/claude/spawn.ts`](../../../src/engines/claude/spawn.ts) —
 * the loop `tm spawn` blocks on while it waits for the SessionStart hook
 * to touch `<name>.ready`.
 *
 * Two invariants under test:
 *
 *   1. The budget actually equals `READY_POLL_BUDGET_MS` (36 s). A
 *      timeout that fires earlier puts us back in the false-alarm
 *      regime phase-1 audit item B was opened against.
 *   2. The trailing iteration of the loop **must** do an `existsSync`
 *      *after* the final sleep, not before. The pre-fix count-based
 *      loop (`for i in 1..N { existsSync; sleep }`) only inspected the
 *      file at `t = 0, INTERVAL, 2·INTERVAL, …, (N-1)·INTERVAL` and
 *      then returned `null` without ever checking at `t = N·INTERVAL`.
 *      A ready file landing in the final `INTERVAL`-ms window slipped
 *      through.
 *
 * Tests run under `vi.useFakeTimers()` so `sleepMs` returns instantly
 * once the fake clock is advanced; `existsSync` is genuine and reads
 * the real filesystem, so each test uses a unique teammate name under
 * `/tmp/teammate-…` and cleans up its own marker.
 */

import { existsSync, rmSync, writeFileSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  pollReady,
  READY_POLL_BUDGET_MS,
  READY_POLL_INTERVAL_MS,
} from '../../../src/engines/claude/spawn'
import { readyFile } from '../../../src/persistence/paths'

/** Unique teammate name per test, so concurrent or interrupted runs do not collide. */
function teammate(suffix: string): string {
  return `claudemux-pollready-${suffix}-${process.pid}`
}

function clear(name: string): void {
  rmSync(readyFile(name), { force: true })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('pollReady — readiness budget + boundary behavior', () => {
  test('returns ~0 ms when the ready file is present before the first check', async () => {
    const name = teammate('present-at-start')
    clear(name)
    writeFileSync(readyFile(name), '')
    try {
      const elapsed = await pollReady(name)
      expect(elapsed).toBe(0)
    } finally {
      clear(name)
    }
  })

  test('catches a ready file that appears in the final interval before the deadline (regression)', async () => {
    const name = teammate('final-interval')
    clear(name)
    try {
      // Don't start with the file present — let the loop poll for it.
      const pending = pollReady(name)
      // Advance to the moment the OLD count-based loop did its last
      // `existsSync` (one interval short of the budget). At this point the
      // file still must not exist — that's the exact bug we are guarding
      // against.
      await vi.advanceTimersByTimeAsync(READY_POLL_BUDGET_MS - READY_POLL_INTERVAL_MS)
      expect(existsSync(readyFile(name))).toBe(false)

      // Now write the marker. With the pre-fix loop, the trailing sleep
      // ran to t = BUDGET_MS without ever checking again — `pending` would
      // resolve to `null`. The deadline-based loop does one more
      // `existsSync` at t ≈ BUDGET_MS, which must catch this write.
      writeFileSync(readyFile(name), '')
      await vi.advanceTimersByTimeAsync(READY_POLL_INTERVAL_MS)
      const elapsed = await pending
      expect(elapsed).not.toBeNull()
      // The final check fires at `t = BUDGET_MS`; that is the reported
      // elapsed because the file was written just before that check.
      expect(elapsed).toBe(READY_POLL_BUDGET_MS)
    } finally {
      clear(name)
    }
  })

  test('returns null only after the full budget elapses when the ready file never appears', async () => {
    const name = teammate('never-ready')
    clear(name)
    try {
      const pending = pollReady(name)
      // Advance one interval short of the budget — must still be polling.
      let settled = false
      pending.then(() => {
        settled = true
      })
      await vi.advanceTimersByTimeAsync(READY_POLL_BUDGET_MS - READY_POLL_INTERVAL_MS)
      expect(settled).toBe(false)

      // Cross the deadline — pollReady must give up exactly here, not earlier.
      await vi.advanceTimersByTimeAsync(READY_POLL_INTERVAL_MS)
      const elapsed = await pending
      expect(elapsed).toBeNull()
    } finally {
      clear(name)
    }
  })
})
