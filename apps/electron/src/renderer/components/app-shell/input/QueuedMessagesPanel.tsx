/**
 * QueuedMessagesPanel - pending send queue rendered ABOVE the composer
 * (2026-10-22 queued-panel).
 *
 * Queued messages are no longer transcript bubbles. Each pending message is a
 * row in a compact panel sitting directly above the input:
 *  - LEFT: drag handle — drag to reorder the queue (dnd-kit, same
 *    SmartPointerSensor feel as SortableList).
 *  - RIGHT: three actions — 引导 (guide the current turn with this message),
 *    编辑 (remove from the queue and put text + attachments back into the
 *    composer), 删除 (drop the message).
 *
 * Data comes from `session.queuedMessages` (backend `queued_messages_changed`
 * events carry the full ordered queue, so every window stays in sync).
 */

import * as React from 'react'
import { GripVertical, CornerDownRight, Pencil, Trash2, Loader2 } from 'lucide-react'
import { FileTypeIcon } from '@craft-agent/ui'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'
import { resolveAttachmentTokens, findAttachmentForToken } from '@/lib/attachment-tokens'
import { textToHTML, type AttachmentChipRect } from '@/components/ui/rich-text-input'
import { AttachmentHoverCard } from './AttachmentCapsule'
import type { QueuedMessageSummary } from '../../../../shared/types'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  DragOverlay,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

// ============================================================
// SmartPointerSensor — drag only from the handle (data-dnd-handle),
// never from the action buttons or the text itself.
// ============================================================

function hasHandleAncestor(element: HTMLElement | null): boolean {
  while (element) {
    if (element.dataset?.dndHandle === 'true') return true
    element = element.parentElement
  }
  return false
}

function blocksDrag(element: HTMLElement | null): boolean {
  while (element) {
    if (element.dataset?.noDnd === 'true') return true
    element = element.parentElement
  }
  return false
}

class HandleOnlyPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: 'onPointerDown' as const,
      handler: ({ nativeEvent }: { nativeEvent: PointerEvent }) => {
        // Same guards dnd-kit's stock activator applies: primary pointer and
        // the main button only — right/middle click must never start a drag.
        if (!nativeEvent.isPrimary || nativeEvent.button !== 0) {
          return false
        }
        const target = nativeEvent.target as HTMLElement
        // Dragging starts ONLY on the handle; interactive elements never drag.
        if (blocksDrag(target) || !hasHandleAncestor(target)) {
          return false
        }
        return true
      },
    },
  ]
}

// ============================================================
// Message preview with inline attachment chips
// ============================================================

/**
 * Queued rows keep the attachment token in `message`, exactly like the
 * composer does — so the row renders the same ~one-character chips inline at
 * the position the attachment belongs to, instead of a detached "2 files" line.
 * Attachments without a token (queued rows written by an older build) fall back
 * to the old count line so nothing silently disappears.
 */
