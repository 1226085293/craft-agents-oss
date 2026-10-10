import { describe, it, expect } from 'bun:test'
import { computeCollapsedPagination } from '../useSessionSearch'
import type { SessionMeta } from '@/atoms/sessions'

function makeSession(id: string, opts: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    workspaceId: 'ws-1',
    sessionStatus: 'in-progress',
    lastMessageAt: Date.parse('2026-03-05T10:00:00.000Z'),
    ...opts,
  }
}

describe('computeCollapsedPagination', () => {
  it('does not hide items when current view has only one group and that group is collapsed', () => {
    const sessions = [
      makeSession('s1'),
      makeSession('s2'),
    ]

    const result = computeCollapsedPagination(
      sessions,
      50,
      new Set(['2026-03-05T00:00:00.000Z']),
      'date'
    )

    expect(result.paginatedItems.map(s => s.id)).toEqual(['s1', 's2'])
    expect(result.collapsedGroupsMeta).toEqual([])
    expect(result.hasMore).toBe(false)
  })

  it('still collapses normally when multiple groups exist', () => {
    const sessions = [
      makeSession('today', { lastMessageAt: Date.parse('2026-03-06T10:00:00.000Z') }),
      makeSession('yesterday', { lastMessageAt: Date.parse('2026-03-05T10:00:00.000Z') }),
      makeSession('older', { lastMessageAt: Date.parse('2026-03-04T10:00:00.000Z') }),
    ]

    const result = computeCollapsedPagination(
      sessions,
      50,
      new Set(['2026-03-05T00:00:00.000Z']),
      'date'
    )

    expect(result.paginatedItems.map(s => s.id)).toEqual(['today', 'older'])
    expect(result.collapsedGroupsMeta).toEqual([{ key: '2026-03-05T00:00:00.000Z', count: 1 }])
    expect(result.hasMore).toBe(false)
  })

  it('ignores collapsed keys that are not present in current view', () => {
    const sessions = [
      makeSession('a', { sessionStatus: 'in-progress' }),
      makeSession('b', { sessionStatus: 'done' }),
    ]

    const result = computeCollapsedPagination(
      sessions,
      50,
      new Set(['status-todo']),
      'status'
    )

    expect(result.paginatedItems.map(s => s.id)).toEqual(['a', 'b'])
    expect(result.collapsedGroupsMeta).toEqual([])
  })

  it('keeps unread sessions visible even when they sit beyond the display limit', () => {
    // 85 read sessions + 1 unread one sorted last by lastMessageAt (oldest).
    const sessions: SessionMeta[] = []
    for (let i = 0; i < 85; i++) {
      sessions.push(makeSession(`read-${i}`, { lastMessageAt: Date.parse('2026-03-06T10:00:00.000Z') - i }))
    }
    sessions.push(makeSession('unread-old', { hasUnread: true, lastMessageAt: Date.parse('2026-03-01T10:00:00.000Z') }))

    const result = computeCollapsedPagination(sessions, 50, undefined, 'unread')

    expect(result.paginatedItems.map(s => s.id)).toContain('unread-old')
    expect(result.collapsedGroupsMeta).toEqual([])
    expect(result.hasMore).toBe(true)
  })

  it('does not truncate unread items regardless of how small the display limit is', () => {
    const sessions = [
      makeSession('u1', { hasUnread: true }),
      makeSession('u2', { hasUnread: true }),
      makeSession('u3', { hasUnread: true }),
      ...Array.from({ length: 10 }, (_, i) => makeSession(`read-${i}`)),
    ]

    const result = computeCollapsedPagination(sessions, 2, undefined, 'unread')

    const unreadIds = result.paginatedItems.filter(s => s.hasUnread).map(s => s.id)
    expect(unreadIds).toEqual(['u1', 'u2', 'u3'])
    expect(result.hasMore).toBe(true)
  })

  it('collapses the unread bucket and reports its full count via meta', () => {
    const sessions = [
      makeSession('u1', { hasUnread: true }),
      makeSession('u2', { hasUnread: true }),
      makeSession('r1'),
    ]

    const result = computeCollapsedPagination(
      sessions,
      50,
      new Set(['unread-yes']),
      'unread'
    )

    expect(result.paginatedItems.map(s => s.id)).toEqual(['r1'])
    expect(result.collapsedGroupsMeta).toEqual([{ key: 'unread-yes', count: 2 }])
    expect(result.hasMore).toBe(false)
  })

  it('does not collapse a single-bucket unread view', () => {
    const sessions = [
      makeSession('u1', { hasUnread: true }),
      makeSession('u2', { hasUnread: true }),
    ]

    const result = computeCollapsedPagination(
      sessions,
      50,
      new Set(['unread-yes']),
      'unread'
    )

    expect(result.paginatedItems.map(s => s.id)).toEqual(['u1', 'u2'])
    expect(result.collapsedGroupsMeta).toEqual([])
  })
})
