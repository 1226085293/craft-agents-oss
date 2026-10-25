/**
 * Key-line parsing. This decides whether a pasted credential survives, so the
 * rules are pinned here rather than being eyeballed in the dialog.
 */

import { describe, test, expect } from 'bun:test'
import { parseKeyLine, parseKeyBlock } from '../keyParser'

describe('parseKeyLine — delimited form 类型|apikey|备注', () => {
  test('all three fields', () => {
    expect(parseKeyLine('premium|sk-abc123def456|备用')).toEqual({
      key: 'sk-abc123def456',
      preset: 'premium',
      note: '备用',
    })
  })

  test('type and key, no note', () => {
    expect(parseKeyLine('fast|sk-abc123def456')).toEqual({
      key: 'sk-abc123def456',
      preset: 'fast',
      note: '',
    })
  })

  test('a bare key line stays a bare key', () => {
    expect(parseKeyLine('sk-abc123def456')).toEqual({ key: 'sk-abc123def456', preset: '', note: '' })
  })

  test('a note containing a pipe is kept intact', () => {
    const parsed = parseKeyLine('premium|sk-abc123def456|主|备用')
    expect(parsed?.key).toBe('sk-abc123def456')
    expect(parsed?.note).toBe('主|备用')
  })

  test('empty segments yield empty fields, not junk', () => {
    const parsed = parseKeyLine('|sk-abc123def456|')
    expect(parsed?.key).toBe('sk-abc123def456')
    expect(parsed?.preset).toBe('')
    expect(parsed?.note).toBe('')
  })

  test('a colon inside the key survives (why pipes replaced colons)', () => {
    expect(parseKeyLine('sk-abc:def:ghi123456')?.key).toBe('sk-abc:def:ghi123456')
  })
})

describe('parseKeyLine — messy input is rescued by the key scan', () => {
  test('a prefixed key with no delimiter: "XXX-sk-r4xxxx"', () => {
    const parsed = parseKeyLine('XXX-sk-r4abcdef123456')
    expect(parsed?.key).toBe('sk-r4abcdef123456')
    expect(parsed?.preset).toBe('')
    expect(parsed?.note).toBe('')
  })

  test('Chinese label glued on: "主key：sk-xxx"', () => {
    expect(parseKeyLine('主key：sk-abcdef123456')?.key).toBe('sk-abcdef123456')
  })

  test('quoted key', () => {
    expect(parseKeyLine('"sk-abcdef123456"')?.key).toBe('sk-abcdef123456')
  })

  test('a first field that itself looks like a key is not treated as a type', () => {
    // "XXX-sk-r4abcdef123456|备注" — the head carries the key, so it is one
    // messy line with a note, not a type plus a key.
    const parsed = parseKeyLine('XXX-sk-r4abcdef123456|备注')
    expect(parsed?.key).toBe('sk-r4abcdef123456')
    expect(parsed?.preset).toBe('')
  })

  test('a long opaque token with no sk- prefix is still a key', () => {
    expect(parseKeyLine('a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6')?.key).toBe('a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6')
  })

  test('prose with no key at all is rejected', () => {
    expect(parseKeyLine('这是一个备注')).toBeNull()
    expect(parseKeyLine('hello')).toBeNull()
  })

  // The `sk-` prefix is itself the signal, so it carries no length floor.
  // This used to be rejected, which also rejected `sk-xx` — the placeholder a
  // local relay that ignores the key still needs. A short *unprefixed* token is
  // still prose (see the next test); only the prefix buys the short form.
  test('a short sk- key is accepted — the prefix is the signal', () => {
    expect(parseKeyLine('sk-abc')?.key).toBe('sk-abc')
    expect(parseKeyLine('sk-xx')?.key).toBe('sk-xx')
  })

  test('a short unprefixed token is still prose', () => {
    expect(parseKeyLine('hello')).toBeNull()
    expect(parseKeyLine('premium')).toBeNull()
  })

  // A single line typed into the key box is taken at face value: a relay that
  // does not authenticate needs a placeholder, and length cannot tell `local`
  // from `premium`. Only the single-line case gets this — in a multi-line
  // paste a line that matches nothing really is prose.
  test('a lone line is the key, however short and un-prefixed', () => {
    expect(parseKeyBlock('sk-xx').map((r) => r.key)).toEqual(['sk-xx'])
    expect(parseKeyBlock('local').map((r) => r.key)).toEqual(['local'])
  })

  test('but a lone prose line is still refused', () => {
    expect(parseKeyBlock('这是一个备注')).toEqual([])
    expect(parseKeyBlock('随便写的一句话')).toEqual([])
  })

  test('whitespace-only line is rejected', () => {
    expect(parseKeyLine('   ')).toBeNull()
  })
})

describe('parseKeyBlock', () => {
  test('parses every line and drops the blank ones', () => {
    const rows = parseKeyBlock('sk-abcdef123456\n\npremium|sk-987654fedcba|备用\n')
    expect(rows).toHaveLength(2)
    expect(rows[0].key).toBe('sk-abcdef123456')
    expect(rows[1].preset).toBe('premium')
  })

  test('CRLF input works', () => {
    expect(parseKeyBlock('sk-abcdef123456\r\nsk-987654fedcba')).toHaveLength(2)
  })

  test('empty input yields nothing', () => {
    expect(parseKeyBlock('')).toEqual([])
  })

  test('a mixed paste keeps the usable lines only', () => {
    const rows = parseKeyBlock('随便写的一句话\nXXX-sk-r4abcdef123456\nsk-987654fedcba|主')
    expect(rows.map((r) => r.key)).toEqual(['sk-r4abcdef123456', 'sk-987654fedcba'])
  })
})
