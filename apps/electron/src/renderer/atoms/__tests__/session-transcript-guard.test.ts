import { describe, it, expect } from 'bun:test'
import { carriesTranscript } from '../sessions.ts'

/**
 * The bug this guards: a metadata projection (`messages: []`, `messageCount: 12`)
 * reached the renderer through a "here is the session" path and was marked as
 * loaded. Because loading short-circuits on that flag, an existing supervisor
 * session then displayed nothing forever — while its messages sat on disk and in
 * context.
 */

describe('carriesTranscript', () => {
  it('accepts a payload that has messages', () => {
    expect(carriesTranscript({ messages: [{} as never], messageCount: 1 })).toBe(true)
  })

  it('rejects a payload that claims messages but carries none', () => {
    // This is exactly `managedToSession`: a metadata projection.
    expect(carriesTranscript({ messages: [], messageCount: 12 })).toBe(false)
  })

  it('accepts a genuinely empty session', () => {
    // A brand-new session has no messages and must not look broken.
    expect(carriesTranscript({ messages: [], messageCount: 0 })).toBe(true)
    expect(carriesTranscript({ messages: [] })).toBe(true)
  })

  it('accepts messages without a count, so an unknown count is not a veto', () => {
    expect(carriesTranscript({ messages: [{} as never] })).toBe(true)
  })
})
