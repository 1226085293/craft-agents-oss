/**
 * Composer rehydration for queued messages (2026-10-22 queued-panel).
 *
 * When the user edits a queued message, it leaves the queue and its text +
 * attachments go back into the composer. Attachments are persisted as
 * `StoredAttachment` (metadata + storedPath). Turning them back into
 * `FileAttachment`s must keep the send path intact:
 *  - images / pdf / office / audio need inline bytes (base64) so the re-send
 *    does not have to re-read them;
 *  - text files need their `text` payload;
 *  - `thumbnailBase64` keeps the composer thumbnail visible.
 *
 * Image payloads are already on the stored row (`resizedBase64` when the image
 * was downscaled for the API, otherwise the original file), so those are built
 * without touching disk. Everything else is re-read through the
 * `readFileAttachment` RPC, which is scoped to the session folder these files
 * live in. A file that vanished is dropped with a console warning rather than
 * failing the whole edit.
 */

import type { FileAttachment, StoredAttachment } from '../../shared/types'

const INLINE_TYPES = new Set(['image', 'pdf', 'office', 'audio'])

export async function restoreComposerAttachments(
  attachments: StoredAttachment[] | undefined,
): Promise<FileAttachment[]> {
  if (!attachments?.length) return []

  const restored = await Promise.all(
    attachments.map(async (stored): Promise<FileAttachment | null> => {
      const base = {
        type: stored.type,
        path: stored.storedPath,
        name: stored.name,
        mimeType: stored.mimeType,
        size: stored.size,
        storedPath: stored.storedPath,
        markdownPath: stored.markdownPath,
        thumbnailBase64: stored.thumbnailBase64,
      }

      // Images: prefer the resized payload (that is what the API would have
      // received), fall back to reading the original file only when absent.
      if (stored.type === 'image' && stored.resizedBase64) {
        return { ...base, base64: stored.resizedBase64 }
      }

      if (INLINE_TYPES.has(stored.type) || stored.type === 'text') {
        try {
          const fresh = await window.electronAPI.readFileAttachment(stored.storedPath)
          if (!fresh) {
            console.warn('[queued-attachments] File missing on edit, dropping:', stored.storedPath)
            return null
          }
          return {
            ...fresh,
            // Prefer the persisted attachment id paths/names over re-derived ones.
            name: stored.name,
            storedPath: stored.storedPath,
            markdownPath: stored.markdownPath ?? fresh.markdownPath,
            thumbnailBase64: stored.thumbnailBase64 ?? fresh.thumbnailBase64,
          }
        } catch (error) {
          console.warn('[queued-attachments] Failed to restore attachment, dropping:', stored.storedPath, error)
          return null
        }
      }

      // No inline payload was ever needed (unknown type that is path-only).
      return base
    }),
  )

  return restored.filter((a): a is FileAttachment => a !== null)
}
