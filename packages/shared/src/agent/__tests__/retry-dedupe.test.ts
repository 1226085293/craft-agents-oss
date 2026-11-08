import { describe, expect, it } from 'bun:test'
import { shouldResendModelStep } from '../pi-agent.ts'

/**
 * The window exists for one failure producing two triggers 3ms apart. It must not also swallow
 * the retry that is supposed to recover a turn the first attempt lost.
 */
describe('whether to resend the model step', () => {
  it('sends the first retry', () => {
    expect(shouldResendModelStep({ now: 10_000, lastRetrySentAt: 0, lastTurnAbortAt: 0 })).toBe(true)
  })

  it('collapses a second trigger on the same failure', () => {
    // The gateway retry and the stall watchdog, 3ms apart.
    expect(shouldResendModelStep({ now: 10_003, lastRetrySentAt: 10_000, lastTurnAbortAt: 0 })).toBe(false)
  })

  it('resends after the window', () => {
    expect(shouldResendModelStep({ now: 16_000, lastRetrySentAt: 10_000, lastTurnAbortAt: 0 })).toBe(true)
  })

  /**
   * The failure that motivated this: the stall watchdog sent `retry` at 57.506, the subprocess
   * aborted at 57.712, and its retry was suppressed — so the turn stayed dead.
   */
  it('resends when the previous retry went into an aborting session', () => {
    expect(
      shouldResendModelStep({ now: 57_712, lastRetrySentAt: 57_506, lastTurnAbortAt: 57_712 }),
    ).toBe(true)
  })

  it('still collapses a duplicate after that resent retry', () => {
    expect(
      shouldResendModelStep({ now: 57_715, lastRetrySentAt: 57_712, lastTurnAbortAt: 57_712 }),
    ).toBe(false)
  })
})
