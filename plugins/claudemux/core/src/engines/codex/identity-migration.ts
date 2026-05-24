/**
 * One-shot migration for Codex daemons spawned before the base identity
 * JSON existed. The Codex daemon registry proves liveness; `meta.json`
 * supplies the cwd when available.
 */

import { realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { NativeEnv } from '../../env'
import type { IdentityMigrator } from '../../identity/router'
import { read as readIdentity, reserve as reserveIdentity } from '../../persistence/identity-store'
import type { TeammateName } from '../types'
import { CodexTeammateRecord, readCodexMeta } from './persistence'
import { daemonAlive, readDaemonState } from './supervisor'

function normalizeExistingPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function fallbackCodexCwd(env: NativeEnv, name: TeammateName): string {
  const candidate = join(env.dispatcherDir, name)
  try {
    if (statSync(candidate).isDirectory()) return realpathSync(candidate)
  } catch {
    // Fall through to the dispatcher dir: Codex spawn uses it when no
    // sibling repo with the daemon name exists.
  }
  return normalizeExistingPath(env.dispatcherDir)
}

export function createCodexIdentityMigrator(env: NativeEnv): IdentityMigrator {
  return async (name) => {
    if (readIdentity(name) !== null) return
    if (!daemonAlive(name)) return

    const meta = readCodexMeta(name)
    const state = readDaemonState(name)
    const record = new CodexTeammateRecord({
      name,
      cwd: meta?.cwd ?? fallbackCodexCwd(env, name),
      createdAt: meta?.spawnedAt ?? state?.startedAt ?? Math.floor(Date.now() / 1000),
      displayName: meta?.displayName ?? null,
    })
    reserveIdentity(record.toJson())
  }
}
