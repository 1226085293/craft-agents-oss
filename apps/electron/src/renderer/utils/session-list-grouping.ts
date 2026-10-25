import { isToday, isYesterday, format, startOfDay } from 'date-fns'
import type { TFunction } from 'i18next'
import { getDateLocale } from '@craft-agent/shared/i18n'
import type { EntityListGroup } from '@/components/ui/entity-list'
import type { SessionMeta } from '@/atoms/sessions'
import type { SessionStatus } from '@/config/session-status-config'
import type { CollapsedGroupMeta } from '@/hooks/useSessionSearch'
import { getSessionStatus } from '@/utils/session'

/** Grouping mode for the session list */
export type ChatGroupingMode = 'date' | 'status' | 'unread' | 'project'

/** Minimal shape the grouping helper needs from a rendered row */
export interface GroupableSessionRow {
  item: SessionMeta
}

export interface GroupSessionRowsOptions {
  groupingMode: ChatGroupingMode
  sessionStatuses?: SessionStatus[]
  projects?: Array<{ id: string; name: string }>
  /** Metadata for collapsed groups (key + item count) — non-search list only */
  collapsedGroupsMeta?: CollapsedGroupMeta[]
  /** Whether group headers support collapse/expand (default: true) */
  collapsible?: boolean
  /** Prefix applied to group keys (lets search-mode groups avoid key collisions) */
  keyPrefix?: string
  t: TFunction
  language: string
}

// Note: uses date-fns format for non-today/yesterday dates; Today/Yesterday translated at render time
export function formatDateGroupLabel(date: Date, t: TFunction, lang: string): string {
  if (isToday(date)) return t('common.today')
  if (isYesterday(date)) return t('common.yesterday')
  return format(date, 'MMM d', { locale: getDateLocale(lang) })
}

/**
 * Group search results while keeping the in-view / other-conversations split.
 *
 * Search results honour the same grouping mode as the normal list; when both
 * buckets have results, section headers keep the two buckets distinguishable.
 */
export function groupSearchSessionRows<T extends GroupableSessionRow>(
  matchingRows: T[],
  otherRows: T[],
  options: GroupSessionRowsOptions,
): { rows: T[]; groups: EntityListGroup<T>[] } {
  const matching = matchingRows.length > 0
    ? groupSessionRows(matchingRows, {
        ...options,
        collapsible: false,
        keyPrefix: 'search-matching-',
      })
    : { rows: [] as T[], groups: [] as EntityListGroup<T>[] }

  if (otherRows.length === 0) return matching

  const other = groupSessionRows(otherRows, {
    ...options,
    collapsible: false,
    keyPrefix: 'search-other-',
  })

  const groups: EntityListGroup<T>[] = []
  if (matchingRows.length > 0) {
    groups.push({ key: 'search-matching-divider', label: options.t('session.inCurrentView'), items: [] })
  }
  groups.push(...matching.groups)
  groups.push({ key: 'search-other-divider', label: options.t('session.otherConversations'), items: [] })
  groups.push(...other.groups)

  return {
    rows: [...matching.rows, ...other.rows],
    groups,
  }
}

/**
 * Bucket session rows according to `groupingMode`.
 *
 * Shared by the normal list and search results so every grouping mode behaves
 * identically in both states. Returns rows in visual (group) order.
 */
