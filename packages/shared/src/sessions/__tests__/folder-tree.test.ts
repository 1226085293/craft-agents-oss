import { describe, expect, it } from 'bun:test'
import {
  appendSortOrder,
  buildOrderedChildren,
  canDrop,
  compareSiblings,
  getFolderAncestors,
  getFolderDepth,
  getFolderPath,
  midpointSortOrder,
  resolveDeepestExistingAncestor,
  validateFolderMove,
} from '../folder-tree.ts'
import type { FolderConfig } from '../folders.ts'

function folder(id: string, parentId: string | null, extra: Partial<FolderConfig> = {}): FolderConfig {
  return { id, name: id, parentId, createdAt: 0, updatedAt: 0, ...extra }
}

/** 工程 / Craft / UI, plus a sibling "Docs" at root. */
function tree(): FolderConfig[] {
  return [
    folder('engineering', null, { name: '工程' }),
    folder('craft', 'engineering', { name: 'Craft' }),
    folder('ui', 'craft', { name: 'UI' }),
    folder('docs', null, { name: 'Docs' }),
  ]
}

describe('folder tree navigation', () => {
  it('walks ancestors from parent up to root', () => {
    expect(getFolderAncestors(tree(), 'ui').map((f) => f.id)).toEqual(['craft', 'engineering'])
    expect(getFolderAncestors(tree(), 'engineering')).toEqual([])
  })

  it('builds a readable path including the folder itself', () => {
    expect(getFolderPath(tree(), 'ui')).toEqual(['工程', 'Craft', 'UI'])
    expect(getFolderPath(tree(), null)).toEqual([])
  })

  it('computes depth with root level = 1', () => {
    expect(getFolderDepth(tree(), 'engineering')).toBe(1)
    expect(getFolderDepth(tree(), 'ui')).toBe(3)
  })

  it('stops walking when data contains a parent cycle', () => {
    const cyclic = [folder('a', 'b'), folder('b', 'a')]
    expect(getFolderAncestors(cyclic, 'a').length).toBeLessThanOrEqual(2)
  })
})

describe('validateFolderMove', () => {
  it('rejects moving a folder into its own descendant', () => {
    const result = validateFolderMove(tree(), 'engineering', 'ui')
    expect(result).toEqual({ ok: false, reason: 'cycle' })
  })

  it('rejects moving a folder into itself', () => {
    expect(validateFolderMove(tree(), 'craft', 'craft')).toEqual({ ok: false, reason: 'cycle' })
  })

  it('reports a no-op when the parent does not change', () => {
    expect(validateFolderMove(tree(), 'craft', 'engineering')).toEqual({ ok: true, noop: true })
  })

  it('rejects a move that would exceed 5 levels', () => {
    const deep = [
      folder('a', null),
      folder('b', 'a'),
      folder('c', 'b'),
      folder('d', 'c'),
      folder('e', 'd'), // depth 5
      folder('x', null),
    ]
    // a/b/c/d/e has height 5; moving it under x would make it 6.
    expect(validateFolderMove(deep, 'a', 'x')).toEqual({ ok: false, reason: 'depth' })
  })

  it('allows moving into root', () => {
    expect(validateFolderMove(tree(), 'ui', null)).toEqual({ ok: true, noop: false })
  })

  it('rejects an archived target', () => {
    const withArchived = [...tree(), folder('arch', null, { archivedAt: 1 })]
    expect(validateFolderMove(withArchived, 'ui', 'arch')).toEqual({ ok: false, reason: 'target-archived' })
  })
})

describe('resolveDeepestExistingAncestor', () => {
  it('resolves the deepest matching path', () => {
    expect(resolveDeepestExistingAncestor(tree(), ['工程', 'Craft'])).toBe('craft')
  })

  it('falls back to the deepest existing prefix', () => {
    expect(resolveDeepestExistingAncestor(tree(), ['工程', 'Missing', 'UI'])).toBe('engineering')
  })

  it('returns null when nothing matches', () => {
    expect(resolveDeepestExistingAncestor(tree(), ['Nope'])).toBeNull()
  })
})