function QueuedMessagePreview({ item }: { item: QueuedMessageSummary }) {
  const { t } = useTranslation()
  const attachments = item.attachments ?? []
  const tracked = resolveAttachmentTokens(item.message, attachments).length
  const untracked = attachments.length - tracked
  const [hover, setHover] = React.useState<{ attachment: (typeof attachments)[number]; rect: AttachmentChipRect } | null>(null)

  // Render through the composer's own HTML builder. A second, hand-rolled chip
  // design here is exactly why queued tags looked nothing like the ones in the
  // input: `textToHTML` already emits the same capsule markup, so the two views
  // cannot drift apart again.
  const html = textToHTML(item.message, [], [], undefined, attachments)

  // The chips are injected as HTML, so hover is resolved by delegation: find the
  // capsule under the pointer, map its token back to the attachment, anchor the
  // preview card to it.
  const handleMouseOver = (event: React.MouseEvent<HTMLDivElement>) => {
    const chip = (event.target as HTMLElement | null)?.closest?.('[data-attachment="true"]') as HTMLElement | null
    if (!chip) return
    const attachment = findAttachmentForToken(attachments, chip.getAttribute('data-attachment-text'))
    if (!attachment) return
    const rect = chip.getBoundingClientRect()
    setHover({
      attachment,
      rect: { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height },
    })
  }

  return (
    <>
      <div
        className="truncate text-[13px] leading-5 text-foreground/90"
        onMouseOver={handleMouseOver}
        onMouseLeave={() => setHover(null)}
        onDoubleClick={(event) => {
          // Same gesture as a chip in the composer: open the attachment itself.
          const chip = (event.target as HTMLElement | null)?.closest?.('[data-attachment="true"]') as HTMLElement | null
          const path = findAttachmentForToken(attachments, chip?.getAttribute('data-attachment-text') ?? '')?.storedPath
          if (path) window.dispatchEvent(new CustomEvent('craft:open-attachment', { detail: { path } }))
        }}
        dangerouslySetInnerHTML={{ __html: html || '&nbsp;' }}
      />
      {hover && <AttachmentHoverCard attachment={hover.attachment} rect={hover.rect} />}
      {untracked > 0 && (
        <div className="mt-0.5 flex items-center gap-1 text-[11px] leading-4 text-muted-foreground">
          <FileTypeIcon type={attachments[0]!.type} mimeType={attachments[0]!.mimeType} className="h-3 w-3 shrink-0" />
          <span className="truncate">{t('chat.queuedPanel.attachmentCount', { count: untracked })}</span>
        </div>
      )}
    </>
  )
}

// ============================================================
// Single queue row
// ============================================================

interface QueuedRowProps {
  item: QueuedMessageSummary
  onGuide: (item: QueuedMessageSummary) => void
  onEdit: (item: QueuedMessageSummary) => void
  onCancel: (item: QueuedMessageSummary) => void
}