export function groupSessionRows<T extends GroupableSessionRow>(
  rows: T[],
  {
    groupingMode,
    sessionStatuses = [],
    projects = [],
    collapsedGroupsMeta = [],
    collapsible = true,
    keyPrefix = '',
    t,
    language,
  }: GroupSessionRowsOptions,
): { rows: T[]; groups: EntityListGroup<T>[] } {
  const prefixKey = (key: string) => `${keyPrefix}${key}`

  if (groupingMode === 'unread') {
    // Two fixed buckets: unread on top, read below. Within each, items keep
    // the same `lastMessageAt`-descending order they already arrive in.
    // Both buckets always render — even when empty — so the user can see at
    // a glance which mode they're in. The header shows a count, so an empty
    // bucket is unambiguous (e.g. "Unread (0)").
    const unreadRows: T[] = []
    const readRows: T[] = []
    for (const row of rows) {
      if (row.item.hasUnread) unreadRows.push(row)
      else readRows.push(row)
    }
    unreadRows.sort((a, b) => (b.item.lastMessageAt || 0) - (a.item.lastMessageAt || 0))
    readRows.sort((a, b) => (b.item.lastMessageAt || 0) - (a.item.lastMessageAt || 0))

    const collapsedUnread = collapsedGroupsMeta.find(m => m.key === 'unread-yes')
    const collapsedRead = collapsedGroupsMeta.find(m => m.key === 'unread-no')

    // For collapsed groups prefer the persisted count (matches how the
    // date/status branches surface the size of a collapsed bucket).
    const unreadCount = collapsedUnread ? collapsedUnread.count : unreadRows.length
    const readCount = collapsedRead ? collapsedRead.count : readRows.length

    const orderedGroups: EntityListGroup<T>[] = [
      {
        key: prefixKey('unread-yes'),
        label: t('session.unreadGroup', { count: unreadCount }),
        items: unreadRows,
        // Empty groups have nothing to collapse into; suppress the caret.
        collapsible: collapsible && (unreadRows.length > 0 || !!collapsedUnread),
        ...(collapsedUnread ? { collapsedCount: collapsedUnread.count } : {}),
      },
      {
        key: prefixKey('unread-no'),
        label: t('session.readGroup', { count: readCount }),
        items: readRows,
        collapsible: collapsible && (readRows.length > 0 || !!collapsedRead),
        ...(collapsedRead ? { collapsedCount: collapsedRead.count } : {}),
      },
    ]

    return {
      rows: orderedGroups.flatMap(g => g.items),
      groups: orderedGroups,
    }
  }

  if (groupingMode === 'status') {
    const statusOrder = new Map<string, number>()
    sessionStatuses.forEach((state, index) => statusOrder.set(state.id, index))

    // Build groups from visible items
    const groupsByKey = new Map<string, { rows: T[]; statusId: string }>()
    for (const row of rows) {
      const statusId = getSessionStatus(row.item)
      const key = `status-${statusId}`
      if (!groupsByKey.has(key)) groupsByKey.set(key, { rows: [], statusId })
      groupsByKey.get(key)!.rows.push(row)
    }

    // Insert collapsed placeholder groups
    for (const meta of collapsedGroupsMeta) {
      if (!groupsByKey.has(meta.key)) {
        const statusId = meta.key.replace('status-', '')
        groupsByKey.set(meta.key, { rows: [], statusId })
      }
    }

    const orderedGroups: Array<{ key: string; group: EntityListGroup<T> }> = []
    for (const [key, { rows: groupRows, statusId }] of groupsByKey) {
      const state = sessionStatuses.find(s => s.id === statusId)
      if (!state) continue
      groupRows.sort((a, b) => (b.item.lastMessageAt || 0) - (a.item.lastMessageAt || 0))
      const collapsedMeta = collapsedGroupsMeta.find(m => m.key === key)
      orderedGroups.push({
        key,
        group: {
          key: prefixKey(key),
          label: t(`status.${state.id}`, state.label),
          items: groupRows,
          collapsible,
          ...(collapsedMeta ? { collapsedCount: collapsedMeta.count } : {}),
        },
      })
    }
    orderedGroups.sort((a, b) => {
      const aOrder = statusOrder.get(a.group.key.slice(keyPrefix.length).replace('status-', '')) ?? 999
      const bOrder = statusOrder.get(b.group.key.slice(keyPrefix.length).replace('status-', '')) ?? 999
      return aOrder - bOrder
    })

    // If only one group exists, disable collapsing — there's nothing to collapse into
    if (orderedGroups.length === 1) {
      orderedGroups[0].group.collapsible = false
    }

    const groups = orderedGroups.map(entry => entry.group)
    return {
      rows: groups.flatMap(g => g.items),
      groups,
    }
  }

  if (groupingMode === 'project') {
    // Build groups from visible items, bucketed by projectId.
    // Sessions without a projectId (or with an unknown projectId) go to the
    // "no-project" bucket so they're never silently dropped from the list.
    const projectOrder = new Map<string, number>()
    projects.forEach((p, index) => projectOrder.set(p.id, index))
    const projectNameById = new Map<string, string>()
    projects.forEach(p => projectNameById.set(p.id, p.name))

    const groupsByKey = new Map<string, { rows: T[]; projectId: string | null }>()
    for (const row of rows) {
      const rawProjectId = (row.item as { projectId?: string }).projectId
      const resolvedProjectId = rawProjectId && projectNameById.has(rawProjectId) ? rawProjectId : null
      const key = resolvedProjectId ? `project-${resolvedProjectId}` : 'project-__none__'
      if (!groupsByKey.has(key)) groupsByKey.set(key, { rows: [], projectId: resolvedProjectId })
      groupsByKey.get(key)!.rows.push(row)
    }

    // Insert collapsed placeholder groups (header-only, items: [])
    for (const meta of collapsedGroupsMeta) {
      if (!groupsByKey.has(meta.key)) {
        const idPart = meta.key.replace('project-', '')
        const projectId = idPart === '__none__' ? null : idPart
        groupsByKey.set(meta.key, { rows: [], projectId })
      }
    }

    const orderedGroups: Array<{ key: string; group: EntityListGroup<T> }> = []
    for (const [key, { rows: groupRows, projectId }] of groupsByKey) {
      groupRows.sort((a, b) => (b.item.lastMessageAt || 0) - (a.item.lastMessageAt || 0))
      const collapsedMeta = collapsedGroupsMeta.find(m => m.key === key)
      const label = projectId
        ? (projectNameById.get(projectId) ?? t('sidebar.unknownProject', { defaultValue: 'Unknown project' }))
        : t('sidebar.noProject', { defaultValue: 'No project' })
      orderedGroups.push({
        key,
        group: {
          key: prefixKey(key),
          label,
          items: groupRows,
          collapsible,
          ...(collapsedMeta ? { collapsedCount: collapsedMeta.count } : {}),
        },
      })
    }
    orderedGroups.sort((a, b) => {
      // No-project bucket sinks to the bottom, configured projects in registration order
      if (a.key === 'project-__none__') return 1
      if (b.key === 'project-__none__') return -1
      const aOrder = projectOrder.get(a.key.replace('project-', '')) ?? 999
      const bOrder = projectOrder.get(b.key.replace('project-', '')) ?? 999
      return aOrder - bOrder
    })

    if (orderedGroups.length === 1) {
      orderedGroups[0].group.collapsible = false
    }

    const groups = orderedGroups.map(entry => entry.group)
    return {
      rows: groups.flatMap(g => g.items),
      groups,
    }
  }

  // Default: group by date
  const groupsByKey = new Map<string, EntityListGroup<T>>()
  const groupDates = new Map<string, Date>()

  for (const row of rows) {
    const day = startOfDay(new Date(row.item.lastMessageAt || 0))
    const groupKey = day.toISOString()

    if (!groupsByKey.has(groupKey)) {
      groupsByKey.set(groupKey, {
        key: prefixKey(groupKey),
        label: formatDateGroupLabel(day, t, language),
        items: [],
        collapsible,
      })
      groupDates.set(groupKey, day)
    }
    groupsByKey.get(groupKey)!.items.push(row)
  }

  // Insert collapsed placeholder groups (header-only, items: [])
  for (const meta of collapsedGroupsMeta) {
    if (!groupsByKey.has(meta.key)) {
      const date = new Date(meta.key)
      groupsByKey.set(meta.key, {
        key: prefixKey(meta.key),
        label: formatDateGroupLabel(date, t, language),
        items: [],
        collapsible,
        collapsedCount: meta.count,
      })
      groupDates.set(meta.key, date)
    }
  }

  // Sort all groups by date descending
  const orderedKeys = Array.from(groupDates.entries())
    .sort(([, a], [, b]) => b.getTime() - a.getTime())
    .map(([key]) => key)

  const orderedGroups = orderedKeys.map(key => groupsByKey.get(key)!)

  // If only one group exists, disable collapsing — there's nothing to collapse into
  if (orderedGroups.length === 1) {
    orderedGroups[0].collapsible = false
  }

  return {
    rows: orderedGroups.flatMap(g => g.items),
    groups: orderedGroups,
  }
}
