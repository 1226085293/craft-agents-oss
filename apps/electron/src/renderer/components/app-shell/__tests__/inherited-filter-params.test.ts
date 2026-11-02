import { describe, expect, it } from 'bun:test'
import { resolveInheritedFilterParams } from '../inherited-filter-params.ts'

describe('new session filter inheritance', () => {
  it('inherits a sole project include', () => {
    expect(resolveInheritedFilterParams(new Map([['p1', 'include']]))).toEqual({ project: 'p1' })
  })

  it('never inherits an exclude filter', () => {
    expect(resolveInheritedFilterParams(new Map([['p1', 'exclude']]))).toBeNull()
  })

  it('inherits the folder scope together with its project', () => {
    // Creating from a folder-scoped list must land inside that folder, and a
    // folder id is only meaningful next to the project that owns its tree.
    expect(resolveInheritedFilterParams(new Map(), { folderId: 'f1', projectId: 'p1' }))
      .toEqual({ project: 'p1', folder: 'f1' })
  })

  it('inherits a root-tree folder without a project', () => {
    expect(resolveInheritedFilterParams(new Map([['p1', 'exclude']]), { folderId: 'f1', projectId: null }))
      .toEqual({ folder: 'f1' })
  })

  it('falls back to the sole project include when the folder has no project', () => {
    expect(resolveInheritedFilterParams(new Map([['p1', 'include']]), { folderId: 'f1' }))
      .toEqual({ project: 'p1', folder: 'f1' })
  })
})
