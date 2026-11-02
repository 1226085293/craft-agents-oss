import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createManagedSession, SessionManager } from './SessionManager.ts'

describe('markAllSessionsRead project scope', () => {
  let root: string
  let manager: SessionManager

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mark-project-read-'))
    manager = new SessionManager()
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('marks only eligible sessions from the requested project as read', async () => {
    const workspace = { id: 'ws-project-read', name: 'test', rootPath: root, createdAt: Date.now() }
    const add = (id: string, options: Record<string, unknown>) => {
      const session = createManagedSession({ id, name: id, hasUnread: true, ...options } as never, workspace as never, { messagesLoaded: true })
      Object.assign(session, options)
      ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(id, session)
      return session
    }
    const selected = add('project-session', { projectId: 'project-a' })
    const otherProject = add('other-project', { projectId: 'project-b' })
    const processing = add('processing', { projectId: 'project-a', isProcessing: true })
    const hidden = add('hidden', { projectId: 'project-a', hidden: true })
    const archived = add('archived', { projectId: 'project-a', isArchived: true })
    const events: Array<{ type?: string; sessionId?: string }> = []
    manager.setEventSink((_channel, _target, event) => events.push(event as never))

    await manager.markAllSessionsRead(workspace.id, 'project-a')

    expect(selected.hasUnread).toBe(false)
    expect(otherProject.hasUnread).toBe(true)
    expect(processing.hasUnread).toBe(true)
    expect(hidden.hasUnread).toBe(true)
    expect(archived.hasUnread).toBe(true)
    expect(events.filter(event => event.type === 'session_metadata_changed').map(event => event.sessionId)).toEqual(['project-session'])
  })
})
