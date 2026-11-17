/**
 * Explorer-style row selection for the 收件箱 / 发件箱 lists.
 *
 * Single click activates a row (selects it alone + opens its detail);
 * Ctrl/⌘+click toggles membership in the multi-selection; Shift+click
 * selects the range from the last activated row — the same grammar as the
 * Windows file manager, so bulk deletes feel native.
 *
 * The pure selection math lives in `nextSelection` (unit-tested without
 * React); `useExplorerSelection` wires it to pointer events, and
 * `RowDeleteMenu` + `RecordDeleteConfirm` are the right-click menu and its
 * second-confirm step (mirroring FolderDeleteConfirm's pattern).
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Trash2 } from 'lucide-react'

// ---------------------------------------------------------------------------
// Pure selection math
// ---------------------------------------------------------------------------

export type SelectionKey = 'click' | 'ctrl' | 'shift'

export interface SelectionState {
  selected: Set<string>
  /** The row a shift range starts from — the last single-clicked row. */
  anchor: string | null
}

/**
 * What the selection should be after pressing `key` on row `id`, given the
 * currently visible `ordered` rows (display order — a range follows what the
 * user sees, not the underlying storage order).
 */
export function nextSelection(
  ordered: readonly string[],
  current: SelectionState,
  id: string,
  key: SelectionKey,
): SelectionState {
  if (key === 'click') {
    return { selected: new Set([id]), anchor: id }
  }
  if (key === 'ctrl') {
    const next = new Set(current.selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return { selected: next, anchor: id }
  }
  // shift: extend from the anchor; no anchor yet → just activate the row.
  if (!current.anchor || !ordered.includes(current.anchor)) {
    return { selected: new Set([id]), anchor: id }
  }
  const from = ordered.indexOf(current.anchor)
  const to = ordered.indexOf(id)
  const [lo, hi] = from <= to ? [from, to] : [to, from]
  return { selected: new Set(ordered.slice(lo, hi + 1)), anchor: current.anchor }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useExplorerSelection(ordered: readonly string[]) {
  const [state, setState] = React.useState<SelectionState>({ selected: new Set<string>(), anchor: null })

  const handleRowClick = React.useCallback(
    (event: React.MouseEvent, id: string) => {
      const key: SelectionKey = event.shiftKey ? 'shift' : event.ctrlKey || event.metaKey ? 'ctrl' : 'click'
      if (key === 'click') {
        // Activation is the caller's job (open the detail); the selection is
        // always the single row under the cursor.
        setState({ selected: new Set([id]), anchor: id })
        return false
      }
      setState((prev) => nextSelection(ordered, prev, id, key))
      // Tell the caller NOT to open the detail for modifier-clicks.
      return true
    },
    [ordered],
  )

  const handleRowContext = React.useCallback(
    (event: React.MouseEvent, id: string) => {
      event.preventDefault()
      // A right-click on an unselected row makes it the selection first,
      // exactly like Explorer.
      setState((prev) =>
        prev.selected.has(id)
          ? prev
          : { selected: new Set([id]), anchor: id },
      )
      return false
    },
    [],
  )

  const dropIds = React.useCallback((ids: readonly string[]) => {
    const gone = new Set(ids)
    setState((prev) => ({
      selected: new Set([...prev.selected].filter((id) => !gone.has(id))),
      anchor: prev.anchor && gone.has(prev.anchor) ? null : prev.anchor,
    }))
  }, [])

  return {
    selected: state.selected,
    handleRowClick,
    handleRowContext,
    dropIds,
    clear: () => setState({ selected: new Set<string>(), anchor: null }),
  }
}

// ---------------------------------------------------------------------------
// Right-click menu (one item: delete the selection)
// ---------------------------------------------------------------------------

export interface MenuPosition {
  x: number
  y: number
}

export function RowDeleteMenu({
  position,
  count,
  onRequestDelete,
  onClose,
}: {
  position: MenuPosition
  count: number
  onRequestDelete: () => void
  onClose: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  // Clamp to the viewport so the item is always reachable near the edges.
  const left = Math.min(position.x, window.innerWidth - 170)
  const top = Math.min(position.y, window.innerHeight - 50)

  // `onClose` is a fresh closure on every render of the owning list; a ref
  // lets the window listeners stay registered through those re-renders
  // (the outbox polls every five seconds) instead of churning on each one.
  const onCloseRef = React.useRef(onClose)
  React.useEffect(() => {
    onCloseRef.current = onClose
  })

  React.useEffect(() => {
    const close = () => onCloseRef.current()
    // Defer one task: the same contextmenu event that mounts this menu is
    // still propagating up to window at that point (React flushes discrete-
    // event renders synchronously), so registering immediately would let the
    // very click that opens the menu close it again — the menu mounted and
    // unmounted within 3 ms. Every LATER click / right-click / scroll /
    // resize closes it as before.
    const timer = window.setTimeout(() => {
      window.addEventListener('click', close)
      window.addEventListener('contextmenu', close)
      window.addEventListener('scroll', close, true)
      window.addEventListener('resize', close)
    }, 0)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [])

  return createPortal(
    <div
      className="fixed z-[100] min-w-[160px] rounded-md border border-foreground/10 bg-popover p-1 shadow-2xl"
      style={{ left, top }}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => {
          onClose()
          onRequestDelete()
        }}
        className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[13px] text-destructive hover:bg-destructive/10"
      >
        <Trash2 className="h-3.5 w-3.5 shrink-0" />
        {count === 1
          ? t('events.outbox.delete')
          : `${t('events.outbox.delete')} (${count})`}
      </button>
    </div>,
    document.body,
  )
}

// ---------------------------------------------------------------------------
// Second-confirm step
// ---------------------------------------------------------------------------

export function RecordDeleteConfirm({
  count,
  busy,
  onCancel,
  onConfirm,
}: {
  count: number
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="w-[340px] rounded-lg border border-foreground/10 bg-popover p-4 text-popover-foreground shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-2 text-sm font-medium">{t('events.deleteConfirm.title', { count })}</div>
        <p className="mb-3 text-xs text-muted-foreground">{t('events.deleteConfirm.body')}</p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
            onClick={onCancel}
          >
            {t('folders.cancel')}
          </button>
          <button
            type="button"
            disabled={busy}
            className="rounded-md bg-destructive px-3 py-1.5 text-sm text-white hover:bg-destructive/90 disabled:opacity-50"
            onClick={onConfirm}
          >
            {t('events.deleteConfirm.action')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
