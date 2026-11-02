import { describe, expect, it } from 'bun:test'
import { SpawnSessionSchema } from './tool-defs.ts'

/**
 * spawn_session follows the new session by default. The default lives in the
 * schema so every backend path (SDK tool, MCP, Pi) sees the same value; the
 * SessionManager auto-subscribe only runs when it is not explicitly false.
 */
describe('spawn_session subscribe parameter', () => {
  it('defaults to true when omitted', () => {
    expect(SpawnSessionSchema.parse({ prompt: 'do the thing' }).subscribe).toBe(true)
  })

  it('respects an explicit false for fire-and-forget work', () => {
    expect(SpawnSessionSchema.parse({ prompt: 'do the thing', subscribe: false }).subscribe).toBe(false)
  })
})
