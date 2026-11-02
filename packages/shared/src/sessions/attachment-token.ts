/**
 * Inline attachment tokens (`[attachment:name]`).
 *
 * The renderer serializes staged attachments into the composer text as
 * `[attachment:<name>]` tokens; the server keeps them in the stored message so
 * the model knows which file a segment belongs to. This module is the single
 * source of truth for the token grammar so that the renderer (which writes
 * tokens) and the server (which rewrites them to stored filenames) always
 * agree on how a filename maps to a token key.
 */

/** Token prefix — callers can cheap-check a string with this. */
export const ATTACHMENT_TOKEN_PREFIX = '[attachment:'

/** Filenames longer than this are truncated inside the token. */
export const MAX_ATTACHMENT_TOKEN_KEY_LENGTH = 120

export interface AttachmentTokenMatch {
  /** Sanitized attachment name (the token key). */
  key: string
  /** Full token text, e.g. `[attachment:report.pdf]`. */
  raw: string
  /** Start offset in the source text (inclusive). */
  start: number
  /** End offset in the source text (exclusive). */
  end: number
}

/**
 * Normalize a filename into a token key.
 *
 * Applied to BOTH the serialized token and the lookup name, so the two always
 * agree even when the original filename contains `[`, `]`, newlines or runs of
 * whitespace (all of which would otherwise corrupt the `[attachment:...]`
 * grammar). Falls back to `file` for names that normalize to nothing.
 */
export function attachmentTokenKey(name: string | undefined | null): string {
  const cleaned = (name ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ATTACHMENT_TOKEN_KEY_LENGTH)
    .trim()
  return cleaned || 'file'
}

/** Serialize an attachment name into its inline token. */
export function formatAttachmentToken(name: string | undefined | null): string {
  return `${ATTACHMENT_TOKEN_PREFIX}${attachmentTokenKey(name)}]`
}

/** Find every attachment token in `text`, in order. */
export function findAttachmentTokens(text: string | undefined | null): AttachmentTokenMatch[] {
  if (!text) return []
  const pattern = /\[attachment:([^\]\n]+)\]/g
  const matches: AttachmentTokenMatch[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    matches.push({
      key: attachmentTokenKey(match[1]),
      raw: match[0],
      start: match.index,
      end: match.index + match[0].length,
    })
  }
  return matches
}

/**
 * Rewrite inline attachment tokens using a key→key rename map.
 *
 * Used at send time: after an attachment is persisted under its stored
 * filename (`a1b2c3_pasted-image-1.png`), the token in the message text is
 * rewritten from the original name (`[attachment:pasted-image-1.png]`) to the
 * stored name so the model can resolve it uniquely. Tokens whose key is not in
 * the map are left untouched.
 */
export function rewriteAttachmentNameTokens(
  text: string | undefined | null,
  renames: ReadonlyMap<string, string>,
): string {
  if (!text || renames.size === 0) return text ?? ''
  return text.replace(/\[attachment:([^\]\n]+)\]/g, (raw, inner: string) => {
    const key = attachmentTokenKey(inner)
    const to = renames.get(key)
    if (to === undefined) return raw
    return `${ATTACHMENT_TOKEN_PREFIX}${to}]`
  })
}
