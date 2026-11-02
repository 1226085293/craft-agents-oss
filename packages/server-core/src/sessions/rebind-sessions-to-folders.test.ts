import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject } from '@craft-agent/shared/projects'
import { createFolder } from '@craft-agent/shared/sessions'
import { serializeEnvelope, deserializeEnvelope } from '../transport/codec.ts'
import { createManagedSession, SessionManager } from './SessionManager.ts'

describe('rebindSessionsToFolders', () => {
  let root: string
  let manager: SessionManager

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rebind-folder-scope-'))
    manager = new SessionManager()
  })

  afterEach(async () => {
    await manager.flushAllSessions()
    rmSync(root, { recursive: true, force: true })
  })

  it('preserves project unbinding on the wire when a project folder is rebound into the root tree', async () => {
    const project = createProject(root, { name: 'Source' })
    const sourceFolder = createFolder(root, { projectId: project.id }, { name: 'Moved' })
    const targetFolder = createFolder(root, { projectId: null }, { name: 'Moved' })
    const workspace = { id: 'ws-rebind-root', name: 'test', rootPath: root, createdAt: Date.now() }
    const session = createManagedSession({ id: 'rebind-root', projectId: project.id, folderId: sourceFolder.id }, workspace as never, { messagesLoaded: true })
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(session.id, session)
    const events: unknown[] = []
    manager.setEventSink((_channel, _target, event) => events.push(event))

    await manager.rebindSessionsToFolders(
      workspace.id,
      { projectId: project.id },
      { projectId: null },
      { [sourceFolder.id]: targetFolder.id },
    )

    const metadata = events
      .map((event) => deserializeEnvelope(serializeEnvelope({
        id: 'metadata-event',
        type: 'event',
        channel: 'session:event',
        args: [event],
      })).args?.[0] as { type?: string; changes?: Record<string, unknown> })
      .find(event => event.type === 'session_metadata_changed')
    expect(metadata?.changes).toHaveProperty('projectId', null)
  })

  it('remaps moved sessions in the source scope without changing same-id sessions in another project', async () => {
    const project = createProject(root, { name: 'Target' })
    const fromScope = { projectId: null }
    const toScope = { projectId: project.id }
    createFolder(root, toScope, { name: 'Existing' })
    const targetFolder = createFolder(root, toScope, { name: 'Moved-2' })
    const workspace = { id: 'ws-rebind', name: 'test', rootPath: root, createdAt: Date.now() }

    const sourceSession = createManagedSession({ id: 'source', folderId: 'moved', hasUnread: true }, workspace as never, { messagesLoaded: true })
    const sameIdOtherProject = createManagedSession({ id: 'other', projectId: project.id, folderId: 'moved', hasUnread: true }, workspace as never, { messagesLoaded: true })
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(sourceSession.id, sourceSession)
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(sameIdOtherProject.id, sameIdOtherProject)

    await manager.rebindSessionsToFolders('ws-rebind', fromScope, toScope, { moved: targetFolder.id })

    expect(sourceSession.projectId).toBe(project.id)
    expect(sourceSession.folderId).toBe(targetFolder.id)
    expect(sameIdOtherProject.projectId).toBe(project.id)
    expect(sameIdOtherProject.folderId).toBe('moved')
    expect(sourceSession.hasUnread).toBe(true)
  })
})
