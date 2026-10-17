import { describe, it, expect } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import { classifyMarkdownLinkTarget, resolveMarkdownLinkTarget } from '../link-target'
import { markdownUrlTransform } from '../url-transform'

describe('resolveMarkdownLinkTarget', () => {
  it('resolves absolute unix file paths as file targets', () => {
    expect(resolveMarkdownLinkTarget('/Users/balintorosz/.craft-agent/sessions/abc/image.jpg')).toEqual({
      kind: 'file',
      path: '/Users/balintorosz/.craft-agent/sessions/abc/image.jpg',
    })
  })

  it('resolves parent-relative file paths as file targets', () => {
    expect(resolveMarkdownLinkTarget('../downloads/assets/screenshot.png')).toEqual({
      kind: 'file',
      path: '../downloads/assets/screenshot.png',
    })
  })

  it('resolves repo-relative file paths as file targets', () => {
    expect(resolveMarkdownLinkTarget('apps/electron/resources/docs/browser-tools.md')).toEqual({
      kind: 'file',
      path: 'apps/electron/resources/docs/browser-tools.md',
    })
  })

  it('resolves unix file URLs as file targets', () => {
    expect(resolveMarkdownLinkTarget('file:///Users/tester/report.xlsx')).toEqual({
      kind: 'file',
      path: '/Users/tester/report.xlsx',
    })
  })

  it('decodes percent-encoded unix file URLs', () => {
    expect(resolveMarkdownLinkTarget('file:///Users/tester/report%20final.pdf')).toEqual({
      kind: 'file',
      path: '/Users/tester/report final.pdf',
    })
  })

  it('decodes a percent-encoded space in a BARE local file path (#944)', () => {
    expect(resolveMarkdownLinkTarget('/Users/tester/My%20Docs/report%20final.pptx')).toEqual({
      kind: 'file',
      path: '/Users/tester/My Docs/report final.pptx',
    })
  })

  it('leaves a bare path with an invalid percent-sequence untouched (#944)', () => {
    expect(resolveMarkdownLinkTarget('/Users/tester/100%done/notes.md')).toEqual({
      kind: 'file',
      path: '/Users/tester/100%done/notes.md',
    })
  })

  it('normalizes windows drive-letter file URLs to native paths', () => {
    expect(resolveMarkdownLinkTarget('file:///C:/Users/Tester/Deck.pptx')).toEqual({
      kind: 'file',
      path: 'C:\\Users\\Tester\\Deck.pptx',
    })
  })

  it('normalizes bare forward-slash Windows drive paths to native backslashes', () => {
    expect(resolveMarkdownLinkTarget('C:/Users/Tester/docs/report.md')).toEqual({
      kind: 'file',
      path: 'C:\\Users\\Tester\\docs\\report.md',
    })
  })

  it('normalizes mixed-separator Windows paths (forward dir + backslash subpath)', () => {
    // The legacy jsonl expansion produced `C:/.../dir\plans\x.md` — must still
    // resolve to a native path instead of being misrouted or failing on disk.
    expect(
      resolveMarkdownLinkTarget('C:/Users/12260/.craft-agent/sessions/s/plans/llm-management-redesign.md')
    ).toEqual({
      kind: 'file',
      path: 'C:\\Users\\12260\\.craft-agent\\sessions\\s\\plans\\llm-management-redesign.md',
    })
  })

  it('leaves all-backslash Windows paths untouched', () => {
    expect(resolveMarkdownLinkTarget('C:\\Users\\Tester\\a.md')).toEqual({
      kind: 'file',
      path: 'C:\\Users\\Tester\\a.md',
    })
  })

  it('does not touch UNC paths or unix paths', () => {
    expect(resolveMarkdownLinkTarget('\\\\server\\share\\file.md')).toEqual({
      kind: 'file',
      path: '\\\\server\\share\\file.md',
    })
    expect(resolveMarkdownLinkTarget('/home/u/x.md')).toEqual({
      kind: 'file',
      path: '/home/u/x.md',
    })
  })

  it('resolves percent-encoded Windows drive paths (Chromium-serialized DOM hrefs)', () => {
    // When a bare `C:\\...` href reaches the DOM, Chromium serializes it as a
    // relative URL with a `c:` scheme — percent-encoding every backslash to
    // `%5C`. The click handler must recognize that form and route it back to
    // the real on-disk file instead of shell.openExternal (which fails with
    // "系统找不到指定的文件" on the encoded string).
    expect(
      resolveMarkdownLinkTarget(
        'C:%5CUsers%5C12260%5C.craft-agent%5Csessions%5Cs%5Cplans%5Cllm-management-redesign.md'
      )
    ).toEqual({
      kind: 'file',
      path: 'C:\\Users\\12260\\.craft-agent\\sessions\\s\\plans\\llm-management-redesign.md',
    })
  })

  it('resolves percent-encoded forward-slash drive paths', () => {
    expect(resolveMarkdownLinkTarget('C:%2FUsers%2FTester%2Fdeck.pptx')).toEqual({
      kind: 'file',
      path: 'C:\\Users\\Tester\\deck.pptx',
    })
  })

  it('resolves https links as url targets', () => {
    expect(resolveMarkdownLinkTarget('https://example.com/image.jpg')).toEqual({
      kind: 'url',
      url: 'https://example.com/image.jpg',
    })
  })

  it('resolves mailto links as url targets', () => {
    expect(resolveMarkdownLinkTarget('mailto:test@example.com')).toEqual({
      kind: 'url',
      url: 'mailto:test@example.com',
    })
  })
})

