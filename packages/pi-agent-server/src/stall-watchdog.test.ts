import { describe, expect, it } from 'bun:test'
import {
  READ_ONLY_TOOL_SILENCE_BUDGET_MS,
  STALL_EXEMPTION_GRACE_MS,
  resolveToolSilenceDeadline,
  shouldAbortStalledTurn,
} from './stall-watchdog.ts'

const base = {
  now: 1_000_000,
  lastActivityAt: 1_000_000,
  timeoutMs: 90_000,
  cooldownWaiting: false,
  activeToolDeadline: null as number | null,
  pendingToolInFlight: false,
}

describe('resolveToolSilenceDeadline', () => {
  const now = 1_000_000

  it('gives a no-timeout read-only tool a finite default budget', () => {
    expect(resolveToolSilenceDeadline('Grep', {}, now)).toBe(
      now + READ_ONLY_TOOL_SILENCE_BUDGET_MS + STALL_EXEMPTION_GRACE_MS,
    )
  })

  it('keeps a no-timeout non-read-only tool unbounded', () => {
    expect(resolveToolSilenceDeadline('Bash', {}, now)).toBeNull()
  })

  it('honours an explicit timeout in seconds', () => {
    expect(resolveToolSilenceDeadline('Bash', { timeout: 10 }, now)).toBe(
      now + 10_000 + STALL_EXEMPTION_GRACE_MS,
    )
  })

  it('lets an explicit timeout override the read-only default', () => {
    expect(resolveToolSilenceDeadline('Grep', { timeout: 5 }, now)).toBe(
      now + 5_000 + STALL_EXEMPTION_GRACE_MS,
    )
  })
})

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
