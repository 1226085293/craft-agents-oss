import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createProject } from '../../projects/storage.ts'
import { createFolder, loadFolderConfig, moveFolder, moveFolderToScope, renameFolder, type FolderScope } from '../folders.ts'

let workspaceRoot: string
const rootScope: FolderScope = { projectId: null }

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'folders-name-conflicts-'))
})

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
})

describe('folder sibling-name uniqueness', () => {
  it('rejects creating a duplicate name among siblings but permits another parent', () => {
    const parent = createFolder(workspaceRoot, rootScope, { name: 'Parent' })
    createFolder(workspaceRoot, rootScope, { name: 'Notes' })
    expect(() => createFolder(workspaceRoot, rootScope, { name: 'notes' })).toThrow(/already exists/i)
    expect(createFolder(workspaceRoot, rootScope, { name: 'Notes', parentId: parent.id }).name).toBe('Notes')
  })

  it('rejects renaming a folder to a sibling name', () => {
    const first = createFolder(workspaceRoot, rootScope, { name: 'First' })
    createFolder(workspaceRoot, rootScope, { name: 'Second' })
    expect(() => renameFolder(workspaceRoot, rootScope, first.id, 'second')).toThrow(/already exists/i)
  })

  it('rejects moving a folder beside a same-name sibling', () => {
    const parent = createFolder(workspaceRoot, rootScope, { name: 'Parent' })
    const folder = createFolder(workspaceRoot, rootScope, { name: 'Notes', parentId: parent.id })
    createFolder(workspaceRoot, rootScope, { name: 'Notes' })
    expect(moveFolder(workspaceRoot, rootScope, folder.id, null)).toEqual({ ok: false, reason: 'duplicate-name' })
  })

  it('moves across scopes into a target folder and rejects a conflicting sibling name', () => {
    const project = createProject(workspaceRoot, { name: 'Project' })
    const projectScope = { projectId: project.id }
    const source = createFolder(workspaceRoot, rootScope, { name: 'Notes' })
    const targetParent = createFolder(workspaceRoot, projectScope, { name: 'Target' })
    createFolder(workspaceRoot, projectScope, { name: 'Notes', parentId: targetParent.id })

    expect(moveFolderToScope(workspaceRoot, rootScope, source.id, projectScope, targetParent.id).ok).toBe(false)
    const accepted = moveFolderToScope(workspaceRoot, rootScope, source.id, projectScope, targetParent.id, 'Notes-2')
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) return
    expect(accepted.folder.parentId).toBe(targetParent.id)
    expect(accepted.folder.name).toBe('Notes-2')
    expect(loadFolderConfig(workspaceRoot, rootScope).folders.some((folder) => folder.id === source.id)).toBe(false)
  })

  it('remaps colliding IDs throughout the moved subtree', () => {
    const project = createProject(workspaceRoot, { name: 'Project' })
    const projectScope = { projectId: project.id }
    const source = createFolder(workspaceRoot, rootScope, { name: 'Common' })
    const child = createFolder(workspaceRoot, rootScope, { name: 'Child', parentId: source.id })
    const targetParent = createFolder(workspaceRoot, projectScope, { name: 'Target' })
    const colliding = createFolder(workspaceRoot, projectScope, { name: 'Common' })

    const result = moveFolderToScope(workspaceRoot, rootScope, source.id, projectScope, targetParent.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.folderIdMap?.[source.id]).not.toBe(colliding.id)
    expect(result.folder.parentId).toBe(targetParent.id)
    const targetFolders = loadFolderConfig(workspaceRoot, projectScope).folders
    const movedChild = targetFolders.find((folder) => folder.name === 'Child')!
    expect(movedChild.parentId).toBe(result.folder.id)
    expect(targetFolders.some((folder) => folder.id === colliding.id && folder.parentId === null)).toBe(true)
    // The whole target tree must stay addressable: a duplicated ID would make
    // one folder unreachable and render duplicate branches.
    expect(new Set(targetFolders.map((folder) => folder.id)).size).toBe(targetFolders.length)
    // Moving the same folder again must not append a second copy.
    expect(moveFolderToScope(workspaceRoot, rootScope, source.id, projectScope, targetParent.id)).toEqual({ ok: false, reason: 'not-found' })
    expect(loadFolderConfig(workspaceRoot, projectScope).folders).toHaveLength(targetFolders.length)
  })
})
