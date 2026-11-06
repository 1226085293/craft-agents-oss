import { describe, it, expect, beforeEach } from 'bun:test'
import {
  DAILY_LIMIT,
  EventMerger,
  checkQuota,
  formatEventNudge,
  formatMergedNudge,
  loadSubscriptions,
  matchesFilter,
  recordDelivery,
  resetQuotas,
  saveSubscriptions,
  subscribersFor,
  type EventSubscription,
} from './subscriptions.ts'
import type { EventMeta } from './event-store.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function event(overrides: Partial<EventMeta> = {}): EventMeta {
  return {
    spec: 'craft-event/1',
    id: 'evt_1',
    source: 'qqmail',
    type: 'mail.received',
    receivedAt: 1_800_000_000_000,
    title: '张三 · 合同确认',
    summary: '请确认付款条款',
    recipients: ['me@qq.com'],
    links: [],
    attachments: [],
    delivered: false,
    deliveries: [],
    routing: [],
    ...overrides,
  }
}

describe('matchesFilter', () => {
  it('matches everything when the filter is empty', () => {
    expect(matchesFilter(event(), {})).toBe(true)
  })

  it('filters by source, exact type and type prefix', () => {
    expect(matchesFilter(event(), { sources: ['qqmail'] })).toBe(true)
    expect(matchesFilter(event(), { sources: ['github'] })).toBe(false)
    expect(matchesFilter(event(), { types: ['mail.received'] })).toBe(true)
    expect(matchesFilter(event(), { types: ['mail.*'] })).toBe(true)
    expect(matchesFilter(event(), { types: ['github.*'] })).toBe(false)
  })

  it('ANDs across filter fields', () => {
    expect(matchesFilter(event(), { sources: ['qqmail'], types: ['mail.*'] })).toBe(true)
    expect(matchesFilter(event(), { sources: ['qqmail'], types: ['github.*'] })).toBe(false)
  })
})

describe('subscribersFor', () => {
  const subscription = (sessionId: string, filter: Partial<EventSubscription['filter']>): EventSubscription => ({
    subscriptionId: `sub_${sessionId}`,
    sessionId,
    filter,
    createdAt: 0,
  })

  it('dedupes a session with two matching subscriptions', () => {
    const subs = [subscription('s1', { sources: ['qqmail'] }), subscription('s1', {})]
    expect(subscribersFor(event(), subs)).toEqual(['s1'])
  })

  it('returns only matching sessions', () => {
    const subs = [subscription('s1', { types: ['mail.*'] }), subscription('s2', { types: ['github.*'] })]
    expect(subscribersFor(event(), subs)).toEqual(['s1'])
  })
})

describe('nudge formatting', () => {
  it('keeps a single event to four short lines with a get_event pointer', () => {
    const text = formatEventNudge(event())
    const lines = text.split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[0]).toContain('[event] mail.received')
    expect(lines[3]).toContain('get_event("evt_1")')
  })

  it('merges several events with a count and a hint', () => {
    const events = Array.from({ length: 7 }, (_, i) =>
      event({ id: `evt_${i}`, title: `事件 ${i}` }),
    )
    const text = formatMergedNudge(events)
    expect(text).toContain('7 条新事件')
    expect(text).toContain('还有 2 条')
    expect(text).toContain('list_events')
  })
})

describe('quota', () => {
  beforeEach(() => resetQuotas())

  it('allows up to the daily limit, then sends one summary, then stops', () => {
    for (let i = 0; i < DAILY_LIMIT; i += 1) {
      expect(checkQuota('s1').allowed).toBe(true)
      recordDelivery('s1')
    }
    expect(checkQuota('s1')).toEqual({ allowed: true, sendSummary: true })
    expect(checkQuota('s1')).toEqual({ allowed: false, sendSummary: false })
  })

  it('tracks sessions independently', () => {
    for (let i = 0; i < DAILY_LIMIT; i += 1) {
      recordDelivery('s1')
    }
    expect(checkQuota('s1').sendSummary).toBe(true)
    expect(checkQuota('s2').allowed).toBe(true)
    expect(checkQuota('s2').sendSummary).toBe(false)
  })
})

describe('EventMerger', () => {
  it('coalesces events from one source inside the window', async () => {
    const flushed: Array<{ sessionId: string; count: number }> = []
    const merger = new EventMerger((sessionId, events) => flushed.push({ sessionId, count: events.length }), 30)
    merger.push('s1', event({ id: 'a' }))
    merger.push('s1', event({ id: 'b' }))
    merger.push('s1', event({ id: 'c' }))
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(flushed).toEqual([{ sessionId: 's1', count: 3 }])
    merger.flushAll()
  })

  it('keeps different sources in separate windows', async () => {
    const flushed: Array<{ sessionId: string; count: number }> = []
    const merger = new EventMerger((sessionId, events) => flushed.push({ sessionId, count: events.length }), 30)
    merger.push('s1', event({ source: 'qqmail' }))
    merger.push('s1', event({ source: 'github' }))
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(flushed).toHaveLength(2)
    merger.flushAll()
  })
})

describe('subscription persistence', () => {
  it('round-trips through the workspace config file', () => {
    const root = mkdtempSync(join(tmpdir(), 'craft-events-subs-'))
    try {
      expect(loadSubscriptions(root)).toEqual([])
      const subs: EventSubscription[] = [
        { subscriptionId: 'sub_1', sessionId: 's1', filter: { types: ['mail.*'] }, createdAt: 1 },
      ]
      saveSubscriptions(root, subs)
      expect(loadSubscriptions(root)).toEqual(subs)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
