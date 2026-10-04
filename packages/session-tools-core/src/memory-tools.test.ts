import { describe, expect, it } from 'bun:test'
import { getSessionSafeAllowedToolNames, getSessionSafeBlockedToolNames, SESSION_TOOL_REGISTRY } from './tool-defs.ts'

describe('session memory tools', () => {
  it('exposes session-memory reads safely but blocks memory mutations in Explore mode', () => {
    const read = SESSION_TOOL_REGISTRY.get('query_memories')
    const add = SESSION_TOOL_REGISTRY.get('add_memory')
    expect(read?.safeMode).toBe('allow')
    expect(read?.readOnly).toBe(true)
    expect(add?.safeMode).toBe('block')
    expect(getSessionSafeAllowedToolNames().has('query_memories')).toBe(true)
    expect(getSessionSafeBlockedToolNames().has('add_memory')).toBe(true)
    expect(add?.description).toContain('global')
  })
})
