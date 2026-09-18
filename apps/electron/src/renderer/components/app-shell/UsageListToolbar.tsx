import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Search, X, ArrowUpDown, Check } from 'lucide-react'
import { StyledDropdownMenuContent, StyledDropdownMenuItem, DropdownMenuTrigger, DropdownMenu } from '@craft-agent/ui'
import { cn } from '@/lib/utils'

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
}

const SORT_OPTIONS: Array<{ key: UsageSortKey; labelKey: string }> = [
  { key: 'name', labelKey: 'usage.sortByName' },
  { key: 'count', labelKey: 'usage.sortByCount' },
  { key: 'lastUsed', labelKey: 'usage.sortByLastUsed' },
]

export function UsageListToolbar({
  searchQuery,
  onSearchChange,
  sortKey,
  onSortChange,
  searchPlaceholder,
}: UsageListToolbarProps) {
  const { t } = useTranslation()
  const currentLabel = t(SORT_OPTIONS.find(o => o.key === sortKey)?.labelKey ?? 'usage.sortByName')

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

      {/* Sort dropdown — StyledDropdownMenu for consistent dark/light theming */}
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            'shrink-0 h-8 px-2 flex items-center gap-1.5 text-xs rounded-[8px] shadow-minimal',
            'bg-muted/50 hover:bg-foreground/[0.03] transition-colors outline-none',
            'data-[state=open]:bg-foreground/[0.03]',
          )}
          title={t('table.sortBy')}
        >
          <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="max-w-28 truncate">{currentLabel}</span>
        </DropdownMenuTrigger>
        <StyledDropdownMenuContent align="end" minWidth="min-w-40">
          {SORT_OPTIONS.map(option => (
            <StyledDropdownMenuItem
              key={option.key}
              onSelect={() => onSortChange(option.key)}
              className="justify-between"
            >
              <span>{t(option.labelKey)}</span>
              {sortKey === option.key && <Check className="h-3.5 w-3.5 text-accent" />}
            </StyledDropdownMenuItem>
          ))}
        </StyledDropdownMenuContent>
      </DropdownMenu>
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
