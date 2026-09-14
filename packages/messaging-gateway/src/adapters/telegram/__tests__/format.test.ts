import { describe, expect, it } from 'bun:test'
import {
  escapeTelegramMarkdown,
  formatForTelegram,
  TELEGRAM_MAX_CAPTION_LENGTH,
} from '../format'

describe('formatForTelegram — inline styles', () => {
  it('renders bold with a single asterisk', () => {
    expect(formatForTelegram('**bold**')).toBe('*bold*')
  })

  it('renders italic with underscores regardless of source marker', () => {
    expect(formatForTelegram('*italic*')).toBe('_italic_')
    expect(formatForTelegram('_italic_')).toBe('_italic_')
  })

  it('renders bold+italic as nested entities', () => {
    expect(formatForTelegram('***both***')).toBe('*_both_*')
  })

  it('renders strikethrough with a single tilde', () => {
    expect(formatForTelegram('~~gone~~')).toBe('~gone~')
  })

  it('keeps inline code and leaves its contents unescaped', () => {
    expect(formatForTelegram('run `npm i -g .`')).toBe('run `npm i -g .`')
  })

  it('escapes special characters in plain text', () => {
    expect(formatForTelegram('a.b')).toBe('a\\.b')
    expect(formatForTelegram('2 * 3')).toBe('2 \\* 3')
  })
})

describe('formatForTelegram — links', () => {
  it('preserves links and only escapes the URL for MarkdownV2', () => {
    expect(formatForTelegram('[docs](https://a.com/b?c=1)')).toBe('[docs](https://a.com/b?c=1)')
  })

  it('escapes closing parens inside the URL without truncating it', () => {
    const out = formatForTelegram('[w](https://en.wikipedia.org/wiki/X_(y))')
    expect(out).toBe('[w](https://en.wikipedia.org/wiki/X_(y\\))')
  })

  it('escapes the label like normal text', () => {
    expect(formatForTelegram('[a.b](https://a.com)')).toBe('[a\\.b](https://a.com)')
  })
})

describe('formatForTelegram — blocks', () => {
  it('turns headings into bold', () => {
    expect(formatForTelegram('# Title')).toBe('*Title*')
    expect(formatForTelegram('## Sub ###')).toBe('*Sub*')
  })

  it('keeps fenced code verbatim', () => {
    const md = '```ts\nconst x = a.b;\n```'
    expect(formatForTelegram(md)).toBe('```ts\nconst x = a.b;\n```')
  })

  it('keeps blockquote markers', () => {
    expect(formatForTelegram('> quoted')).toBe('>quoted')
  })

  it('keeps list bullets as literal text', () => {
    expect(formatForTelegram('- one')).toBe('\\- one')
    expect(formatForTelegram('1. one')).toBe('1\\. one')
  })

  it('separates blocks with a blank line', () => {
    expect(formatForTelegram('one\n\ntwo')).toBe('one\n\ntwo')
  })
})

describe('formatForTelegram — streaming safety', () => {
  it('closes an unterminated code fence', () => {
    const out = formatForTelegram('```ts\nconst x = 1;')
    expect(out.startsWith('```ts\n')).toBe(true)
    expect(out.endsWith('```')).toBe(true)
  })

  it('emits unbalanced bold markers as escaped literals', () => {
    // Mid-stream flush: `**bo` must not produce an unclosed entity.
    expect(formatForTelegram('**bo')).toBe('\\*\\*bo')
  })

  it('leaves snake_case identifiers intact', () => {
    expect(formatForTelegram('use_snake_case')).toBe('use\\_snake\\_case')
  })

  it('never produces an odd number of spoiler markers', () => {
    const out = formatForTelegram('||hidden')
    expect(out.split('||').length % 2).toBe(1)
  })
})

describe('formatForTelegram — unsupported structures degrade gracefully', () => {
  it('renders task list checkboxes as glyphs', () => {
    expect(formatForTelegram('- [x] done')).toBe('\u2611 done')
    expect(formatForTelegram('- [ ] todo')).toBe('\u2610 todo')
  })

  it('keeps a checked item that carries inline styles', () => {
    expect(formatForTelegram('- [x] **done**')).toBe('\u2611 *done*')
  })

  it('lays a GFM table out in an aligned monospace block', () => {
    const md = ['| a | b |', '| --- | ---: |', '| 1 | 2 |'].join('\n')
    const out = formatForTelegram(md)
    expect(out.startsWith('```\n')).toBe(true)
    expect(out.endsWith('```')).toBe(true)
    expect(out).toContain('a  b')
    expect(out).toContain('1  2')
  })

  it('counts CJK cells as double width when padding', () => {
    const md = ['| 名称 | v |', '| --- | --- |', '| a | 1 |'].join('\n')
    const out = formatForTelegram(md)
    // "名称" is 4 monospace cells wide, so "a" is padded to match.
    expect(out).toContain('a     1')
  })

  it('does not treat a lone pipe line as a table', () => {
    expect(formatForTelegram('a | b')).toBe('a \\| b')
  })
})

describe('escapeTelegramMarkdown', () => {
  it('escapes every reserved MarkdownV2 character', () => {
    expect(escapeTelegramMarkdown('_')).toBe('\\_')
    expect(escapeTelegramMarkdown('!')).toBe('\\!')
  })
})

describe('caption budget', () => {
  it('exports Telegram caption limit', () => {
    expect(TELEGRAM_MAX_CAPTION_LENGTH).toBe(1024)
  })
})
