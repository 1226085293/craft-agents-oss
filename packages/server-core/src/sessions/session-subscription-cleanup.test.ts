import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager, createManagedSession } from './SessionManager.ts'

/**
 * Deleting a session must not leave dangling subscriptions: as a target it
 * disappears from every follower's list, and as a follower its own entry is
 * dropped.
 */
describe('deleteSession subscription cleanup', () => {
  let root: string
  let sm: SessionManager

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sm-sub-del-'))
    sm = new SessionManager()
  })

  afterEach(async () => {
    await sm.flushAllSessions()
    rmSync(root, { recursive: true, force: true })
  })

  function addSession(id: string) {
    const workspace = { id: 'ws-del', name: 'test', rootPath: root, createdAt: Date.now() }
    const managed = createManagedSession({ id, name: id }, workspace as never, { messagesLoaded: true })
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
  }

  it('removes the deleted session from its followers', async () => {
    addSession('a')
    addSession('b')
    sm.subscribeSession('a', 'b')

    await sm.deleteSession('b')

    expect(sm.listSubscriptions('a')).toEqual([])
  })

  it('drops the deleted subscriber entry entirely', async () => {
    addSession('a')
    addSession('b')
    sm.subscribeSession('a', 'b')

    await sm.deleteSession('a')

    expect(sm.listSubscriptions('a')).toEqual([])
  })
})
