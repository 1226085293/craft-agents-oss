import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { RetrySettingsFields } from '../RetrySettingsFields'
import { retryDraftFromConfig } from '../retrySettings'

function renderFields(
  maxAttempts: 1 | 2 | 3 | 4 | 5 | 'unlimited',
  intervalMode: 'fixed' | 'exponential' = 'fixed',
  timeLimitWarning?: string | null,
): string {
  return renderToStaticMarkup(createElement(RetrySettingsFields, {
    draft: { ...retryDraftFromConfig(), maxAttempts, intervalMode },
    onChange: () => {},
    timeLimitWarning,
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

  it('renders the time-limit warning under the input, after the explanation', () => {
    const html = renderFields('unlimited', 'fixed', '本组最慢的首字节超时是 30 秒（amd）：时限 ≤ 30 秒时一次超时就会耗尽预算')
    expect(html).toContain('本组最慢的首字节超时是 30 秒（amd）')
    // Order: input → 原有说明 → 警告，读起来先知道含义再看到具体数值。
    expect(html.indexOf('aria-label="单目标时限 · 秒"')).toBeLessThan(html.indexOf('可重试错误会在同一目标持续重试'))
    expect(html.indexOf('可重试错误会在同一目标持续重试')).toBeLessThan(html.indexOf('本组最慢的首字节超时'))
  })

  it('renders no warning when the limit is workable', () => {
    expect(renderFields('unlimited', 'fixed', null)).not.toContain('本组最慢的首字节超时')
    expect(renderFields('unlimited')).not.toContain('本组最慢的首字节超时')
  })

  it('never renders the warning for finite attempts (no time limit exists)', () => {
    const html = renderFields(3, 'fixed', '本组最慢的首字节超时是 30 秒（amd）')
    expect(html).not.toContain('本组最慢的首字节超时')
  })

  it('does not show the fixed seconds input in exponential mode', () => {
    const html = renderFields(3, 'exponential')
    expect(html).not.toContain('重试间隔 · 秒')
    expect(html).toContain('默认 1、2、4、8、16、30… 秒（退避基数最高 30 秒）')
  })
})
