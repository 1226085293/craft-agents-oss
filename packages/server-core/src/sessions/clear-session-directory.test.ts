import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SessionManager,
  createManagedSession,
} from './SessionManager.ts'
import { ensureSessionDir, getSessionPath } from '@craft-agent/shared/sessions'

describe('clearSessionMessages resets session working directory', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-clear-dir-'))
    sm = new SessionManager()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildSession(id: string) {
    const workspace = {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id, name: 'clear-dir test' },
      workspace as never,
      { messagesLoaded: true },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  it('removes leftover files and recreates standard subdirectories', async () => {
    const sessionId = 'clear-dir-1'
    const managed = buildSession(sessionId)

    // Set up the initial session directory structure
    ensureSessionDir(tmpRoot, sessionId)
    const sessionDir = getSessionPath(tmpRoot, sessionId)

    // Write the session data file (must be preserved)
    writeFileSync(join(sessionDir, 'session.jsonl'), '{"id":"clear-dir-1"}\n')

    // Create leftover files that should be removed
    writeFileSync(join(sessionDir, 'restart-wechat.ps1'), 'Write-Host "restart"')
    writeFileSync(join(sessionDir, 'some-script.sh'), '#!/bin/bash\necho hi')
    mkdirSync(join(sessionDir, 'custom-output'), { recursive: true })
    writeFileSync(join(sessionDir, 'custom-output', 'result.txt'), 'data')

    // Put content in standard subdirectories (should be cleared)
    writeFileSync(join(sessionDir, 'attachments', 'file.png'), 'fake-image')
    writeFileSync(join(sessionDir, 'plans', 'plan.md'), '# Plan')
    writeFileSync(join(sessionDir, 'data', 'table.json'), '{}')
    writeFileSync(join(sessionDir, 'downloads', 'doc.pdf'), 'fake-pdf')

    // Create .pi-agent directory (must be preserved)
    mkdirSync(join(sessionDir, '.pi-agent'), { recursive: true })
    writeFileSync(join(sessionDir, '.pi-agent', 'state.json'), '{}')

    // Run the directory reset
    await (sm as unknown as { resetSessionDirectory: (m: unknown) => Promise<void> })
      .resetSessionDirectory(managed)

    // session.jsonl must be preserved
    expect(existsSync(join(sessionDir, 'session.jsonl'))).toBe(true)

    // .pi-agent must be preserved
    expect(existsSync(join(sessionDir, '.pi-agent', 'state.json'))).toBe(true)

    // Leftover files must be removed
    expect(existsSync(join(sessionDir, 'restart-wechat.ps1'))).toBe(false)
    expect(existsSync(join(sessionDir, 'some-script.sh'))).toBe(false)
    expect(existsSync(join(sessionDir, 'custom-output'))).toBe(false)

    // Standard subdirectories must be recreated empty
    expect(existsSync(join(sessionDir, 'attachments'))).toBe(true)
    expect(existsSync(join(sessionDir, 'plans'))).toBe(true)
    expect(existsSync(join(sessionDir, 'data'))).toBe(true)
    expect(existsSync(join(sessionDir, 'downloads'))).toBe(true)
    expect(existsSync(join(sessionDir, 'long_responses'))).toBe(true)

    // Standard subdirectories must be empty
    expect(readdirSync(join(sessionDir, 'attachments'))).toEqual([])
    expect(readdirSync(join(sessionDir, 'plans'))).toEqual([])
    expect(readdirSync(join(sessionDir, 'data'))).toEqual([])
    expect(readdirSync(join(sessionDir, 'downloads'))).toEqual([])
  })

  it('handles missing session directory gracefully', async () => {
    const sessionId = 'clear-dir-missing'
    const managed = buildSession(sessionId)

    // Don't create the session directory — resetSessionDirectory should not throw
    await expect(
      (sm as unknown as { resetSessionDirectory: (m: unknown) => Promise<void> })
        .resetSessionDirectory(managed),
    ).resolves.toBeUndefined()
  })
})
