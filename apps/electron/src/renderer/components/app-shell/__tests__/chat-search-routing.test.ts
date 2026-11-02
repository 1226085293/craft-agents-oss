import { describe, expect, it } from 'bun:test'
import { getInChatSearchQuery, resolveKeyboardSearchTarget } from '../chat-search-routing'

describe('keyboard search target', () => {
  it('opens conversation search only when the chat zone is focused', () => {
    expect(resolveKeyboardSearchTarget('chat')).toBe('chat')
    expect(resolveKeyboardSearchTarget('chat', false)).toBe('sessions')
    expect(resolveKeyboardSearchTarget('navigator')).toBe('sessions')
    expect(resolveKeyboardSearchTarget(null)).toBe('sessions')
  })
})

describe('session search result handoff', () => {
  it('passes the active query into conversation search', () => {
    expect(getInChatSearchQuery(true, '你好')).toBe('你好')
  })

  it('passes a single-character query into conversation search', () => {
    expect(getInChatSearchQuery(true, '好')).toBe('好')
  })

  it('does not start conversation search for inactive or blank queries', () => {
    expect(getInChatSearchQuery(false, '你好')).toBeNull()
    expect(getInChatSearchQuery(true, '  ')).toBeNull()
  })
})
