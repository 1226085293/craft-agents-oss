import { describe, expect, it } from 'bun:test'
import { getFolderIdsToCollapseOnAncestorNavigation, getFolderPathParts } from '../folder-path'

const folders = [
  { id: '123', name: '123', parentId: null },
  { id: '789', name: '789', parentId: '123' },
]

describe('getFolderPathParts', () => {
  it('shows project and folder breadcrumbs from the current folder back to the root', () => {
    expect(getFolderPathParts(folders, '789', '测试')).toEqual(['789', '123', '测试'])
  })

  it('returns just the project base when no folder is selected', () => {
    expect(getFolderPathParts(folders, null, '测试')).toEqual(['测试'])
  })

  it('returns an empty path when the selected folder is not in this scope', () => {
    expect(getFolderPathParts(folders, 'missing')).toEqual([])
  })

  it('collapses the departed folder branch when navigating to its ancestor', () => {
    expect(getFolderIdsToCollapseOnAncestorNavigation(folders, '789', '123')).toEqual(['789'])
  })

  it('collapses every departed folder between a deep leaf and its ancestor', () => {
    const nested = [...folders, { id: '999', name: '999', parentId: '789' }]
    expect(getFolderIdsToCollapseOnAncestorNavigation(nested, '999', null)).toEqual(['999', '789', '123'])
  })

  it('does not collapse folders when navigating downward or between branches', () => {
    expect(getFolderIdsToCollapseOnAncestorNavigation(folders, '123', '789')).toEqual([])
    expect(getFolderIdsToCollapseOnAncestorNavigation(folders, '789', 'missing')).toEqual([])
  })
})
