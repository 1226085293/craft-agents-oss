import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { WaitForCooldownFields } from '../WaitForCooldownFields'
import { waitForCooldownDraftFromConfig } from '../waitForCooldownSettings'

function renderFields(enabled: boolean, invalid = false): string {
  return renderToStaticMarkup(createElement(WaitForCooldownFields, {
    draft: { ...waitForCooldownDraftFromConfig(), enabled },
    onChange: () => {},
    ...(invalid ? { invalid: true } : {}),
  }))
}

describe('waitForCooldown field visibility', () => {
  it('shows no seconds input while disabled', () => {
    const html = renderFields(false)
    expect(html).not.toContain('最长等待 · 秒')
    expect(html).not.toContain('type="number"')
    expect(html).toContain('等待冷却后重试')
  })

  it('shows exactly one seconds input when enabled', () => {
    const html = renderFields(true)
    expect(html.match(/aria-label="最长等待 · 秒"/g)).toHaveLength(1)
    expect(html.indexOf('等待冷却后重试')).toBeLessThan(html.indexOf('最长等待 · 秒'))
    expect(html).toContain('配额级冷却')
  })

  it('shows the invalid hint when the draft is invalid', () => {
    const html = renderFields(true, true)
    expect(html).toContain('最长等待必须为 1 到 540 秒的整数')
  })
})
