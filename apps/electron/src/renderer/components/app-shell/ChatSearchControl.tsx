import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'

export interface ChatSearchControlProps {
  query: string
  matchCount: number
  currentMatchIndex: number
  onQueryChange: (query: string) => void
  onPrevious: () => void
  onNext: () => void
  onClose: () => void
}

export function ChatSearchControl({
  query,
  matchCount,
  currentMatchIndex,
  onQueryChange,
  onPrevious,
  onNext,
  onClose,
}: ChatSearchControlProps): React.ReactElement {
  const { t } = useTranslation()
  const inputRef = React.useRef<HTMLInputElement>(null)
  const hasMatches = matchCount > 0

  React.useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  return (
    <div
      data-focus-zone="chat"
      className="titlebar-no-drag flex h-7 w-[min(100%,19rem)] items-center gap-1 rounded-[7px] border border-foreground/10 bg-background px-1 shadow-minimal"
    >
      <Search aria-hidden="true" className="ml-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          }
          event.stopPropagation()
        }}
        aria-label={t('session.search')}
        placeholder={t('chat.searchInConversationPlaceholder')}
        className="h-full min-w-0 flex-1 bg-transparent px-1 text-[13px] outline-none placeholder:text-muted-foreground"
      />
      <span aria-live="polite" className="min-w-[2.4rem] text-center text-[11px] tabular-nums text-muted-foreground">
        {hasMatches ? `${Math.min(currentMatchIndex + 1, matchCount)}/${matchCount}` : query.trim().length > 0 ? '0/0' : ''}
      </span>
      <button
        type="button"
        aria-label={t('shortcuts.action.prevSearchMatch')}
        title={t('shortcuts.action.prevSearchMatch')}
        disabled={!hasMatches || currentMatchIndex <= 0}
        onClick={onPrevious}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:cursor-default disabled:opacity-35"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label={t('shortcuts.action.nextSearchMatch')}
        title={t('shortcuts.action.nextSearchMatch')}
        disabled={!hasMatches || currentMatchIndex >= matchCount - 1}
        onClick={onNext}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:cursor-default disabled:opacity-35"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label={t('common.close')}
        title={t('common.close')}
        onClick={onClose}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
