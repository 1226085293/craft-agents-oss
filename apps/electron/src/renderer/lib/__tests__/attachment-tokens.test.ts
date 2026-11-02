/**
 * Tests for the inline attachment token grammar.
 *
 * The token is the only thing that carries "which attachment belongs to which
 * part of the message" into the model context, so the round-trip rules
 * (serialize → parse → resolve → filter) are pinned down here.
 */
import { describe, it, expect } from 'bun:test'
import {
  attachmentTokenKey,
  attachmentTokenKeyOf,
  buildAttachmentBadges,
  ensureAttachmentTokens,
  filterAttachmentsByTokens,
  findAttachmentForToken,
  findAttachmentTokens,
  formatAttachmentToken,
  hasAttachmentToken,
  resolveAttachmentTokens,
} from '../attachment-tokens'

const pdf = { name: 'report.pdf', path: '/Users/me/report.pdf' }
const md = { name: 'draft.md', path: 'C:\\docs\\draft.md' }

describe('attachmentTokenKey', () => {
  it('keeps ordinary filenames intact', () => {
    expect(attachmentTokenKey('report.pdf')).toBe('report.pdf')
  })

  it('neutralizes characters that would break the token grammar', () => {
    expect(attachmentTokenKey('weird[name]\nfile.txt')).toBe('weird name file.txt')
  })

  it('trims and collapses whitespace', () => {
    expect(attachmentTokenKey('  my   file .txt  ')).toBe('my file .txt')
  })

  it('falls back for empty names', () => {
    expect(attachmentTokenKey('')).toBe('file')
    expect(attachmentTokenKey(undefined)).toBe('file')
  })

  it('is applied to both sides so serialization and lookup agree', () => {
    const token = formatAttachmentToken('weird[name].txt')
    expect(attachmentTokenKeyOf(token)).toBe(attachmentTokenKey('weird[name].txt'))
  })
})

describe('findAttachmentTokens', () => {
  it('finds tokens with positions', () => {
    const text = 'a [attachment:report.pdf] b'
    const tokens = findAttachmentTokens(text)
    expect(tokens).toHaveLength(1)
    expect(tokens[0].raw).toBe('[attachment:report.pdf]')
    expect(text.slice(tokens[0].start, tokens[0].end)).toBe('[attachment:report.pdf]')
  })

  it('ignores unrelated bracket tokens', () => {
    expect(findAttachmentTokens('[file:/tmp/x.txt] [skill:commit] should not match')).toHaveLength(0)
    expect(hasAttachmentToken('[file:/tmp/x.txt]')).toBe(false)
  })

  it('does not match across newlines', () => {
    expect(findAttachmentTokens('[attachment:broken\nname.txt]')).toHaveLength(0)
  })
})

describe('resolveAttachmentTokens', () => {
  it('pairs tokens with attachments in order', () => {
    const text = 'compare [attachment:report.pdf] and [attachment:draft.md]'
    const resolved = resolveAttachmentTokens(text, [pdf, md])
    expect(resolved.map(entry => entry.attachment.name)).toEqual(['report.pdf', 'draft.md'])
  })

  it('treats duplicate names as a multiset', () => {
    const first = { name: 'shot.png', path: '/a/shot.png' }
    const second = { name: 'shot.png', path: '/b/shot.png' }
    const resolved = resolveAttachmentTokens('[attachment:shot.png] [attachment:shot.png]', [first, second])
    expect(resolved.map(entry => entry.attachment.path)).toEqual(['/a/shot.png', '/b/shot.png'])
  })

  it('drops hand-typed tokens that point at no attachment', () => {
    const resolved = resolveAttachmentTokens('[attachment:missing.txt]', [pdf])
    expect(resolved).toHaveLength(0)
  })

  it('matches a stored-filename token to an attachment by its storedPath basename', () => {
    // After send, the token carries the stored name but the attachment's display
    // `name` stays the original — resolution must fall back to the storedPath.
    const stored = { name: 'pasted-image-1.png', storedPath: '/session/attachments/c918c4_pasted-image-1.png' }
    const resolved = resolveAttachmentTokens('[attachment:c918c4_pasted-image-1.png]', [stored])
    expect(resolved.map(entry => entry.attachment.name)).toEqual(['pasted-image-1.png'])
  })

  it('does not consume the same attachment twice via name and storedPath keys', () => {
    const stored = { name: 'pasted-image-1.png', storedPath: '/session/attachments/c918c4_pasted-image-1.png' }
    // One token in each form; the attachment should resolve exactly once.
    const resolved = resolveAttachmentTokens(
      '[attachment:pasted-image-1.png] [attachment:c918c4_pasted-image-1.png]',
      [stored],
    )
    expect(resolved).toHaveLength(1)
  })
})