describe('fractional ordering', () => {
  it('produces a key strictly between two neighbours', () => {
    const mid = midpointSortOrder('A', 'B')
    expect(mid > 'A').toBe(true)
    expect(mid < 'B').toBe(true)
  })

  it('supports repeated insertions at the same slot without collisions', () => {
    let lo = 'A'
    const hi = 'B'
    const seen = new Set<string>()
    for (let i = 0; i < 20; i++) {
      const mid = midpointSortOrder(lo, hi)
      expect(mid > lo).toBe(true)
      expect(mid < hi).toBe(true)
      expect(seen.has(mid)).toBe(false)
      seen.add(mid)
      lo = mid
    }
  })

  it('appends after the largest existing key', () => {
    const next = appendSortOrder([{ sortOrder: 'A' }, { sortOrder: 'C' }])
    expect(next > 'C').toBe(true)
  })

  it('starts somewhere in the middle when the group is empty', () => {
    expect(midpointSortOrder()).toBe('V')
  })
})

describe('compareSiblings', () => {
  it('sorts pinned items before unpinned ones, most recent pin first', () => {
    const siblings = [
      { id: 'a', sortOrder: 'A' },
      { id: 'b', sortOrder: 'B', pinnedAt: 10 },
      { id: 'c', sortOrder: 'C', pinnedAt: 20 },
    ]
    const ordered = [...siblings].sort((x, y) => compareSiblings(x, y, 'session')).map((s) => s.id)
    expect(ordered).toEqual(['c', 'b', 'a'])
  })

  it('falls back to lastMessageAt for sessions without sortOrder', () => {
    const siblings = [
      { id: 'old', lastMessageAt: 100 },
      { id: 'new', lastMessageAt: 200 },
    ]
    const ordered = [...siblings].sort((x, y) => compareSiblings(x, y, 'session')).map((s) => s.id)
    expect(ordered).toEqual(['new', 'old'])
  })
})

describe('buildOrderedChildren', () => {
  it('always keeps folders above sessions regardless of sortOrder', () => {
    const folders = [{ id: 'f1', name: 'Zeta', sortOrder: 'zzz' }]
    const sessions = [{ id: 's1', sortOrder: 'aaa', lastMessageAt: 1 }]
    const ordered = buildOrderedChildren(folders, sessions)
    expect(ordered.folders.map((f) => f.id)).toEqual(['f1'])
    expect(ordered.sessions.map((s) => s.id)).toEqual(['s1'])
  })
})

describe('canDrop', () => {
  it('rejects dragging a parent into its own descendant', () => {
    const decision = canDrop(
      { kind: 'folder', id: 'engineering', parentId: null },
      { kind: 'folder', id: 'ui' },
      tree(),
    )
    expect(decision).toEqual({ ok: false, reason: 'cycle' })
  })

  it('archives when dropping onto the archive node', () => {
    const decision = canDrop(
      { kind: 'session', id: 's1', folderId: 'craft' },
      { kind: 'archive' },
      tree(),
    )
    expect(decision).toEqual({ ok: true, action: 'archive', toFolderId: null, changesArchive: true })
  })

  it('moves a session into a folder', () => {
    const decision = canDrop(
      { kind: 'session', id: 's1', folderId: null },
      { kind: 'folder', id: 'craft' },
      tree(),
    )
    expect(decision).toMatchObject({ ok: true, action: 'move', toFolderId: 'craft', changesArchive: false })
  })

  it('unarchives when dragging out of the archive tree', () => {
    const decision = canDrop(
      { kind: 'session', id: 's1', folderId: null, archived: true },
      { kind: 'folder', id: 'craft' },
      tree(),
    )
    expect(decision).toMatchObject({ ok: true, action: 'unarchive', toFolderId: 'craft', changesArchive: true })
  })
})
