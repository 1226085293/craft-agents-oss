import { describe, expect, it } from 'bun:test'
import type { FolderConfig } from '@craft-agent/shared/sessions/folders'
import { filterFolderSearchResults } from '../folder-search'

function folder(id: string, name: string, parentId: string | null, archivedAt?: number): FolderConfig {
  return { id, name, parentId, createdAt: 1, updatedAt: 1, archivedAt }
}

const folders = [
  folder('root-match', 'Alpha docs', null),
  folder('root-other', 'Beta notes', null),
  folder('nested-match', 'Alpha nested', 'root-match'),
  folder('deep-match', 'Alpha deep', 'nested-match'),
  folder('sibling-match', 'Alpha sibling', 'other-parent'),
  folder('archived-match', 'Alpha archived', null, 10),
  folder('archived-child-match', 'Alpha archived child', 'archived-match'),
]

describe('filterFolderSearchResults', () => {
  it('returns matching folders throughout the current directory tree', () => {
    expect(filterFolderSearchResults(folders, null, 'alpha').map(({ id }) => id))
      .toEqual(['root-match', 'nested-match', 'deep-match'])
  })

  it('finds matching descendants under the current folder without crossing into siblings', () => {
    expect(filterFolderSearchResults(folders, 'root-match', 'alpha').map(({ id }) => id))
      .toEqual(['nested-match', 'deep-match'])
  })

  it('matches Chinese folder names', () => {
    expect(filterFolderSearchResults([folder('你好', '你好测试', null)], null, '你好').map(({ id }) => id))
      .toEqual(['你好'])
  })

  it('returns all active direct children when there is no query', () => {
    expect(filterFolderSearchResults(folders, null, '').map(({ id }) => id))
      .toEqual(['root-match', 'root-other'])
  })
})