function QueuedRow({ item, onGuide, onEdit, onCancel }: QueuedRowProps) {
  const { t } = useTranslation()
  const [guiding, setGuiding] = React.useState(false)
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      role="listitem"
      className="group/queued-row flex items-center gap-1 rounded-[10px] bg-background/60 px-1.5 py-1.5 ring-1 ring-foreground/8 transition-colors hover:bg-background"
    >
      {/* Drag handle — the ONLY drag activation surface */}
      <button
        type="button"
        data-dnd-handle="true"
        className="flex h-6 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/50 transition-colors hover:bg-foreground/8 hover:text-muted-foreground active:cursor-grabbing"
        aria-label={t('chat.queuedPanel.reorderLabel')}
        title={t('chat.queuedPanel.reorderLabel')}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
      </button>

      {/* Content preview — attachment chips render inline at their token position */}
      <div className="min-w-0 flex-1 select-none">
        <QueuedMessagePreview item={item} />
      </div>

      {/* Actions */}
      <div className="flex shrink-0 items-center gap-0.5" data-no-dnd="true">
        <button
          type="button"
          className={cn(
            "inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-foreground/8 hover:text-foreground",
            guiding && "cursor-default opacity-70 hover:bg-transparent",
          )}
          title={t('chat.queuedAction.guideLabel')}
          aria-label={t('chat.queuedAction.guideLabel')}
          aria-busy={guiding}
          disabled={guiding}
          onClick={() => {
            if (guiding) return
            setGuiding(true)
            onGuide(item)
          }}
        >
          {guiding
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            : <CornerDownRight className="h-3.5 w-3.5" aria-hidden="true" />}
        </button>
        <button
          type="button"
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-foreground/8 hover:text-foreground disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
          title={t('chat.queuedPanel.editLabel')}
          aria-label={t('chat.queuedPanel.editLabel')}
          disabled={guiding}
          onClick={() => onEdit(item)}
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
          title={t('chat.queuedAction.cancelLabel')}
          aria-label={t('chat.queuedAction.cancelLabel')}
          disabled={guiding}
          onClick={() => onCancel(item)}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

// ============================================================
// Panel
// ============================================================

export interface QueuedMessagesPanelProps {
  items: QueuedMessageSummary[]
  /** Reorder the pending queue (full new order of user rows). */
  onReorder: (messageIds: string[]) => void
  /** Guide the current turn with this queued message. */
  onGuide: (messageId: string) => void
  /** Remove from the queue and restore text + attachments into the composer. */
  onEdit: (messageId: string) => void
  /** Remove the queued message. */
  onCancel: (messageId: string) => void
  className?: string
}

export function QueuedMessagesPanel({
  items: incomingItems,
  onReorder,
  onGuide,
  onEdit,
  onCancel,
  className,
}: QueuedMessagesPanelProps) {
  const { t } = useTranslation()
  const [activeId, setActiveId] = React.useState<string | null>(null)

  // Local order so a drop lands exactly where the row was released. The
  // backend snapshot (fed back through `incomingItems` by
  // `queued_messages_changed`) stays authoritative: it replaces this list as
  // soon as it arrives, including when another window reorders the queue.
  const [items, setItems] = React.useState<QueuedMessageSummary[]>(incomingItems)
  React.useEffect(() => {
    setItems(incomingItems)
  }, [incomingItems])

  const sensors = useSensors(
    useSensor(HandleOnlyPointerSensor, {
      activationConstraint: { distance: 4 },
    }),
    useSensor(KeyboardSensor),
  )

  const activeItem = React.useMemo(
    () => items.find(item => item.id === activeId),
    [items, activeId],
  )

  const handleDragStart = React.useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id))
  }, [])

  const handleDragEnd = React.useCallback((event: DragEndEvent) => {
    const { active, over } = event
    setActiveId(null)
    if (!over || active.id === over.id) return
    const oldIndex = items.findIndex(item => item.id === active.id)
    const newIndex = items.findIndex(item => item.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    const reordered = arrayMove(items, oldIndex, newIndex)
    // Land the row NOW, before the RPC round-trip. Waiting for the server
    // snapshot made the drop overlay vanish, the row snap back to its old
    // slot, and only then jump to the new one — the queue visibly flashed
    // back to where the drag started before teleporting.
    setItems(reordered)
    onReorder(reordered.map(item => item.id))
  }, [items, onReorder])

  const handleDragCancel = React.useCallback(() => {
    setActiveId(null)
  }, [])

  if (items.length === 0) return null

  return (
    <div
      className={cn(
        'rounded-[12px] border border-border/50 bg-user-message-bubble/40 px-1.5 py-1.5',
        className,
      )}
      role="list"
      aria-label={t('chat.queuedPanel.label')}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext items={items} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-0.5">
            {items.map(item => (
              <QueuedRow
                key={item.id}
                item={item}
                onGuide={row => onGuide(row.id)}
                onEdit={row => onEdit(row.id)}
                onCancel={row => onCancel(row.id)}
              />
            ))}
          </div>
        </SortableContext>
        <DragOverlay
          dropAnimation={{
            keyframes({ transform }) {
              return [
                { opacity: 1, transform: CSS.Transform.toString(transform.initial) },
                { opacity: 0, transform: CSS.Transform.toString(transform.final) },
              ]
            },
            duration: 220,
            easing: 'ease',
          }}
          style={{ zIndex: 'var(--z-floating-menu, 400)' }}
        >
          {activeItem ? (
            <div
              className="w-full rounded-[10px] bg-background px-2 py-1.5 ring-1 ring-foreground/10"
              style={{ boxShadow: '0px 12px 16px 0 rgba(0, 0, 0, 0.18)' }}
            >
              <div className="flex items-center gap-2">
                <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" aria-hidden="true" />
                <div className="min-w-0">
                  <div className="truncate text-[13px] leading-5 text-foreground/90">{activeItem.message}</div>
                </div>
              </div>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  )
}
