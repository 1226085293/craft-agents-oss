import { describe, expect, it } from 'bun:test'
import { shouldAbortStalledTurn } from './stall-watchdog.ts'

const base = {
  now: 1_000_000,
  lastActivityAt: 1_000_000,
  timeoutMs: 90_000,
  cooldownWaiting: false,
  activeToolDeadline: null as number | null,
  pendingToolInFlight: false,
}

describe('shouldAbortStalledTurn', () => {
  it('does not abort while a cooldown wait outlasts the stall timeout', () => {
    expect(
      shouldAbortStalledTurn({
        ...base,
        lastActivityAt: base.now - 300_000,
        cooldownWaiting: true,
      }),
    ).toBe(false)
  })

  it('aborts the same silence when no cooldown wait is active', () => {
    expect(
      shouldAbortStalledTurn({
        ...base,
        lastActivityAt: base.now - 90_001,
      }),
    ).toBe(true)
  })

  it('does not abort while an active tool deadline is still in the future', () => {
    expect(
      shouldAbortStalledTurn({
        ...base,
        lastActivityAt: base.now - 300_000,
        activeToolDeadline: base.now + 1_000,
      }),
    ).toBe(false)
  })

  it('does not abort while a proxy tool is in flight', () => {
    expect(
      shouldAbortStalledTurn({
        ...base,
        lastActivityAt: base.now - 300_000,
        pendingToolInFlight: true,
      }),
    ).toBe(false)
  })
})
