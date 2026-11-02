import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  archiveFolder,
  createFolder,
  loadFolderConfig,
  saveFolderConfig,
  unarchiveFolder,
  type FolderScope,
} from '../folders.ts'

const scope: FolderScope = { projectId: null }

describe('unarchive restores the previous position', () => {
  let ws: string

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'folders-unarchive-order-'))
  })

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true })
  })

  it('keeps the archived sortOrder when the slot is still free', () => {
    const a = createFolder(ws, scope, { name: 'Alpha' })
    const b = createFolder(ws, scope, { name: 'Beta' })
    const c = createFolder(ws, scope, { name: 'Gamma' })
    expect(b.sortOrder).toBeDefined()

    archiveFolder(ws, scope, b.id)
    unarchiveFolder(ws, scope, b.id)

    const after = loadFolderConfig(ws, scope)
    const byId = new Map(after.folders.map((folder) => [folder.id, folder]))
    expect(byId.get(b.id)!.sortOrder).toBe(b.sortOrder)
    const ordered = after.folders
      .filter((folder) => !folder.parentId)
      .sort((x, y) => (x.sortOrder! < y.sortOrder! ? -1 : 1))
      .map((folder) => folder.id)
    expect(ordered).toEqual([a.id, b.id, c.id])
  })

  it('appends when a live sibling already holds the previous sort key', () => {
    const a = createFolder(ws, scope, { name: 'Alpha' })
    const b = createFolder(ws, scope, { name: 'Beta' })
    archiveFolder(ws, scope, b.id)

    const config = loadFolderConfig(ws, scope)
    const taken = config.folders.find((folder) => folder.id === a.id)!
    const archived = config.folders.find((folder) => folder.id === b.id)!
    taken.sortOrder = archived.sortOrder
    saveFolderConfig(ws, scope, config)

    unarchiveFolder(ws, scope, b.id)

    const after = loadFolderConfig(ws, scope)
    const restored = after.folders.find((folder) => folder.id === b.id)!
    expect(restored.sortOrder).not.toBe(archived.sortOrder)
    expect(restored.sortOrder! > taken.sortOrder!).toBe(true)
  })
})