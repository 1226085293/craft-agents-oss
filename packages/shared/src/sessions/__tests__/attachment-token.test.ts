import { describe, it, expect } from 'bun:test'
import {
  attachmentTokenKey,
  formatAttachmentToken,
  rewriteAttachmentNameTokens,
} from '../attachment-token'

describe('rewriteAttachmentNameTokens', () => {
  it('returns empty string for null/undefined/empty text', () => {
    expect(rewriteAttachmentNameTokens(null, new Map())).toBe('')
    expect(rewriteAttachmentNameTokens(undefined, new Map())).toBe('')
    expect(rewriteAttachmentNameTokens('', new Map())).toBe('')
  })

  it('leaves text untouched when the rename map is empty', () => {
    const text = 'compare [attachment:report.pdf] and [attachment:draft.md]'
    expect(rewriteAttachmentNameTokens(text, new Map())).toBe(text)
  })

  it('rewrites a token whose key is in the map', () => {
    const text = 'look at [attachment:pasted-image-1.png]'
    const renames = new Map([['pasted-image-1.png', 'a1b2c3_pasted-image-1.png']])
    expect(rewriteAttachmentNameTokens(text, renames)).toBe(
      'look at [attachment:a1b2c3_pasted-image-1.png]',
    )
  })

  it('rewrites multiple distinct tokens in order', () => {
    const text = 'A [attachment:one.png] and B [attachment:two.png]'
    const renames = new Map([
      ['one.png', 'aaaaaa_one.png'],
      ['two.png', 'bbbbbb_two.png'],
    ])
    expect(rewriteAttachmentNameTokens(text, renames)).toBe(
      'A [attachment:aaaaaa_one.png] and B [attachment:bbbbbb_two.png]',
    )
  })

  it('leaves tokens whose key is not in the map untouched', () => {
    const text = 'keep [attachment:unknown.png] and [attachment:known.png]'
    const renames = new Map([['known.png', 'aaaaaa_known.png']])
    expect(rewriteAttachmentNameTokens(text, renames)).toBe(
      'keep [attachment:unknown.png] and [attachment:aaaaaa_known.png]',
    )
  })

  it('matches on the sanitized key, not the raw inner text', () => {
    // The renderer sanitizes both the token and the lookup name, so a name with
    // brackets in it normalizes to the same key on both sides.
    const text = `see ${formatAttachmentToken('weird [name].png')}`
    const renames = new Map([[attachmentTokenKey('weird [name].png'), 'aaaaaa_weird_name.png']])
    expect(rewriteAttachmentNameTokens(text, renames)).toBe(
      'see [attachment:aaaaaa_weird_name.png]',
    )
  })

  it('does not rewrite the same token twice (idempotent for already-stored names)', () => {
    // Once a token already carries the stored name, a second pass with the
    // original→stored map must not touch it (the key no longer matches).
    const text = 'see [attachment:a1b2c3_pasted-image-1.png]'
    const renames = new Map([['pasted-image-1.png', 'a1b2c3_pasted-image-1.png']])
    expect(rewriteAttachmentNameTokens(text, renames)).toBe(text)
  })
})
