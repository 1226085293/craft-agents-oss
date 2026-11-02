/**
 * Attachment capsule + hover preview, shared by every surface that shows an
 * attachment *outside* the composer.
 *
 * Queued rows and sent messages used to draw their own attachment marks (a tiny
 * square icon, a thumbnail card), which is why they looked nothing like the
 * chips in the input and had no preview. Everything now renders the composer's
 * exact capsule markup (`renderAttachmentChipHTML`) and the same fixed-size
 * preview card.
 */

import * as React from 'react'
import { formatAttachmentToken, findAttachmentTokens } from '@/lib/attachment-tokens'
import { AttachmentChipPreview } from './AttachmentChipPreview'
import {
  renderAttachmentChipHTML,
  type AttachmentChipRect,
  type RichTextAttachmentChip,
} from '@/components/ui/rich-text-input'
import type { FileAttachment } from '../../../../shared/types'

/**
 * Loose shape accepted by the capsule.
 *
 * Composer chips carry only name/type/mimeType; queued rows and sent messages
 * carry a stored path and maybe a thumbnail. Structural on purpose so all three
 * call sites can share the renderer.
 */
export interface CapsuleAttachment {
  name: string
  type?: string
  mimeType?: string
  size?: number
  storedPath?: string
  thumbnailBase64?: string
  text?: string
  base64?: string
}

function toChip(attachment: CapsuleAttachment): RichTextAttachmentChip {
  return {
    name: attachment.name,
    type: (attachment.type ?? 'unknown') as RichTextAttachmentChip['type'],
    mimeType: attachment.mimeType,
  }
}

function rectOf(element: Element): AttachmentChipRect {
  const rect = element.getBoundingClientRect()
  return {
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  }
}

/** One capsule, byte-for-byte the markup the composer uses. */
export function AttachmentCapsule({ attachment }: { attachment: CapsuleAttachment }) {
  const html = React.useMemo(
    () => renderAttachmentChipHTML(toChip(attachment), formatAttachmentToken(attachment.name)),
    [attachment.name, attachment.type, attachment.mimeType]
  )
  return <span className="inline-flex align-middle" dangerouslySetInnerHTML={{ __html: html }} />
}

/** Loaded payloads, keyed by stored path (previews are opened repeatedly). */
const payloadCache = new Map<string, FileAttachment | null>()

/**
 * Load the bytes behind an attachment on demand.
 *
 * Sent messages only carry a path, so the preview fetches the payload the first
 * time the chip is hovered and caches it for the rest of the session.
 */
function useAttachmentPayload(attachment: CapsuleAttachment | null): FileAttachment | null {
  const [loaded, setLoaded] = React.useState<FileAttachment | null>(null)
  const path = attachment?.storedPath

  React.useEffect(() => {
    setLoaded(null)
    if (!path) return
    if (payloadCache.has(path)) {
      setLoaded(payloadCache.get(path) ?? null)
      return
    }
    let cancelled = false
    window.electronAPI
      ?.readFileAttachment?.(path)
      .then(result => {
        payloadCache.set(path, result ?? null)
        if (!cancelled) setLoaded(result ?? null)
      })
      .catch(() => {
        if (!cancelled) setLoaded(null)
      })
    return () => {
      cancelled = true
    }
  }, [path])

  return loaded
}

/** The fixed-size preview card for one capsule. */
export function AttachmentHoverCard({
  attachment,
  rect,
}: {
  attachment: CapsuleAttachment
  rect: AttachmentChipRect
}) {
  const loaded = useAttachmentPayload(attachment)

  const preview = React.useMemo<FileAttachment>(() => ({
    type: (attachment.type ?? 'unknown') as FileAttachment['type'],
    path: attachment.storedPath ?? attachment.name,
    name: attachment.name,
    mimeType: attachment.mimeType ?? 'application/octet-stream',
    size: attachment.size ?? 0,
    base64: attachment.base64 ?? loaded?.base64,
    text: attachment.text ?? loaded?.text,
    thumbnailBase64: attachment.thumbnailBase64 ?? loaded?.thumbnailBase64,
  }), [attachment, loaded])

  return <AttachmentChipPreview attachment={preview} rect={rect} />
}

/**
 * A row of capsules with one shared hover preview.
 *
 * Used where the attachments are listed rather than inlined in the text (sent
 * user messages). Inline surfaces do their own event delegation and render
 * `AttachmentHoverCard` directly.
 */
export function AttachmentCapsules({
  attachments,
  className,
}: {
  attachments: readonly CapsuleAttachment[]
  className?: string
}) {
  const [hover, setHover] = React.useState<{ attachment: CapsuleAttachment; rect: AttachmentChipRect } | null>(null)

  if (attachments.length === 0) return null

  return (
    <>
      <div className={className ?? 'flex flex-wrap justify-end gap-1'}>
        {attachments.map((attachment, index) => (
          <span
            key={`${attachment.name}-${index}`}
            className="inline-flex"
            onMouseEnter={event => {
              const chip = event.currentTarget.querySelector('[data-attachment="true"]')
              setHover({ attachment, rect: rectOf(chip ?? event.currentTarget) })
            }}
            onMouseLeave={() => setHover(null)}
          >
            <AttachmentCapsule attachment={attachment} />
          </span>
        ))}
      </div>
      {hover && <AttachmentHoverCard attachment={hover.attachment} rect={hover.rect} />}
    </>
  )
}

/**
 * Remove inline attachment tokens from text that is displayed next to a chip.
 *
 * Sent messages keep `[attachment:…]` in the stored text (that is how the model
 * knows where a file belonged), but the bubble renders chips for them — showing
 * the raw token as well would duplicate the attachment and look broken.
 */
export function stripAttachmentTokens(text: string): string {
  const tokens = findAttachmentTokens(text)
  if (tokens.length === 0) return text

  let result = ''
  let last = 0
  for (const token of tokens) {
    result += text.slice(last, token.start)
    last = token.end
  }
  result += text.slice(last)

  return result.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}