describe('markdownUrlTransform', () => {
  it('preserves dangerous anchor hrefs for custom click routing', () => {
    const anchorNode = { tagName: 'a' }
    expect(markdownUrlTransform('file:///tmp/test.md', 'href', anchorNode as never)).toBe('file:///tmp/test.md')
    expect(markdownUrlTransform('javascript:alert(1)', 'href', anchorNode as never)).toBe('javascript:alert(1)')
  })

  it('still sanitizes dangerous non-anchor URL attributes', () => {
    const imageNode = { tagName: 'img' }
    expect(markdownUrlTransform('javascript:alert(1)', 'src', imageNode as never)).toBe('')
  })

  it('keeps safe anchor hrefs unchanged', () => {
    const anchorNode = { tagName: 'a' }
    expect(markdownUrlTransform('https://example.com', 'href', anchorNode as never)).toBe('https://example.com')
  })
})

describe('ReactMarkdown anchor rendering with markdownUrlTransform', () => {
  function render(markdown: string): string {
    return renderToStaticMarkup(React.createElement(ReactMarkdown, {
      urlTransform: markdownUrlTransform,
      components: {
        a: ({ href, children }) => React.createElement('a', {
          href: href ? defaultUrlTransform(href) || undefined : undefined,
          'data-raw-href': href,
        }, children),
      },
      children: markdown,
    }))
  }

  it('lets file links reach the custom anchor while keeping the DOM href sanitized', () => {
    const html = render('[report](file:///Users/tester/report.pdf)')
    expect(html).toContain('data-raw-href="file:///Users/tester/report.pdf"')
    expect(html).not.toContain('<a href="file:///Users/tester/report.pdf"')
  })

  it('lets javascript links reach the custom anchor while keeping the DOM href sanitized', () => {
    const html = render('[boom](javascript:alert(1))')
    expect(html).toContain('data-raw-href="javascript:alert(1)"')
    expect(html).not.toContain('<a href="javascript:alert')
  })

  it('keeps safe web links in the DOM href for normal browser affordances', () => {
    const html = render('[site](https://example.com/path)')
    expect(html).toContain('href="https://example.com/path"')
  })
})

describe('classifyMarkdownLinkTarget', () => {
  it('classifies absolute unix file paths as file', () => {
    expect(classifyMarkdownLinkTarget('/Users/balintorosz/.craft-agent/sessions/abc/image.jpg')).toBe('file')
  })

  it('classifies file URLs as file', () => {
    expect(classifyMarkdownLinkTarget('file:///Users/tester/report.xlsx')).toBe('file')
  })

  it('classifies https links as url', () => {
    expect(classifyMarkdownLinkTarget('https://example.com/image.jpg')).toBe('url')
  })

  it('classifies mailto links as url', () => {
    expect(classifyMarkdownLinkTarget('mailto:test@example.com')).toBe('url')
  })
})
