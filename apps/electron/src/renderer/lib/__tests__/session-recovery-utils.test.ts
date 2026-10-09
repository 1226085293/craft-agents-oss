import { describe, it, expect } from 'bun:test'
import { hasRunningTool, preserveQueuedFlags } from '../session-recovery-utils'
import type { Message } from '../../../shared/types'

function toolMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'tool-1',
    role: 'tool',
    content: '',
    timestamp: 1000,
    toolStatus: 'executing',
    toolName: 'Bash',
    ...overrides,
  }
}

function userMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'user-1',
    role: 'user',
    content: 'hello',
    timestamp: 1000,
    ...overrides,
  }
}

describe('hasRunningTool', () => {
  it('returns true when a tool is still executing', () => {
    expect(hasRunningTool([toolMessage()])).toBe(true)
  })

  it('returns true when a tool is pending', () => {
    expect(hasRunningTool([toolMessage({ toolStatus: 'pending' })])).toBe(true)
  })

  it('returns false when all tools are terminal', () => {
    const messages = [
      toolMessage({ toolStatus: 'completed' }),
      toolMessage({ id: 'tool-2', toolStatus: 'error' }),
      toolMessage({ id: 'tool-3', toolStatus: 'backgrounded' }),
    ]
    expect(hasRunningTool(messages)).toBe(false)
  })

  it('returns false with no tool messages', () => {
    expect(hasRunningTool([userMessage()])).toBe(false)
  })

  it('returns false for empty or undefined message lists', () => {
    expect(hasRunningTool([])).toBe(false)
    expect(hasRunningTool(undefined)).toBe(false)
  })
})

describe('preserveQueuedFlags', () => {
  it('re-applies isQueued to a matching fresh user message', () => {
    const fresh = [userMessage({ id: 'server-id', timestamp: 2000 })]
    const prev = [userMessage({ id: 'optimistic-id', timestamp: 2000, isQueued: true })]

    const result = preserveQueuedFlags(fresh, prev)

    expect(result[0]).toMatchObject({
      id: 'optimistic-id',
      isQueued: true,
    })
  })

  it('keeps the optimistic id so the bubble identity survives replacement', () => {
    const fresh = [userMessage({ id: 'msg-1791452650925-4v2gxi', timestamp: 5000 })]
    const prev = [
      userMessage({ id: 'msg-1791452650925-abcdef', timestamp: 5000, isQueued: true }),
    ]

    const result = preserveQueuedFlags(fresh, prev)

    expect(result[0]!.id).toBe('msg-1791452650925-abcdef')
  })

  it('does not flag fresh messages when no prev queued message matches', () => {
    const fresh = [userMessage({ id: 'server-id', timestamp: 2000 })]
    const prev = [userMessage({ id: 'prev-id', timestamp: 2000 })] // not queued

    const result = preserveQueuedFlags(fresh, prev)

    expect(result[0]).toEqual(fresh[0])
  })

  it('only matches user messages within timestamp tolerance', () => {
    const fresh = [userMessage({ id: 'server-id', timestamp: 2000 })]
    const prev = [
      userMessage({ id: 'queued-far', timestamp: 30_000, isQueued: true }),
    ]

    const result = preserveQueuedFlags(fresh, prev)

    expect(result[0]).toEqual(fresh[0])
  })

  it('leaves non-user messages untouched', () => {
    const fresh = [toolMessage({ id: 'tool-srv', toolStatus: 'executing' })]
    const prev = [userMessage({ timestamp: 1000, isQueued: true })]

    const result = preserveQueuedFlags(fresh, prev)

    expect(result).toEqual(fresh)
  })

  it('returns fresh unchanged when prev is empty', () => {
    const fresh = [userMessage({ id: 'server-id', isQueued: false })]
    expect(preserveQueuedFlags(fresh, undefined)).toEqual(fresh)
    expect(preserveQueuedFlags(fresh, [])).toEqual(fresh)
  })

  it('matches queued message by content and nearby timestamp', () => {
    const fresh = [
      userMessage({ id: 'server-id', content: 'Chrome DevTools很久才会使用一次，为什么它还要开进程占内存？', timestamp: 1791452650925 }),
    ]
    const prev = [
      userMessage({
        id: 'optimistic-id',
        content: 'Chrome DevTools很久才会使用一次，为什么它还要开进程占内存？',
        timestamp: 1791452650925,
        isQueued: true,
      }),
    ]

    const result = preserveQueuedFlags(fresh, prev)

    expect(result[0]).toMatchObject({ id: 'optimistic-id', isQueued: true })
  })
})