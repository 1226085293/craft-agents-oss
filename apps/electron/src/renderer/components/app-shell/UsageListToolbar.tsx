import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Search, X, ArrowUpDown } from 'lucide-react'

/**
 * UsageListToolbar — Search + sort controls for source/skill lists.
 *
 * Rendered above the list. Sort options are stable: name (ascending),
 * use count (descending), last-used (descending, never-used at the bottom).
 */

export type UsageSortKey = 'name' | 'count' | 'lastUsed'

export interface UsageListToolbarProps {
  searchQuery: string
  onSearchChange: (query: string) => void
  sortKey: UsageSortKey
  onSortChange: (key: UsageSortKey) => void
  searchPlaceholder?: string
  resultCount?: number
}

export function UsageListToolbar({
  searchQuery,
  onSearchChange,
  sortKey,
  onSortChange,
  searchPlaceholder,
  resultCount,
}: UsageListToolbarProps) {
  const { t } = useTranslation()

  return (
    <div className="shrink-0 px-2 pt-2 pb-1.5 border-b border-border/50 flex items-center gap-1.5">
      {/* Search input */}
      <div className="relative flex-1 rounded-[8px] shadow-minimal bg-muted/50 has-[:focus-visible]:bg-background">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={searchPlaceholder ?? t('common.search')}
          className="w-full h-8 pl-8 pr-8 text-sm bg-transparent border-0 rounded-[8px] outline-none focus-visible:ring-0 focus-visible:outline-none placeholder:text-muted-foreground/50"
        />
        {searchQuery && (
          <button
            onClick={() => onSearchChange('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 hover:bg-foreground/10 rounded"
            title={t('usage.clearSearch')}
          >
            <X className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        )}
      </div>

      {/* Sort dropdown */}
      <div className="relative shrink-0">
        <ArrowUpDown className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        <select
          value={sortKey}
          onChange={(e) => onSortChange(e.target.value as UsageSortKey)}
          title={t('table.sortBy')}
          className="h-8 pl-7 pr-2 text-xs bg-muted/50 border-0 rounded-[8px] shadow-minimal outline-none focus-visible:ring-0 appearance-none cursor-pointer"
        >
          <option value="name">{t('usage.sortByName')}</option>
          <option value="count">{t('usage.sortByCount')}</option>
          <option value="lastUsed">{t('usage.sortByLastUsed')}</option>
        </select>
      </div>
    </div>
  )
}

/**
 * Format a compact relative time string for the trailing "last used" slot.
 * Falls back gracefully when the timestamp is 0/absent.
 */
export function formatUsageRelativeTime(timestamp?: number): string | null {
  if (!timestamp) return null
  const diff = Date.now() - timestamp
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (seconds < 60) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  return `${days}d ago`
}
