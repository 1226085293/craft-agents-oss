import { describe, expect, it } from 'bun:test'
import { filterContentSearchResultsBySessionIds, filterSessionsByFolderScope, filterSessionsByFolderSearchScope } from '../session-search-scope'
import type { FolderConfig } from '@craft-agent/shared/sessions/folders'

const sessions = [
  { id: 'root', projectId: null, folderId: null },
  { id: 'root-folder', projectId: null, folderId: 'folder-a' },
  { id: 'project-a-root', projectId: 'project-a', folderId: null },
  { id: 'project-a-folder', projectId: 'project-a', folderId: 'folder-a' },
  { id: 'project-b-folder', projectId: 'project-b', folderId: 'folder-a' },
]

describe('filterContentSearchResultsBySessionIds', () => {
  it('drops content hits for sessions outside the active directory tree', () => {
    const results = new Map([
      ['in-scope', { matchCount: 2 }],
      ['outside-scope', { matchCount: 9 }],
    ])
    expect([...filterContentSearchResultsBySessionIds(results, new Set(['in-scope']))])
      .toEqual([['in-scope', { matchCount: 2 }]])
  })
})

describe('filterSessionsByFolderSearchScope', () => {
  const folders = [
    { id: 'folder-a', name: 'A', parentId: null },
    { id: 'folder-b', name: 'B', parentId: 'folder-a' },
    { id: 'folder-c', name: 'C', parentId: null },
  ] as FolderConfig[]
  const descendantsOfA = new Set(['folder-b'])
  const allFolderIds = new Set(folders.map(({ id }) => id))

  const searchableSessions = [
    { id: 'unfiled', folderId: null },
    { id: 'in-a', folderId: 'folder-a' },
    { id: 'in-b', folderId: 'folder-b' },
    { id: 'in-c', folderId: 'folder-c' },
  ]

  it('searches sessions in the current folder and descendants, not sibling trees', () => {
    expect(filterSessionsByFolderSearchScope(searchableSessions, 'folder-a', descendantsOfA, allFolderIds).map(({ id }) => id))
      .toEqual(['in-a', 'in-b'])
  })

  it('searches unfiled sessions and all active folders from the tree root', () => {
    expect(filterSessionsByFolderSearchScope(searchableSessions, null, allFolderIds, allFolderIds).map(({ id }) => id))
      .toEqual(['unfiled', 'in-a', 'in-b', 'in-c'])
  })
})

describe('filterSessionsByFolderScope', () => {
  const activeFolderIds = new Set(['folder-a'])

  it('keeps only sessions assigned to the active folder', () => {
    expect(filterSessionsByFolderScope(sessions, 'folder-a', activeFolderIds).map(({ id }) => id))
      .toEqual(['root-folder', 'project-a-folder', 'project-b-folder'])
  })

  it('keeps only unfiled sessions at the scope root', () => {
    expect(filterSessionsByFolderScope(sessions, null, activeFolderIds).map(({ id }) => id))
      .toEqual(['root', 'project-a-root'])
  })

  it('treats a folder id outside the active tree as unfiled', () => {
    const staleFolderSession = { id: 'stale', projectId: null, folderId: 'deleted-folder' }
    expect(filterSessionsByFolderScope([staleFolderSession], null, activeFolderIds))
      .toEqual([staleFolderSession])
  })
})
