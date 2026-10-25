import { describe, it, expect } from 'bun:test'
import type { TFunction } from 'i18next'
import type { SessionMeta } from '@/atoms/sessions'
import type { SessionStatus } from '@/config/session-status-config'
import { groupSearchSessionRows, groupSessionRows } from '../session-list-grouping'

function makeSession(id: string, opts: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    workspaceId: 'ws-1',
    ...opts,
  }
}

const t = ((key: string, second?: unknown) => {
  if (key.startsWith('status.')) {
    return typeof second === 'string' ? second : key
  }
  if (key === 'session.unreadGroup' || key === 'session.readGroup') {
    const count = (second as { count?: number } | undefined)?.count ?? 0
    return `${key === 'session.unreadGroup' ? 'Unread' : 'Read'} (${count})`
  }
  if (key === 'common.today') return 'Today'
  if (key === 'common.yesterday') return 'Yesterday'
  if (key === 'sidebar.noProject' || key === 'sidebar.unknownProject') {
    return (second as { defaultValue?: string } | undefined)?.defaultValue ?? key
  }
  return key
}) as unknown as TFunction

function status(id: string, label: string): SessionStatus {
  return { id, label } as SessionStatus
}

describe('groupSessionRows', () => {
  it('groups by date descending and keeps input order within a day', () => {
    const rows = [
      { item: makeSession('newer', { lastMessageAt: Date.parse('2026-01-06T10:00:00Z') }) },
      { item: makeSession('same-day', { lastMessageAt: Date.parse('2026-01-06T08:00:00Z') }) },
      { item: makeSession('older', { lastMessageAt: Date.parse('2026-01-05T10:00:00Z') }) },
    ]

    const result = groupSessionRows(rows, {
      groupingMode: 'date',
      t,
      language: 'en',
    })

    expect(result.groups.map(g => g.key)).toEqual([
      '2026-01-06T00:00:00.000Z',
      '2026-01-05T00:00:00.000Z',
    ])
    expect(result.groups.map(g => g.label)).toEqual(['Jan 6', 'Jan 5'])
    expect(result.groups[0].items.map(r => r.item.id)).toEqual(['newer', 'same-day'])
    expect(result.rows.map(r => r.item.id)).toEqual(['newer', 'same-day', 'older'])
  })

  it('groups by status in configured order', () => {
    const rows = [
      { item: makeSession('done-1', { sessionStatus: 'done', lastMessageAt: 1 }) },
      { item: makeSession('todo-1', { sessionStatus: 'todo', lastMessageAt: 2 }) },
      { item: makeSession('todo-2', { sessionStatus: 'todo', lastMessageAt: 3 }) },
    ]

    const result = groupSessionRows(rows, {
      groupingMode: 'status',
      sessionStatuses: [status('todo', 'Todo'), status('done', 'Done')],
      t,
      language: 'en',
    })

    expect(result.groups.map(g => g.label)).toEqual(['Todo', 'Done'])
    expect(result.groups[0].items.map(r => r.item.id)).toEqual(['todo-2', 'todo-1'])
    expect(result.rows.map(r => r.item.id)).toEqual(['todo-2', 'todo-1', 'done-1'])
  })

  it('groups by unread state with both buckets present', () => {
    const rows = [
      { item: makeSession('read-1', { hasUnread: false, lastMessageAt: 2 }) },
      { item: makeSession('unread-1', { hasUnread: true, lastMessageAt: 1 }) },
    ]

    const result = groupSessionRows(rows, {
      groupingMode: 'unread',
      t,
      language: 'en',
    })

    expect(result.groups.map(g => g.label)).toEqual(['Unread (1)', 'Read (1)'])
    expect(result.rows.map(r => r.item.id)).toEqual(['unread-1', 'read-1'])
  })

  it('groups by project and sinks unbound sessions into a no-project bucket', () => {
    const rows = [
      { item: makeSession('unbound', { lastMessageAt: 3 }) },
      { item: makeSession('alpha', { projectId: 'p1', lastMessageAt: 1 }) },
      { item: makeSession('beta', { projectId: 'p2', lastMessageAt: 2 }) },
    ]

    const result = groupSessionRows(rows, {
      groupingMode: 'project',
      projects: [
        { id: 'p1', name: 'Alpha' },
        { id: 'p2', name: 'Beta' },
      ],
      t,
      language: 'en',
    })

    expect(result.groups.map(g => g.label)).toEqual(['Alpha', 'Beta', 'No project'])
    expect(result.rows.map(r => r.item.id)).toEqual(['alpha', 'beta', 'unbound'])
  })

  it('applies a key prefix and disables collapsing for search results', () => {
    const rows = [
      { item: makeSession('a', { lastMessageAt: Date.parse('2026-01-06T10:00:00Z') }) },
    ]

    const result = groupSessionRows(rows, {
      groupingMode: 'date',
      collapsible: false,
      keyPrefix: 'search-matching-',
      t,
      language: 'en',
    })

    expect(result.groups[0].key).toBe('search-matching-2026-01-06T00:00:00.000Z')
    expect(result.groups[0].collapsible).toBe(false)
  })

  it('groups search results by date without a divider when nothing is outside the view', () => {
    const rows = [
      { item: makeSession('a', { lastMessageAt: Date.parse('2026-01-06T10:00:00Z') }) },
      { item: makeSession('b', { lastMessageAt: Date.parse('2026-01-05T10:00:00Z') }) },
    ]

    const result = groupSearchSessionRows(rows, [], {
      groupingMode: 'date',
      t,
      language: 'en',
    })

    expect(result.groups.map(g => g.label)).toEqual(['Jan 6', 'Jan 5'])
    expect(result.groups.every(g => !g.collapsible)).toBe(true)
  })

  it('keeps in-view and other-conversation sections separated around grouping headers', () => {
    const matching = [
      { item: makeSession('m1', { lastMessageAt: Date.parse('2026-01-06T10:00:00Z') }) },
    ]
    const other = [
      { item: makeSession('o1', { lastMessageAt: Date.parse('2026-01-06T09:00:00Z') }) },
      { item: makeSession('o2', { lastMessageAt: Date.parse('2026-01-04T09:00:00Z') }) },
    ]

    const result = groupSearchSessionRows(matching, other, {
      groupingMode: 'date',
      t,
      language: 'en',
    })

    expect(result.groups.map(g => g.key)).toEqual([
      'search-matching-divider',
      'search-matching-2026-01-06T00:00:00.000Z',
      'search-other-divider',
      'search-other-2026-01-06T00:00:00.000Z',
      'search-other-2026-01-04T00:00:00.000Z',
    ])
    expect(result.rows.map(r => r.item.id)).toEqual(['m1', 'o1', 'o2'])
  })

  it('omits the in-view divider when only other conversations match', () => {
    const other = [
      { item: makeSession('o1', { lastMessageAt: Date.parse('2026-01-06T09:00:00Z') }) },
    ]

    const result = groupSearchSessionRows([], other, {
      groupingMode: 'status',
      sessionStatuses: [status('todo', 'Todo')],
      t,
      language: 'en',
    })

    expect(result.groups.map(g => g.key)).toEqual([
      'search-other-divider',
      'search-other-status-todo',
    ])
    expect(result.groups[1].label).toBe('Todo')
  })

  it('inserts header-only groups for collapsed groups outside the visible page', () => {
    const rows = [
      { item: makeSession('visible', { lastMessageAt: Date.parse('2026-01-06T10:00:00Z') }) },
    ]

    const result = groupSessionRows(rows, {
      groupingMode: 'date',
      collapsedGroupsMeta: [{ key: '2026-01-04T00:00:00.000Z', count: 4 }],
      t,
      language: 'en',
    })

    expect(result.groups.map(g => g.key)).toEqual([
      '2026-01-06T00:00:00.000Z',
      '2026-01-04T00:00:00.000Z',
    ])
    expect(result.groups[1].items).toEqual([])
    expect(result.groups[1].collapsedCount).toBe(4)
  })
})
