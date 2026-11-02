import { describe, it, expect } from 'bun:test'
import { hasRunningTool } from '../session-recovery-utils'
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
