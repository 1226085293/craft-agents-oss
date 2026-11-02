/**
 * HeaderSearchControl
 *
 * The search affordance that lives in the panel header's right edge. Collapsed
 * it is a plain icon button; opened it grows leftwards into a full-width input
 * that covers the header (inset on both sides so the panel keeps its margins).
 *
 * The growth is a width transition anchored to the right edge, which is what
 * makes it read as "unfolding to the left" rather than appearing in place.
 * An empty input collapses on blur; clearing text while focused keeps the
 * control open so the user can immediately enter a replacement query.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Search, X } from 'lucide-react'
import { setCurrentZone } from '@/actions/keybinding-context'

/** Expand / collapse durations, also used to time the unmount. */
const GROW_MS = 180
const SHIRINK_MS = 160

export interface HeaderSearchControlProps {
  active: boolean
  query: string
  onOpen: () => void
  onChange: (query: string) => void
  /** Dismiss AND drop the query (Escape / clear button). */
  onClose: () => void
  /**
   * Dismiss while keeping the drafted query in memory (blur while no search is
   * running). Falls back to `onClose` when not provided.
   */
  onCollapse?: () => void
}

/** A query only becomes a search once it has this many characters. */
const MIN_QUERY_LENGTH = 2

export function shouldCloseHeaderSearch(trigger: 'change' | 'blur', query: string): boolean {
  return trigger === 'blur' && query.length === 0
}

export function HeaderSearchControl({
  active,
  query,
  onOpen,
  onChange,
  onClose,
  onCollapse,
}: HeaderSearchControlProps): React.ReactElement {
  const { t } = useTranslation()
  const inputRef = React.useRef<HTMLInputElement>(null)

  // Three explicit states instead of booleans: mounting collapsed and growing on
  // the next tick is what makes the width transition visible.
  const [phase, setPhase] = React.useState<'hidden' | 'collapsed' | 'open'>('hidden')

  React.useEffect(() => {
    if (active) {
      setPhase('open')
      return
    }
    setPhase('collapsed')
    const hide = window.setTimeout(() => setPhase('hidden'), SHIRINK_MS)
    return () => window.clearTimeout(hide)
  }, [active])

  // Focus once the box is expanded and laid out.
  React.useEffect(() => {
    if (phase !== 'open' || !active) return
    const id = window.setTimeout(() => inputRef.current?.focus(), 10)
    return () => window.clearTimeout(id)
  }, [phase, active])

  const handleChange = React.useCallback((value: string) => {
    onChange(value)
  }, [onChange])

  /**
   * Collapse only when the box loses focus while it contains no characters.
   * Editing a query down to empty does not close it: the user may immediately
   * enter a replacement query. Any non-empty draft stays visible after blur.
   *
   * The typed draft is intentionally kept in memory when we collapse (the
   * parent owns `query`); it is not persisted anywhere, so a restart starts
   * from an empty box.
   */
  const handleBlur = React.useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null
    // Focus moving within the control (e.g. hitting the clear button) is not a blur.
    if (next && event.currentTarget.contains(next)) return
    if (!shouldCloseHeaderSearch('blur', query)) return
    ;(onCollapse ?? onClose)()
  }, [query, onClose, onCollapse])

  return (
    <>
      {/* Keyframes rather than a width transition: the box is mounted already
          expanded, so a transition has no start value to animate from. */}
      <style>{`
        @keyframes headerSearchGrow {
          from { width: 1.75rem; opacity: 0; }
          to   { width: calc(100% - 1rem); opacity: 1; }
        }
        @keyframes headerSearchShrink {
          from { width: calc(100% - 1rem); opacity: 1; }
          to   { width: 1.75rem; opacity: 0; }
        }
      `}</style>
      {phase === 'hidden' ? (
        <button
          type="button"
          data-focus-zone="navigator"
          onPointerDown={() => setCurrentZone('navigator')}
          onClick={onOpen}
          aria-label={t('session.search')}
          className="titlebar-no-drag flex h-7 w-7 items-center justify-center rounded-[7px] text-muted-foreground transition-colors hover:bg-foreground/[0.07] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Search className="h-4 w-4" />
        </button>
      ) : null}

      {phase !== 'hidden' ? (
        <div
          data-focus-zone="navigator"
          onBlur={handleBlur}
          className={[
            'titlebar-no-drag absolute top-1/2 right-2 z-[2] flex -translate-y-1/2 items-center gap-1.5',
            'rounded-[7px] border border-foreground/10 bg-background shadow-minimal',
            'overflow-hidden',
          ].join(' ')}
          style={{
            // Anchored right, so growing the width extends it leftwards.
            width: 'calc(100% - 1rem)',
            animation: active
              ? `headerSearchGrow ${GROW_MS}ms ease-out both`
              : `headerSearchShrink ${SHIRINK_MS}ms ease-out both`,
          }}
        >
          <Search className="ml-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => handleChange(event.target.value)}
            onInput={(event) => {
              // Backstop for the "cleared" case: IME/undo paths can leave the
              // controlled value empty without a change event React can pair.
              if ((event.target as HTMLInputElement).value === '' && query !== '') {
                handleChange('')
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                onClose()
              }
              event.stopPropagation()
            }}
            placeholder={t('session.searchPlaceholder')}
            className="h-7 min-w-0 flex-1 bg-transparent pr-1 text-[13px] outline-none placeholder:text-muted-foreground"
          />
          {query ? (
            <button
              type="button"
              onClick={onClose}
              aria-label={t('session.clearSearch')}
              className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
