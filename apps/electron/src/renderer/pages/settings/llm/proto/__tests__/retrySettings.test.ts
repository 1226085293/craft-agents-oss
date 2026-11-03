import { describe, expect, it } from 'bun:test'

import { isRetryDraftValid, retryDraftFromConfig, serializeRetryDraft } from '../retrySettings'

describe('retry settings form serialization', () => {
  it('omits the target duration for finite attempt counts', () => {
    const draft = retryDraftFromConfig({ maxAttempts: 3, maxDurationSeconds: 90 })
    expect(serializeRetryDraft({ ...draft, maxAttempts: 3 })).toEqual({
      maxAttempts: 3,
      intervalMode: 'fixed',
      backoffMs: 500,
    })
  })

  it('writes exactly one per-target duration for unlimited mode', () => {
    const draft = retryDraftFromConfig()
    expect(serializeRetryDraft({ ...draft, maxAttempts: 'unlimited', maxDurationSeconds: 240 })).toEqual({
      maxAttempts: 'unlimited',
      maxDurationSeconds: 240,
      intervalMode: 'fixed',
      backoffMs: 500,
    })
  })

  it('serializes fixed seconds as milliseconds', () => {
    const draft = retryDraftFromConfig()
    expect(serializeRetryDraft({ ...draft, backoffSeconds: 1.25 })).toMatchObject({ backoffMs: 1250 })
  })

  it('omits fixed interval when exponential mode is selected', () => {
    const draft = retryDraftFromConfig({ onStatusCodes: [500, 503] })
    expect(serializeRetryDraft({ ...draft, intervalMode: 'exponential' })).toEqual({
      maxAttempts: 3,
      intervalMode: 'exponential',
      onStatusCodes: [500, 503],
    })
  })

  it('preserves the existing retry status allowlist', () => {
    const draft = retryDraftFromConfig({ maxAttempts: 4, intervalMode: 'fixed', backoffMs: 750, onStatusCodes: [500, 503] })
    expect(serializeRetryDraft(draft)).toMatchObject({ onStatusCodes: [500, 503] })
  })

  it('requires an integer unlimited duration between one second and one day', () => {
    const draft = retryDraftFromConfig()
    expect(isRetryDraftValid({ ...draft, maxAttempts: 'unlimited', maxDurationSeconds: 1 })).toBe(true)
    expect(isRetryDraftValid({ ...draft, maxAttempts: 'unlimited', maxDurationSeconds: 86400 })).toBe(true)
    expect(isRetryDraftValid({ ...draft, maxAttempts: 'unlimited', maxDurationSeconds: 0 })).toBe(false)
    expect(isRetryDraftValid({ ...draft, maxAttempts: 'unlimited', maxDurationSeconds: 1.5 })).toBe(false)
    expect(isRetryDraftValid({ ...draft, maxAttempts: 'unlimited', maxDurationSeconds: 86401 })).toBe(false)
  })
})
