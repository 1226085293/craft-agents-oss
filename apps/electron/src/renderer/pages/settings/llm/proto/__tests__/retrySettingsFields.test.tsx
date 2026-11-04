import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { RetrySettingsFields } from '../RetrySettingsFields'
import { retryDraftFromConfig } from '../retrySettings'

function renderFields(maxAttempts: 1 | 2 | 3 | 4 | 5 | 'unlimited', intervalMode: 'fixed' | 'exponential' = 'fixed'): string {
  return renderToStaticMarkup(createElement(RetrySettingsFields, {
    draft: { ...retryDraftFromConfig(), maxAttempts, intervalMode },
    onChange: () => {},
  }))
}

describe('retry settings field visibility and order', () => {
  it('shows no duration box for finite attempts', () => {
    const html = renderFields(3)
    expect(html).not.toContain('单目标时限')
    expect(html.match(/type="number"/g)).toHaveLength(1)
  })

  it('hides the whole interval field when attempts is 1 (no retry, no interval)', () => {
    const html = renderFields(1)
    expect(html).not.toContain('尝试间隔')
    expect(html).not.toContain('固定间隔')
    expect(html).not.toContain('重试间隔 · 秒')
  })

  it('shows exactly one duration box directly after attempts and before interval', () => {
    const html = renderFields('unlimited')
    expect(html.match(/aria-label="单目标时限 · 秒"/g)).toHaveLength(1)
    expect(html.indexOf('尝试次数')).toBeLessThan(html.indexOf('单目标时限'))
    expect(html.indexOf('单目标时限')).toBeLessThan(html.indexOf('尝试间隔'))
    expect(html).toContain('notice amber')
  })

  it('does not show the fixed seconds input in exponential mode', () => {
    const html = renderFields(3, 'exponential')
    expect(html).not.toContain('重试间隔 · 秒')
    expect(html).toContain('默认 1、2、4、8、16、30… 秒（退避基数最高 30 秒）')
  })
})
