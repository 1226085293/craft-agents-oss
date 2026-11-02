/**
 * Inline attachment tokens — the text-model representation of a composer chip.
 *
 * A chip only occupies ~one character in the composer, but the *text* has to
 * carry the attachment at the exact spot where the user dropped it, because the
 * text is the only thing the model ever sees together with its position:
 *
 *     Compare [attachment:report.pdf] against [attachment:draft.md]
 *
 *   - `message` keeps the token inline  → the model knows which segment the
 *     attachment belongs to.
 *   - `attachments` keeps the bytes/path → the agent layer already prints
 *     `[Attached file: <name>]` + `[Stored at: <path>]` blocks, so matching by
 *     name ties token → payload.
 *
 * Identity is the attachment *name*, not its path:
 *   - drafts persist `{ path, name }` and the queue hands back
 *     `StoredAttachment` whose `storedPath` differs from the composer path
 *     (the file is copied into the session folder on send) — the name is the
 *     only field that survives both round-trips.
 *   - Names are sanitized identically on both sides (see `attachmentTokenKey`),
 *     so brackets/newlines in a filename can never break the grammar.
 *
 * Duplicate names are handled as a multiset: each token consumes one matching
 * attachment, in order, so attaching two same-named files keeps both.
 */

import type { ContentBadge } from '@craft-agent/core'
import {
  ATTACHMENT_TOKEN_PREFIX,
  attachmentTokenKey,
  formatAttachmentToken,
  findAttachmentTokens,
  type AttachmentTokenMatch,
  // NOTE: import the leaf module, not the `@craft-agent/shared/sessions` barrel —
  // the barrel pulls in storage.ts → utils/paths.ts → `os.homedir()`, which Vite
  // externalizes for the browser and throws at runtime (blank screen / endless spinner).
} from '@craft-agent/shared/sessions/attachment-token'

export {
  ATTACHMENT_TOKEN_PREFIX,
  attachmentTokenKey,
  formatAttachmentToken,
  findAttachmentTokens,
  type AttachmentTokenMatch,
}

/** Minimum shape of the objects a token can point at. */
export interface AttachmentTokenTarget {
  name: string
  path?: string
  storedPath?: string
}

/** True when the text contains at least one attachment token. */
export function hasAttachmentToken(text: string | undefined | null): boolean {
  if (!text) return false
  return findAttachmentTokens(text).length > 0
}

/** Extract the key out of a single token string (`[attachment:x]` → `x`). */
export function attachmentTokenKeyOf(tokenText: string | undefined | null): string | null {
  if (!tokenText) return null
  const pattern = new RegExp(/\[attachment:([^\]\n]+)\]/.source)
  const match = pattern.exec(tokenText)
  return match ? attachmentTokenKey(match[1]) : null
}

/**
 * Pair each token with the attachment it refers to.
 *
 * Uses multiset semantics: the n-th token with a given key consumes the n-th
 * attachment with that name. Tokens without a remaining attachment are dropped
 * (they were typed/pasted by hand, or the attachment is gone).
 *
 * An attachment matches a token by its original `name` OR by the basename of its
 * `storedPath`. The latter is needed because the message text token is rewritten
 * to the stored filename (`a1b2c3_pasted-image-1.png`) at send time while the
 * attachment's display `name` stays the original (`pasted-image-1.png`).
 */
export function resolveAttachmentTokens<T extends AttachmentTokenTarget>(
  text: string,
  attachments: readonly T[] | undefined | null,
): Array<{ token: AttachmentTokenMatch; attachment: T }> {
  const pool = new Map<string, T[]>()
  for (const attachment of attachments ?? []) {
    const keys = [attachmentTokenKey(attachment.name)]
    const storedBase = attachment.storedPath?.split(/[\\/]/).pop()
    if (storedBase) {
      const storedKey = attachmentTokenKey(storedBase)
      if (storedKey !== keys[0]) keys.push(storedKey)
    }
    for (const key of keys) {
      const list = pool.get(key)
      if (list) list.push(attachment)
      else pool.set(key, [attachment])
    }
  }

  const resolved: Array<{ token: AttachmentTokenMatch; attachment: T }> = []
  const used = new Set<T>()
  for (const token of findAttachmentTokens(text)) {
    const list = pool.get(token.key)
    if (!list?.length) continue
    // An attachment can be reachable under both its name and stored-filename
    // keys; skip ones already consumed by an earlier token.
    const attachment = list.find(a => !used.has(a))
    if (!attachment) continue
    used.add(attachment)
    resolved.push({ token, attachment })
  }
  return resolved
}

