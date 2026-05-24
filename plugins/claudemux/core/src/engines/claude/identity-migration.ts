/**
 * One-shot migration for Claude teammates that were spawned before the
 * base identity JSON existed. It materialises `/tmp/teammate-<name>.json`
 * from the live tmux session plus the legacy `.cwd` marker, then the
 * production router re-reads the JSON and routes normally.
 */

import { realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { NativeEnv } from '../../env'
import type { IdentityMigrator } from '../../identity/router'
import { read as readIdentity, reserve as reserveIdentity } from '../../persistence/identity-store'
import { readIfPresent } from '../../persistence/atomic-file'
import type { TeammateName } from '../types'
import { ClaudeTeammateRecord, cwdFile, sidFile, tmuxSessionName } from './persistence'

function rstrip(text: string): string {
  return text.replace(/\n+$/, '')
}

function normalizeExistingPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function readLegacyCwd(name: TeammateName): string | null {
  const raw = readIfPresent(cwdFile(name))
  if (raw === null) return null
  const cwd = rstrip(raw)
  return cwd.length === 0 ? null : normalizeExistingPath(cwd)
}

function hasLegacyMarker(name: TeammateName): boolean {
  return readIfPresent(cwdFile(name)) !== null || readIfPresent(sidFile(name)) !== null
}

function legacyCreatedAt(name: TeammateName, nowMs: number): number {
  try {
    return Math.floor(statSync(cwdFile(name)).mtimeMs / 1000)
  } catch {
    return Math.floor(nowMs / 1000)
  }
}

async function tmuxSessionExists(env: NativeEnv, sessionName: string): Promise<boolean> {
  try {
    return (await env.runTmux(['has-session', '-t', `=${sessionName}`])).code === 0
  } catch {
    return false
  }
}

async function tmuxPaneCwd(env: NativeEnv, sessionName: string): Promise<string | null> {
  try {
    const result = await env.runTmux([
      'display-message',
      '-p',
      '-t',
      `=${sessionName}`,
      '#{pane_current_path}',
    ])
    if (result.code !== 0) return null
    const cwd = result.stdout.trim()
    return cwd.length === 0 ? null : normalizeExistingPath(cwd)
  } catch {
    return null
  }
}

function repoCwdFallback(env: NativeEnv, name: TeammateName): string | null {
  const candidate = join(env.dispatcherDir, name)
  try {
    if (statSync(candidate).isDirectory()) return realpathSync(candidate)
  } catch {
    return null
  }
  return null
}

export function createClaudeIdentityMigrator(env: NativeEnv): IdentityMigrator {
  return async (name) => {
    if (readIdentity(name) !== null) return

    const sessionName = tmuxSessionName(name)
    const liveTmux = await tmuxSessionExists(env, sessionName)
    if (!liveTmux && !hasLegacyMarker(name)) return

    const cwd =
      readLegacyCwd(name) ??
      await tmuxPaneCwd(env, sessionName) ??
      repoCwdFallback(env, name) ??
      ''

    const record = new ClaudeTeammateRecord({
      name,
      cwd,
      createdAt: legacyCreatedAt(name, Date.now()),
      displayName: null,
    })
    reserveIdentity(record.toJson())
  }
}
