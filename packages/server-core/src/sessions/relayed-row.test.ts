import { describe, expect, it } from 'bun:test'
import { isOwnReply } from './SessionManager.ts'

/**
 * A forwarded report renders as an agent bubble but is not this session's answer.
 *
 * `report_to_user` used to write `role: 'info'` — a grey status line where an agent's message
 * should be, which read as system chrome rather than somebody telling you something. It now renders
 * as an assistant bubble. What must not come with that: three readers treat a final assistant
 * message as "this session finished and this is what it said", and a forwarded row would satisfy all
 * three falsely — restart recovery would stop replaying a turn still in flight, and the session's
 * output would be reported as somebody else's sentence.
 */
describe('a relayed row', () => {
  it('is not the session replying', () => {
    expect(isOwnReply({ role: 'assistant', isRelayed: true })).toBe(false)
  })

  it('is the session replying when it was not relayed', () => {
    expect(isOwnReply({ role: 'assistant' })).toBe(true)
  })

  it('is not a reply when it is mid-turn commentary', () => {
    expect(isOwnReply({ role: 'assistant', isIntermediate: true })).toBe(false)
  })

  it('is not a reply when it is a notice or a tool row', () => {
    expect(isOwnReply({ role: 'info' })).toBe(false)
    expect(isOwnReply({ role: 'tool' })).toBe(false)
    expect(isOwnReply({ role: 'user' })).toBe(false)
  })
})
