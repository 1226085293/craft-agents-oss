import type { FocusZoneId } from '@/context/FocusContext'

export type KeyboardSearchTarget = 'chat' | 'sessions'

export function resolveKeyboardSearchTarget(zone: FocusZoneId | null, hasChatTarget = true): KeyboardSearchTarget {
  return zone === 'chat' && hasChatTarget ? 'chat' : 'sessions'
}

export function getInChatSearchQuery(isSearchResultList: boolean, query: string): string | null {
  return isSearchResultList && query.trim().length > 0 ? query : null
}
