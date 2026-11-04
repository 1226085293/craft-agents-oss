import { describe, expect, it } from 'bun:test'

import {
  isWaitForCooldownDraftValid,
  serializeWaitForCooldownDraft,
  waitForCooldownDraftFromConfig,
} from '../waitForCooldownSettings'

describe('waitForCooldownSettings', () => {
  it('defaults to disabled with 540s when the config field is absent', () => {
    expect(waitForCooldownDraftFromConfig(undefined)).toEqual({ enabled: false, maxWaitSeconds: 540 })
    expect(waitForCooldownDraftFromConfig({ enabled: false })).toEqual({ enabled: false, maxWaitSeconds: 540 })
  })

  it('keeps a valid configured maxWaitSeconds', () => {
    expect(waitForCooldownDraftFromConfig({ enabled: true, maxWaitSeconds: 300 })).toEqual({
      enabled: true,
      maxWaitSeconds: 300,
    })
  })

  it('falls back to 540s for out-of-range or non-integer values', () => {
    expect(waitForCooldownDraftFromConfig({ enabled: true, maxWaitSeconds: 0 }).maxWaitSeconds).toBe(540)
    expect(waitForCooldownDraftFromConfig({ enabled: true, maxWaitSeconds: 541 }).maxWaitSeconds).toBe(540)
    expect(waitForCooldownDraftFromConfig({ enabled: true, maxWaitSeconds: 12.5 }).maxWaitSeconds).toBe(540)
  })

  it('validates only when enabled', () => {
    expect(isWaitForCooldownDraftValid({ enabled: false, maxWaitSeconds: 99999 })).toBe(true)
    expect(isWaitForCooldownDraftValid({ enabled: true, maxWaitSeconds: 540 })).toBe(true)
    expect(isWaitForCooldownDraftValid({ enabled: true, maxWaitSeconds: 1 })).toBe(true)
    expect(isWaitForCooldownDraftValid({ enabled: true, maxWaitSeconds: 540 })).toBe(true)
    expect(isWaitForCooldownDraftValid({ enabled: true, maxWaitSeconds: 0 })).toBe(false)
    expect(isWaitForCooldownDraftValid({ enabled: true, maxWaitSeconds: 541 })).toBe(false)
    expect(isWaitForCooldownDraftValid({ enabled: true, maxWaitSeconds: 10.5 })).toBe(false)
  })

  it('omits the whole field when disabled', () => {
    expect(serializeWaitForCooldownDraft({ enabled: false, maxWaitSeconds: 540 })).toBeUndefined()
  })

  it('omits maxWaitSeconds at the 540s default and writes it otherwise', () => {
    expect(serializeWaitForCooldownDraft({ enabled: true, maxWaitSeconds: 540 })).toEqual({ enabled: true })
    expect(serializeWaitForCooldownDraft({ enabled: true, maxWaitSeconds: 300 })).toEqual({
      enabled: true,
      maxWaitSeconds: 300,
    })
  })
})
