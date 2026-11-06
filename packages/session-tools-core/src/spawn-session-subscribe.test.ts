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

/**
 * `role` used to be a parameter of spawn_session, accepting 'supervisor'.
 *
 * That let a supervisor spawn a second supervisor: two sessions draining the same
 * event backlog, each convinced it was the coordinator, and the second invisible
 * to the user. Role is a fact about how the system built the session, not
 * something the model chooses — a spawned session is always a worker.
 */
describe('spawn_session cannot choose a role', () => {
  it('does not expose role in the schema', () => {
    expect('role' in SpawnSessionSchema.shape).toBe(false)
  })

  it('drops a role passed anyway instead of honouring it', () => {
    // Models sometimes pass fields that are not in the schema. Those must be
    // stripped, not forwarded: silently upgrading to supervisor would be worse
    // than an error, because nothing would surface it.
    const parsed = SpawnSessionSchema.parse({ prompt: 'x', role: 'supervisor' }) as Record<string, unknown>
    expect(parsed.role).toBeUndefined()
  })
})