describe('filterAttachmentsByTokens', () => {
  it('drops attachments whose chip was deleted', () => {
    const kept = filterAttachmentsByTokens([pdf, md], 'only [attachment:report.pdf] left')
    expect(kept.map(a => a.name)).toEqual(['report.pdf'])
  })

  it('returns the same instance when nothing changed', () => {
    const input = [pdf, md]
    const result = filterAttachmentsByTokens(input, '[attachment:report.pdf] [attachment:draft.md]')
    expect(result).toBe(input)
  })

  it('keeps duplicates only while tokens remain', () => {
    const first = { name: 'shot.png' }
    const second = { name: 'shot.png' }
    const kept = filterAttachmentsByTokens([first, second], '[attachment:shot.png]')
    expect(kept).toHaveLength(1)
    expect(kept[0]).toBe(first)
  })

  it('drops everything when the text has no tokens', () => {
    expect(filterAttachmentsByTokens([pdf], 'plain text')).toHaveLength(0)
  })
})

describe('ensureAttachmentTokens', () => {
  it('appends tokens for legacy attachments', () => {
    expect(ensureAttachmentTokens('old draft text', [pdf])).toBe('old draft text [attachment:report.pdf]')
  })

  it('does not duplicate tokens that already exist', () => {
    const text = 'before [attachment:report.pdf] after'
    expect(ensureAttachmentTokens(text, [pdf])).toBe(text)
  })

  it('adds only the missing ones', () => {
    const text = '[attachment:report.pdf] and words'
    expect(ensureAttachmentTokens(text, [pdf, md])).toBe('[attachment:report.pdf] and words [attachment:draft.md]')
  })

  it('builds a token-only body when the text is empty', () => {
    expect(ensureAttachmentTokens('', [pdf])).toBe('[attachment:report.pdf]')
  })

  it('stays idempotent', () => {
    const once = ensureAttachmentTokens('', [pdf, md])
    expect(ensureAttachmentTokens(once, [pdf, md])).toBe(once)
  })
})

describe('findAttachmentForToken', () => {
  it('resolves by sanitized name', () => {
    expect(findAttachmentForToken([pdf], '[attachment:report.pdf]')).toBe(pdf)
  })

  it('returns undefined for unknown tokens', () => {
    expect(findAttachmentForToken([pdf], '[attachment:nope.txt]')).toBeUndefined()
    expect(findAttachmentForToken([pdf], null)).toBeUndefined()
  })
})

describe('buildAttachmentBadges', () => {
  it('produces file badges at the token positions', () => {
    const text = 'see [attachment:report.pdf] for details'
    const badges = buildAttachmentBadges(text, [pdf])
    expect(badges).toHaveLength(1)
    expect(badges[0]).toMatchObject({
      type: 'file',
      label: 'report.pdf',
      rawText: '[attachment:report.pdf]',
      filePath: '/Users/me/report.pdf',
    })
    expect(text.slice(badges[0].start, badges[0].end)).toBe('[attachment:report.pdf]')
  })

  it('marks windows absolute paths as clickable', () => {
    const badges = buildAttachmentBadges('[attachment:draft.md]', [md])
    expect(badges[0].filePath).toBe('C:\\docs\\draft.md')
  })

  it('leaves synthetic paths inert', () => {
    const pasted = { name: 'pasted-text-1.txt', path: 'pasted-text-1.txt' }
    const badges = buildAttachmentBadges('[attachment:pasted-text-1.txt]', [pasted])
    expect(badges[0].filePath).toBeUndefined()
  })

  it('falls back to storedPath once the file is copied into the session', () => {
    const stored = { name: 'report.pdf', path: '/tmp/report.pdf', storedPath: '/session/attachments/report.pdf' }
    const badges = buildAttachmentBadges('[attachment:report.pdf]', [stored])
    expect(badges[0].filePath).toBe('/tmp/report.pdf')
    const onlyStored = { name: 'report.pdf', storedPath: '/session/attachments/report.pdf' }
    expect(buildAttachmentBadges('[attachment:report.pdf]', [onlyStored])[0].filePath)
      .toBe('/session/attachments/report.pdf')
  })

  it('returns nothing when there is no text or no attachment', () => {
    expect(buildAttachmentBadges('', [pdf])).toEqual([])
    expect(buildAttachmentBadges('[attachment:report.pdf]', [])).toEqual([])
  })
})
