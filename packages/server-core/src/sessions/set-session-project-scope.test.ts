import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFolder } from '@craft-agent/shared/sessions'
import { createProject } from '@craft-agent/shared/projects'
import { serializeEnvelope, deserializeEnvelope } from '../transport/codec.ts'
import { createManagedSession, SessionManager } from './SessionManager.ts'

function roundTripEvent(event: unknown): { type?: string; changes?: Record<string, unknown> } {
  const envelope = serializeEnvelope({
    id: 'metadata-event',
    type: 'event',
    channel: 'session:event',
    args: [event],
  })
  return deserializeEnvelope(envelope).args?.[0] as { type?: string; changes?: Record<string, unknown> }
}

describe('setSessionProjectId folder scope hygiene', () => {
  let root: string
  let manager: SessionManager

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'session-project-scope-'))
    manager = new SessionManager()
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const addSession = (id: string, workspace: unknown, folderId: string | null) => {
    const session = createManagedSession({ id, name: id, folderId }, workspace as never, { messagesLoaded: true })
    Object.assign(session, { folderId: folderId ?? undefined })
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(id, session)
    return session
  }

  it('drops a source-scope folderId when the target scope does not own that id', async () => {
    const workspace = { id: 'ws-scope', name: 'test', rootPath: root, createdAt: Date.now() }
    const project = createProject(root, { name: 'Target' })
    const rootFolder = createFolder(root, { projectId: null }, { name: 'RootOnly' })
    const session = addSession('cross-scope', workspace, rootFolder.id)
    const events: Array<{ type?: string; changes?: Record<string, unknown> }> = []
    manager.setEventSink((_channel, _target, event) => events.push(event as never))

    await manager.setSessionProjectId(session.id, project.id)

    // A foreign folder id would hide the session from both trees.
    expect(session.folderId).toBeUndefined()
    const metadata = events.find(event => event.type === 'session_metadata_changed')
    expect(metadata?.changes).toMatchObject({ projectId: project.id, folderId: null })
  })

  it('preserves the project-unbind signal on the wire when setSessionProjectId moves a session to the root', async () => {
    const workspace = { id: 'ws-unbind', name: 'test', rootPath: root, createdAt: Date.now() }
    const project = createProject(root, { name: 'Source' })
    const session = createManagedSession({ id: 'unbind-via-project-id', name: 'unbind', projectId: project.id }, workspace as never, { messagesLoaded: true })
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(session.id, session)
    const events: unknown[] = []
    manager.setEventSink((_channel, _target, event) => events.push(event))

    await manager.setSessionProjectId(session.id, null)

    const metadata = events
      .map(roundTripEvent)
      .find(event => event.type === 'session_metadata_changed')
    expect(metadata?.changes).toHaveProperty('projectId', null)
  })

  it('preserves the project-unbind signal on the wire when moveSessionToScope moves a session to the root tree', async () => {
    const workspace = { id: 'ws-move-root', name: 'test', rootPath: root, createdAt: Date.now() }
    const project = createProject(root, { name: 'Source' })
    const targetFolder = createFolder(root, { projectId: null }, { name: 'Destination' })
    const session = createManagedSession({ id: 'move-to-root', name: 'move', projectId: project.id }, workspace as never, { messagesLoaded: true })
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(session.id, session)
    const events: unknown[] = []
    manager.setEventSink((_channel, _target, event) => events.push(event))

    await manager.moveSessionToScope(session.id, null, targetFolder.id)

    const metadata = events
      .map(roundTripEvent)
      .find(event => event.type === 'session_metadata_changed')
    expect(metadata?.changes).toHaveProperty('projectId', null)
  })

  it('keeps the folderId when the target scope has a folder with the same id', async () => {
    const workspace = { id: 'ws-scope-2', name: 'test', rootPath: root, createdAt: Date.now() }
    const project = createProject(root, { name: 'Target' })
    const rootFolder = createFolder(root, { projectId: null }, { name: 'Shared' })
    // Same slug in the project tree: scope-local ids may legitimately match.
    createFolder(root, { projectId: project.id }, { name: 'Shared' })
    const session = addSession('same-id', workspace, rootFolder.id)

    await manager.setSessionProjectId(session.id, project.id)

    expect(session.folderId).toBe(rootFolder.id)
  })
})
