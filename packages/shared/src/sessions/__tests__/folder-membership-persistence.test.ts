import { describe, expect, it } from 'bun:test'
import { createSessionHeader } from '../jsonl.ts'
import { SESSION_PERSISTENT_FIELDS } from '../types.ts'

const FOLDER_FIELDS = [
  'folderId',
  'archivedFolderId',
  'archivedFolderPath',
  'archivedProjectId',
  'archivedByParent',
  'sortOrder',
  'pinnedAt',
] as const

describe('folder membership persistence', () => {
  it('keeps every folder field in the persistent whitelist', () => {
    for (const field of FOLDER_FIELDS) {
      expect(SESSION_PERSISTENT_FIELDS).toContain(field)
    }
  })

  it('serializes folder membership into the session header', () => {
    const session = {
      id: 'sess-folder-membership',
      workspaceRootPath: '/ws',
      createdAt: 1,
      lastUsedAt: 1,
      folderId: 'alpha',
      archivedFolderId: 'beta',
      archivedFolderPath: ['工程', 'Craft'],
      archivedProjectId: 'proj-1',
      archivedByParent: 'alpha',
      sortOrder: 'k',
      pinnedAt: 123,
      messages: [],
    } as never

    const header = createSessionHeader(session) as unknown as Record<string, unknown>

    expect(header.folderId).toBe('alpha')
    expect(header.archivedFolderId).toBe('beta')
    expect(header.archivedFolderPath).toEqual(['工程', 'Craft'])
    expect(header.archivedProjectId).toBe('proj-1')
    expect(header.archivedByParent).toBe('alpha')
    expect(header.sortOrder).toBe('k')
    expect(header.pinnedAt).toBe(123)
  })
})