/** First attachment matching a token's key, or undefined when it is unknown. */
export function findAttachmentForToken<T extends AttachmentTokenTarget>(
  attachments: readonly T[] | undefined | null,
  tokenText: string | undefined | null,
): T | undefined {
  const key = attachmentTokenKeyOf(tokenText)
  if (!key) return undefined
  return (attachments ?? []).find(attachment => attachmentTokenKey(attachment.name) === key)
}

/**
 * Drop attachments whose token no longer appears in the composer text.
 *
 * The text is the source of truth for "what is still staged": deleting a chip
 * (Backspace, select + Delete, Ctrl+A + Delete) must also drop the attachment.
 * Returns the SAME array instance when nothing changed, so React callers can
 * skip a state update.
 */
export function filterAttachmentsByTokens<T extends AttachmentTokenTarget>(
  attachments: T[],
  text: string,
): T[] {
  if (attachments.length === 0) return attachments

  const available = new Map<string, number>()
  for (const token of findAttachmentTokens(text)) {
    available.set(token.key, (available.get(token.key) ?? 0) + 1)
  }

  let changed = false
  const kept = attachments.filter(attachment => {
    const key = attachmentTokenKey(attachment.name)
    const remaining = available.get(key) ?? 0
    if (remaining <= 0) {
      changed = true
      return false
    }
    available.set(key, remaining - 1)
    return true
  })

  return changed ? kept : attachments
}

/**
 * Make sure every attachment is represented in the text.
 *
 * Used when restoring state written before inline tokens existed (old drafts,
 * queued messages persisted by an older build): their text is plain and the
 * attachment list is separate, so the missing tokens are appended in order.
 * Attachments already referenced by a token are left untouched.
 */
export function ensureAttachmentTokens<T extends AttachmentTokenTarget>(
  text: string,
  attachments: readonly T[] | undefined | null,
): string {
  if (!attachments?.length) return text

  const pending = new Map<string, number>()
  for (const attachment of attachments) {
    const key = attachmentTokenKey(attachment.name)
    pending.set(key, (pending.get(key) ?? 0) + 1)
  }
  // Consume the tokens that are already there.
  for (const token of findAttachmentTokens(text)) {
    const remaining = pending.get(token.key) ?? 0
    if (remaining > 0) pending.set(token.key, remaining - 1)
  }

  const missing: string[] = []
  for (const attachment of attachments) {
    const key = attachmentTokenKey(attachment.name)
    const remaining = pending.get(key) ?? 0
    if (remaining <= 0) continue
    pending.set(key, remaining - 1)
    missing.push(formatAttachmentToken(attachment.name))
  }

  if (missing.length === 0) return text
  const body = text.trimEnd()
  return body.length > 0 ? `${body} ${missing.join(' ')}` : missing.join(' ')
}

function isAbsolutePath(path: string | undefined): boolean {
  if (!path) return false
  if (path.startsWith('/')) return true
  return /^[A-Za-z]:[\\/]/.test(path)
}

/**
 * Build the transcript badges that stand in for attachment tokens.
 *
 * `UserMessageBubble` renders `ContentBadge`s by slicing `content` at
 * `start`/`end`, which is exactly what keeps the raw `[attachment:…]` out of the
 * bubble while the stored message (and therefore the model context) keeps the
 * token. File badges are already clickable when `filePath` is set, so real disk
 * files open in the app preview; synthetic paths (pasted text) stay inert.
 */
export function buildAttachmentBadges(
  text: string,
  attachments: readonly AttachmentTokenTarget[] | undefined | null,
): ContentBadge[] {
  if (!text || !attachments?.length) return []

  return resolveAttachmentTokens(text, attachments).map(({ token, attachment }) => {
    const realPath = isAbsolutePath(attachment.path)
      ? attachment.path
      : isAbsolutePath(attachment.storedPath)
        ? attachment.storedPath
        : undefined

    return {
      type: 'file',
      label: attachment.name,
      rawText: token.raw,
      start: token.start,
      end: token.end,
      ...(realPath ? { filePath: realPath } : {}),
    }
  })
}
