import { describe, expect, it } from 'bun:test'
import { getUniqueFolderName } from '../folder-tree.ts'
import type { FolderConfig } from '../folders.ts'

function folder(id: string, name: string, parentId: string | null): FolderConfig {
  return { id, name, parentId, createdAt: 0, updatedAt: 0 }
}

describe('getUniqueFolderName', () => {
  const folders = [
    folder('reports', '报告', null),
    folder('reports-2', '报告-2', null),
    folder('child-report', '报告', 'parent'),
  ]

  it('suggests the next numeric suffix among siblings', () => {
    expect(getUniqueFolderName('报告', folders, null)).toBe('报告-3')
  })

  it('allows the same name under a different parent', () => {
    expect(getUniqueFolderName('报告', folders, 'other-parent')).toBe('报告')
  })

  it('excludes the folder being renamed', () => {
    expect(getUniqueFolderName('报告', folders, null, 'reports')).toBe('报告')
  })

  it('compares names without case sensitivity', () => {
    expect(getUniqueFolderName('reports', [folder('Reports', 'Reports', null)], null)).toBe('reports-2')
  })
})
