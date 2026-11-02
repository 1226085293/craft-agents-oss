import * as React from 'react'
import { FileTypeIcon } from '@craft-agent/ui'
import type { FileAttachment } from '../../../../shared/types'
import type { AttachmentChipRect } from '@/components/ui/rich-text-input'

/**
 * AttachmentChipPreview - hover preview for an inline attachment chip.
 *
 * Content only: a fixed-size box that shows the attachment itself (image, or
 * text), never the file's metadata. The chip already carries the name, so
 * repeating it here would just eat the preview area.
 *
 * `pointer-events-none` is deliberate: hovering must never steal the pointer
 * from the chip, otherwise the double-click that opens the real preview would
 * land on this card instead.
 */

interface AttachmentChipPreviewProps {
  attachment: FileAttachment
  /** Viewport rect of the chip the card is anchored to. */
  rect: AttachmentChipRect
}

/** Fixed preview box — every attachment previews at the same size. */
const PREVIEW_WIDTH = 248
const PREVIEW_HEIGHT = 168

/** How much text is rendered (scrollable beyond that, so the DOM stays small). */
const MAX_PREVIEW_TEXT = 4000

type PreviewContent =
  | { kind: 'image'; src: string }
  | { kind: 'text'; text: string }
  | { kind: 'none' }

function dataUrl(base64: string, mimeType: string): string {
  return base64.startsWith('data:') ? base64 : `data:${mimeType || 'image/png'};base64,${base64}`
}

function buildPreview(attachment: FileAttachment): PreviewContent {
  // Real image bytes first; Quick Look thumbnails (pdf / office) next.
  if (attachment.type === 'image' && attachment.base64) {
    return { kind: 'image', src: dataUrl(attachment.base64, attachment.mimeType) }
  }
  if (attachment.thumbnailBase64) {
    return { kind: 'image', src: dataUrl(attachment.thumbnailBase64, 'image/png') }
  }
  if (attachment.text) {
    return { kind: 'text', text: attachment.text.slice(0, MAX_PREVIEW_TEXT) }
  }
  return { kind: 'none' }
}

export function AttachmentChipPreview({ attachment, rect }: AttachmentChipPreviewProps) {
  const preview = buildPreview(attachment)
  // Near the top of the viewport the card has to open downwards.
  const placeBelow = rect.top < PREVIEW_HEIGHT + 24

  return (
    <div
      className="pointer-events-none fixed overflow-hidden rounded-[10px] border border-border/60 bg-background shadow-middle"
      style={{
        width: PREVIEW_WIDTH,
        height: PREVIEW_HEIGHT,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - PREVIEW_WIDTH - 8)),
        top: placeBelow ? rect.bottom + 8 : rect.top - 8,
        transform: placeBelow ? undefined : 'translateY(-100%)',
        zIndex: 'var(--z-floating-menu, 400)',
      }}
      role="tooltip"
    >
      {preview.kind === 'image' && (
        <img
          src={preview.src}
          alt={attachment.name}
          className="h-full w-full object-cover"
          draggable={false}
        />
      )}

      {preview.kind === 'text' && (
        <pre className="h-full w-full overflow-auto whitespace-pre-wrap break-words p-2 text-[11px] leading-4 text-foreground/80">
          {preview.text}
        </pre>
      )}

      {preview.kind === 'none' && (
        <div className="flex h-full w-full items-center justify-center">
          <FileTypeIcon type={attachment.type} mimeType={attachment.mimeType} className="h-6 w-6" />
        </div>
      )}
    </div>
  )
}
