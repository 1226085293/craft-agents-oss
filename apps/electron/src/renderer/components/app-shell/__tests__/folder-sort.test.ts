import { describe, it, expect } from 'bun:test'
import type { FolderTreeNode } from '@craft-agent/shared/sessions/folder-tree'
import { compareFolders, orderSessions, sortFolderNodes } from '../folder-sort'

function node(id: string, name: string, pinnedAt?: number): FolderTreeNode {
  return {
    folder: { id, name, parentId: null, pinnedAt } as FolderTreeNode['folder'],
    children: [],
  }
}

const none = new Set<string>()

describe('orderSessions', () => {
  const base = { lastMessageAt: 100 }

  it('puts unread sessions above read ones', () => {
    const ordered = orderSessions([
      { id: 'read-new', ...base, lastMessageAt: 300 },
      { id: 'unread-old', ...base, lastMessageAt: 100, hasUnread: true },
    ])
    expect(ordered.map((s) => s.id)).toEqual(['unread-old', 'read-new'])
  })

  it('keeps pinned above unread — pinning has priority', () => {
    const ordered = orderSessions([
      { id: 'unread', ...base, lastMessageAt: 300, hasUnread: true },
      { id: 'pinned', ...base, lastMessageAt: 100, pinnedAt: 10 },
    ])
    expect(ordered.map((s) => s.id)).toEqual(['pinned', 'unread'])
  })

  it('orders by recency when nothing is pinned or unread', () => {
    const ordered = orderSessions([
      { id: 'old', ...base, lastMessageAt: 100 },
      { id: 'new', ...base, lastMessageAt: 200 },
    ])
    expect(ordered.map((s) => s.id)).toEqual(['new', 'old'])
  })

  it('does not mutate the input array', () => {
    const input = [
      { id: 'a', ...base, lastMessageAt: 100 },
      { id: 'b', ...base, lastMessageAt: 200 },
    ]
    orderSessions(input)
    expect(input.map((s) => s.id)).toEqual(['a', 'b'])
  })
})

describe('sortFolderNodes', () => {
  it('puts a folder with unread sessions above read siblings', () => {
    const nodes = [node('aaa', 'AAA'), node('zzz', 'ZZZ')]
    const ordered = sortFolderNodes(nodes, new Set(['zzz']))
    expect(ordered.map((n) => n.folder.id)).toEqual(['zzz', 'aaa'])
  })

  it('keeps pinned folders above unread ones', () => {
    const nodes = [node('unread', 'AAA'), node('pinned', 'ZZZ', 42)]
    const ordered = sortFolderNodes(nodes, new Set(['unread']))
    expect(ordered.map((n) => n.folder.id)).toEqual(['pinned', 'unread'])
  })

  it('falls back to name order when nothing is pinned or unread', () => {
    const nodes = [node('b', 'Bravo'), node('a', 'Alpha')]
    expect(sortFolderNodes(nodes, none).map((n) => n.folder.name)).toEqual(['Alpha', 'Bravo'])
  })
})

describe('compareFolders', () => {
  it('orders the flat list the same way', () => {
    const list = [
      { id: 'x', name: 'Xray' },
      { id: 'y', name: 'Yankee', pinnedAt: 5 },
      { id: 'a', name: 'Alpha' },
    ]
    const ordered = [...list].sort((a, b) => compareFolders(a, b, new Set(['a'])))
    expect(ordered.map((f) => f.id)).toEqual(['y', 'a', 'x'])
  })
})
