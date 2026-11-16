/**
 * The「已归档」tree exists to enforce one rule: a folder or session has exactly
 * ONE path. These tests pin both halves of it.
 *
 * Regression they guard: the archived view used to draw the LIVE folder
 * navigator. A live folder (T-2) therefore showed up under「已归档」while it was
 * still living in「所有会话」— two paths for one folder — and a folder that was
 * genuinely archived could not appear there at all, which made it unreachable:
 * `unarchiveFolder` had no call site in the whole renderer.
 */

import { describe, expect, it } from 'bun:test'
import { buildArchiveTree, buildFolderTree } from '../folder-tree.ts'
import type { FolderConfig } from '../folders.ts'

function folder(id: string, parentId: string | null, extra: Partial<FolderConfig> = {}): FolderConfig {
  return { id, name: id, parentId, createdAt: 0, updatedAt: 0, ...extra }
}

function session(id: string, folderId: string | null, extra: Record<string, unknown> = {}) {
  return { id, folderId, isArchived: true, archivedAt: 1, ...extra }
}

const archivedAt = 1700000000000

describe('archive tree — a live folder never enters the archive', () => {
  it('drops a live folder even when its sessions were archived one by one', () => {
    // The exact T-2 shape: the folder was never archived, two of its sessions
    // were archived individually. The archive view must NOT grow a T-2 node.
    const folders = [folder('t-2', null, { name: 'T-2' })]
    const sessions = [session('a', 't-2'), session('b', 't-2')]

    const result = buildArchiveTree({
      projects: [],
      foldersByScope: [{ projectId: null, folders }],
      sessions,
    })

    expect(result.nodes).toEqual([])
    // …and those sessions stay findable at the archive root instead of vanishing.
    expect(result.sessions.map((s) => s.id).sort()).toEqual(['a', 'b'])
  })

  it('keeps an archived folder out of the live tree', () => {
    const folders = [
      folder('keep', null, { name: 'Keep' }),
      folder('gone', null, { name: 'Gone', archivedAt }),
    ]

    const live = buildFolderTree(folders, { includeArchived: false })
    expect(live.map((node) => node.folder.id)).toEqual(['keep'])

    const archive = buildArchiveTree({
      projects: [],
      foldersByScope: [{ projectId: null, folders }],
      sessions: [],
    })
    expect(archive.nodes.map((node) => node.id)).toEqual(['gone'])
  })
})

describe('archive tree — archived folders are browsable', () => {
  it('nests an archived child under its archived parent', () => {
    const folders = [
      folder('parent', null, { name: 'Parent', archivedAt }),
      folder('child', 'parent', { name: 'Child', archivedAt }),
    ]

    const result = buildArchiveTree({
      projects: [],
      foldersByScope: [{ projectId: null, folders }],
      sessions: [],
    })

    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0]!.id).toBe('parent')
    expect(result.nodes[0]!.children.map((node) => node.id)).toEqual(['child'])
  })

  it('promotes an archived child of a live parent to the archive root, keeping its path', () => {
    const folders = [
      folder('parent', null, { name: 'Parent' }), // live — must not appear
      folder('child', 'parent', { name: 'Child', archivedAt }),
    ]

    const result = buildArchiveTree({
      projects: [],
      foldersByScope: [{ projectId: null, folders }],
      sessions: [],
    })

    expect(result.nodes.map((node) => node.id)).toEqual(['child'])
    // The path is what tells the user where it came from without resurrecting
    // the live parent as a second path.
    expect(result.nodes[0]!.path).toEqual(['Parent', 'Child'])
  })

  it('attaches an archived session to its archived folder, not to the root', () => {
    const folders = [folder('kept', null, { name: 'Kept', archivedAt })]
    const sessions = [session('inside', 'kept'), session('loose', null)]

    const result = buildArchiveTree({
      projects: [],
      foldersByScope: [{ projectId: null, folders }],
      sessions,
    })

    expect(result.nodes[0]!.sessions.map((s) => s.id)).toEqual(['inside'])
    expect(result.sessions.map((s) => s.id)).toEqual(['loose'])
  })

  it('attaches a session to the nearest archived ancestor when the parent is live', () => {
    // Archived grandparent → live parent → session. The session was archived
    // with the grandparent sweep, so it belongs to the archived node.
    const folders = [
      folder('root', null, { name: 'Root', archivedAt }),
      folder('live', 'root', { name: 'Live' }),
    ]
    const sessions = [session('s', 'live')]

    const result = buildArchiveTree({
      projects: [],
      foldersByScope: [{ projectId: null, folders }],
      sessions,
    })

    expect(result.nodes[0]!.id).toBe('root')
    expect(result.nodes[0]!.sessions.map((s) => s.id)).toEqual(['s'])
    expect(result.sessions).toEqual([])
  })
})

describe('archive tree — archived projects act as roots', () => {
  it('files an archived folder and its sessions under the archived project', () => {
    const folders = [folder('p-folder', null, { name: 'PFolder', archivedAt })]
    const sessions = [session('in-project', null, { projectId: 'proj' })]

    const result = buildArchiveTree({
      projects: [{ id: 'proj', name: 'Proj', archived: true }],
      foldersByScope: [{ projectId: 'proj', folders }],
      sessions,
    })

    const projectNode = result.nodes.find((node) => node.kind === 'project')
    expect(projectNode?.id).toBe('proj')
    expect(projectNode?.children.map((node) => node.id)).toEqual(['p-folder'])
    expect(projectNode?.sessions.map((s) => s.id)).toEqual(['in-project'])
  })

  it('ignores a project that was never archived', () => {
    const result = buildArchiveTree({
      projects: [{ id: 'proj', name: 'Proj', archived: false }],
      foldersByScope: [{ projectId: 'proj', folders: [] }],
      sessions: [session('s', null, { projectId: 'proj' })],
    })

    expect(result.nodes).toEqual([])
    // Not dropped: a live project must not swallow the archived session.
    expect(result.sessions.map((s) => s.id)).toEqual(['s'])
  })
})
