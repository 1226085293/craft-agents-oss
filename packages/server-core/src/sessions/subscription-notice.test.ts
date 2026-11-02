import { describe, expect, it } from 'bun:test'
import { buildSubscriptionNotice, SUBSCRIPTION_NOTICE_MAX_CHARS } from './subscription-notice.ts'

describe('buildSubscriptionNotice', () => {
  it('names the target and carries its answer verbatim', () => {
    const notice = buildSubscriptionNotice({ id: 'child-1', name: '调研' }, 'complete', '结论如下：A')
    expect(notice).toContain('[session-turn-complete]')
    expect(notice).toContain('"调研"')
    expect(notice).toContain('child-1')
    expect(notice).toContain('结论如下：A')
    expect(notice).toContain('Do not spawn a duplicate session')
  })

  it('marks failures as failures instead of claiming success', () => {
    const notice = buildSubscriptionNotice({ id: 'child-2' }, 'error', 'boom')
    expect(notice).toContain('[session-turn-error]')
    expect(notice).toContain('failed')
    expect(notice).toContain('Do not retry silently')
  })

  it('truncates long answers and points at the transcript', () => {
    const long = 'x'.repeat(SUBSCRIPTION_NOTICE_MAX_CHARS + 50)
    const notice = buildSubscriptionNotice({ id: 'child-3' }, 'complete', long)
    expect(notice).toContain('truncated')
    expect(notice).toContain('child-3')
    expect(notice.length).toBeLessThan(long.length + 500)
  })

  it('handles a turn with no text output', () => {
    const notice = buildSubscriptionNotice({ id: 'child-4' }, 'timeout', undefined)
    expect(notice).toContain('timed out')
    expect(notice).toContain('no text output')
  })
})
