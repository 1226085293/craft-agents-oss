import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  getSessionFilePath,
  loadSession,
  writeSessionJsonl,
  type StoredSession,
} from '@craft-agent/shared/sessions'
import type { StoredMessage } from '@craft-agent/core/types'
import { SessionManager, createManagedSession } from './SessionManager.ts'

// Regression test for the silent-drop bug in persistSession:
//
//   On startup, sessions load with messagesLoaded=false and only get loaded
//   on first getSession(). The old persistSession early-returned in that
//   state to avoid wiping the JSONL with []. As a result, status/label/rename
//   changes on sessions the user hadn't opened since restart were never
//   written to disk and were lost on the next restart.
//
// The fix routes cold-session persists through ensureMessagesLoaded so the
// existing JSONL messages are loaded first, then the full record (with the
// new metadata) is enqueued. flushSession awaits the in-flight load+enqueue
// so durability holds for sync mutate-then-flush callers.

describe('cold-session metadata persistence', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-cold-meta-'))
    sm = new SessionManager()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildWorkspace() {
    return {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    } as never
  }

  // Seed a session JSONL on disk to simulate a session present from a
  // previous app run, then register it in the SessionManager with the
  // post-restart `messagesLoaded: false` state — i.e. metadata only.
  function seedColdSession(
    sessionId: string,
    opts: {
      name?: string
      messages?: StoredMessage[]
    } = {},
  ) {
    const filePath = getSessionFilePath(tmpRoot, sessionId)
    mkdirSync(dirname(filePath), { recursive: true })
    const stored: StoredSession = {
      id: sessionId,
      workspaceRootPath: tmpRoot,
      name: opts.name ?? 'cold session',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: opts.messages ?? [],
    } as StoredSession
    writeSessionJsonl(filePath, stored)

    const managed = createManagedSession(
      {
        id: sessionId,
        name: stored.name,
        createdAt: stored.createdAt,
      },
      buildWorkspace(),
      // messagesLoaded defaults to false — this is the cold-session state.
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)
  }

  function readDiskHeader(sessionId: string): Record<string, unknown> {
    const path = getSessionFilePath(tmpRoot, sessionId)
    const firstLine = readFileSync(path, 'utf-8').split('\n')[0]
    return JSON.parse(firstLine)
  }

  function readDiskMessageIds(sessionId: string): string[] {
    const path = getSessionFilePath(tmpRoot, sessionId)
    if (!existsSync(path)) return []
    const lines = readFileSync(path, 'utf-8').trim().split('\n').slice(1)
    return lines.map(l => JSON.parse(l)).map(m => m.id as string)
  }

  function makeUserMessage(id: string, content: string): StoredMessage {
    return { id, type: 'user', content, timestamp: Date.now() } as StoredMessage
  }

  it('setSessionProjectId on a cold session is on disk after flushSession resolves', async () => {
    const sessionId = 'cold-project'
    seedColdSession(sessionId)

    await sm.setSessionProjectId(sessionId, 'proj-1')

    const header = readDiskHeader(sessionId)
    expect(header.projectId).toBe('proj-1')

    const reloaded = loadSession(tmpRoot, sessionId)
    expect(reloaded?.projectId).toBe('proj-1')
  })

  it('renameSession on a cold session persists (with explicit flushSession)', async () => {
    const sessionId = 'cold-rename'
    seedColdSession(sessionId, { name: 'old name' })

    // renameSession does not flush internally; mirror the production order
    // (rename → flushSession). Without the cold-load fix, this assertion fails
    // because persistSession silently dropped the enqueue.
    await sm.renameSession(sessionId, 'new name')
    await sm.flushSession(sessionId)

    const header = readDiskHeader(sessionId)
    expect(header.name).toBe('new name')
  })

  it('cold-session persist preserves existing messages on disk', async () => {
    const sessionId = 'cold-preserve-msgs'
    const seededMessages = [
      makeUserMessage('m1', 'hello'),
      makeUserMessage('m2', 'world'),
      makeUserMessage('m3', 'three'),
    ]
    seedColdSession(sessionId, { messages: seededMessages })

    // Sanity: messages are on disk before mutation.
    expect(readDiskMessageIds(sessionId)).toEqual(['m1', 'm2', 'm3'])

    await sm.setSessionProjectId(sessionId, 'proj-preserve')

    // Header reflects the new metadata…
    expect(readDiskHeader(sessionId).projectId).toBe('proj-preserve')
    // …and the seeded messages survive (regression: original guard's intent).
    expect(readDiskMessageIds(sessionId)).toEqual(['m1', 'm2', 'm3'])
  })

  it('concurrent cold-session metadata changes serialize to last-writer-wins on disk', async () => {
    const sessionId = 'cold-concurrent'
    seedColdSession(sessionId)

    // Fire two mutations back-to-back without awaiting the first. Both flow
    // through the cold-persist path; ensureMessagesLoaded dedupes the load,
    // and the persistence queue debounces enqueues. Both calls must resolve
    // and disk must reflect the second value with no JSONL corruption.
    const p1 = sm.setSessionProjectId(sessionId, 'proj-a')
    const p2 = sm.setSessionProjectId(sessionId, 'proj-b')
    await Promise.all([p1, p2])

    // Disk header has the last value.
    expect(readDiskHeader(sessionId).projectId).toBe('proj-b')

    // JSONL is well-formed: every line parses, none is empty.
    const lines = readFileSync(getSessionFilePath(tmpRoot, sessionId), 'utf-8')
      .trim()
      .split('\n')
    for (const line of lines) {
      expect(line.length).toBeGreaterThan(0)
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })

  it('flushSession on a cold session returns only after the disk write lands', async () => {
    const sessionId = 'cold-flush-ordering'
    seedColdSession(sessionId)

    // Mirror the production pattern where a caller mutates and immediately
    // flushes (e.g. a metadata write, or any UI flow that quits the app
    // right after a metadata change). The disk must reflect the new value
    // by the time flushSession resolves — no debounce window.
    const managed = (sm as unknown as { sessions: Map<string, { projectId?: string }> })
      .sessions.get(sessionId)!
    managed.projectId = 'proj-cancelled'
    ;(sm as unknown as { persistSession: (m: unknown) => void }).persistSession(managed)
    await sm.flushSession(sessionId)

    expect(readDiskHeader(sessionId).projectId).toBe('proj-cancelled')
  })
})
