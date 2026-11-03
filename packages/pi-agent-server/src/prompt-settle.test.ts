import { describe, expect, it } from 'bun:test'
import { settleStreamingSessionBeforePrompt } from './prompt-settle.ts'

/**
 * Regression guard for 2026-11-03 (session 261103-early-carbon): a fresh user
 * turn must never be silently queued as a `followUp` behind a run that had not
 * settled.
 */
function makeSession(initialStreaming: boolean, opts?: { streamingAfterAbort?: boolean; abortThrows?: boolean }) {
  const abortCalls: number[] = []
  const session = {
    isStreaming: initialStreaming,
    async abort() {
      abortCalls.push(Date.now())
      if (opts?.abortThrows) throw new Error('already aborted')
      session.isStreaming = opts?.streamingAfterAbort ?? false
    },
  }
  return { session, abortCalls }
}

describe('settleStreamingSessionBeforePrompt', () => {
  it('is a no-op when the session is already idle', async () => {
    const { session, abortCalls } = makeSession(false)
    await settleStreamingSessionBeforePrompt(session)
    expect(abortCalls).toHaveLength(0)
  })

  it('aborts the stale run so the fresh turn starts from idle', async () => {
    const { session, abortCalls } = makeSession(true)
    await settleStreamingSessionBeforePrompt(session)
    expect(abortCalls).toHaveLength(1)
    expect(session.isStreaming).toBe(false)
  })

  it('throws instead of queueing when the abort did not settle the run', async () => {
    const { session } = makeSession(true, { streamingAfterAbort: true })
    await expect(settleStreamingSessionBeforePrompt(session)).rejects.toThrow(
      /refusing to queue a fresh user turn as a follow-up/,
    )
  })

  it('still starts the turn when abort() throws but the session is idle afterwards', async () => {
    const logs: string[] = []
    const session = {
      isStreaming: true,
      async abort() {
        // The stale run settles itself while abort() reports failure.
        session.isStreaming = false
        throw new Error('session disposed')
      },
    }
    await settleStreamingSessionBeforePrompt(session, { log: (m) => logs.push(m) })
    expect(logs.some(l => l.includes('abort before fresh prompt failed'))).toBe(true)
  })
})
