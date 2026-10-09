import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, DatabaseZap } from 'lucide-react'
import { FilterableSelectPopover } from '@craft-agent/ui'

import { cn } from '@/lib/utils'
import { SourceAvatar } from '@/components/ui/source-avatar'
import type { LoadedSource } from '../../../shared/types'

export interface SourceSelectorPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  anchorRef: React.RefObject<HTMLButtonElement | null>
  sources: LoadedSource[]
  selectedSlugs: string[]
  sourceScope?: 'auto' | 'only' | 'exclude'
  onScopeChange?: (scope: 'auto' | 'only' | 'exclude') => void
  onToggleSlug: (slug: string) => void
}

export function SourceSelectorPopover({
  open,
  onOpenChange,
  anchorRef,
  sources,
  selectedSlugs,
  sourceScope = 'auto',
  onScopeChange,
  onToggleSlug,
}: SourceSelectorPopoverProps) {
  const { t } = useTranslation()
  return (
    <FilterableSelectPopover
      open={open}
      onOpenChange={onOpenChange}
      anchorRef={anchorRef}
      items={sources}
      getKey={(source) => source.config.slug}
      getLabel={(source) => source.config.name}
      isSelected={(source) => selectedSlugs.includes(source.config.slug)}
      onToggle={(source) => onToggleSlug(source.config.slug)}
      filterPlaceholder={t('common.search')}
      emptyState={t('sourcesList.noSourcesConfigured')}
      noResultsState={t('chat.noResults')}
      minWidth={220}
      maxWidth={340}
      header={(
        <div className="border-b border-border/50 px-3 py-2">
          <div className="flex items-center gap-1">
            {(['auto', 'only', 'exclude'] as const).map(mode => (
              <button
                key={mode}
                type="button"
                onClick={() => onScopeChange?.(mode)}
                className={cn(
                  'rounded-[6px] px-2 py-1 text-[11px] font-medium transition-colors',
                  sourceScope === mode
                    ? 'bg-foreground/10 text-foreground'
                    : 'text-muted-foreground hover:bg-foreground/5',
                )}
              >
                {mode === 'auto' ? t('chat.sourceScopeAuto') : mode === 'only' ? t('chat.sourceScopeOnly') : t('chat.sourceScopeExclude')}
              </button>
            ))}
          </div>
          {sourceScope === 'auto' && (
            <div className="mt-1 text-[10px] leading-tight text-muted-foreground">
              {t('chat.sourceScopeAutoHint')}
            </div>
          )}
        </div>
      )}
      isDisabled={(source) => !source.config.enabled}
      renderItem={(source, state, index) => (
        <div
          data-tutorial={index === 0 ? 'source-dropdown-item-first' : undefined}
          className={cn(
            'flex cursor-pointer select-none items-center gap-3 rounded-[6px] px-3 py-2 text-[13px]',
            state.highlighted && 'bg-foreground/5',
            state.selected && 'bg-foreground/3',
          )}
        >
          <div className="shrink-0 text-muted-foreground flex items-center">
            {source.config.slug
              ? <SourceAvatar source={source} size="sm" />
              : <DatabaseZap className="h-4 w-4" />}
          </div>
          <div className="flex-1 min-w-0 truncate">
            {source.config.name}
            {state.disabled && (
              <span className="ml-1.5 text-[10px] text-muted-foreground">{t('chat.sourceUnauthorizedHint')}</span>
            )}
          </div>
          <div
            className={cn(
              'shrink-0 h-4 w-4 rounded-full bg-current flex items-center justify-center',
              !state.selected && 'opacity-0',
            )}
          >
            <Check className="h-2.5 w-2.5 text-white dark:text-black" strokeWidth={3} />
          </div>
        </div>
      )}
    />
  )
}
