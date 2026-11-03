import { describe, expect, it } from 'bun:test'

import { retryDelayMs, targetBudgetAllowsRetry } from '../llm-retry.ts'
import type { RetryPolicy } from '../llm-planner.ts'

const exponential: RetryPolicy = {
  maxAttempts: 5,
  maxDurationSeconds: undefined,
  intervalMode: 'exponential',
  onStatusCodes: [429, 500, 502, 503, 504],
  backoffMs: 500,
}

const fixed: RetryPolicy = { ...exponential, intervalMode: 'fixed', backoffMs: 750 }

describe('retryDelayMs', () => {
  it('uses fixed interval unchanged when Retry-After is absent', () => {
    expect(retryDelayMs(fixed, 1, 0)).toBe(750)
  })

  it('uses the 1, 2, 4, 8, 16, 30 second exponential sequence', () => {
    const random = () => 0
    expect([1, 2, 3, 4, 5, 6, 7].map((attempt) => retryDelayMs(exponential, attempt, 0, random)))
      .toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
  })

  it('adds positive jitter of no more than ten percent after capping the exponential base at 30 seconds', () => {
    expect(retryDelayMs(exponential, 1, 0, () => 0.5)).toBe(1050)
    expect(retryDelayMs(exponential, 6, 0, () => 1)).toBe(33000)
  })

  it('never retries before Retry-After and jitters its minimum wait', () => {
    expect(retryDelayMs(exponential, 1, 12, () => 0)).toBe(12000)
    expect(retryDelayMs(exponential, 1, 12, () => 1)).toBe(13200)
    expect(retryDelayMs(exponential, 7, 60, () => 1)).toBe(66000)
  })

  it('uses Retry-After as the minimum without changing a fixed interval', () => {
    expect(retryDelayMs(fixed, 1, 0, () => 1)).toBe(750)
    expect(retryDelayMs(fixed, 1, 2, () => 1)).toBe(2000)
  })
})

describe('targetBudgetAllowsRetry', () => {
  it('allows retries while a finite attempt budget and duration remain', () => {
    expect(targetBudgetAllowsRetry({ maxAttempts: 3, maxDurationSeconds: undefined }, 2, 10, 20_000)).toBe(true)
  })

  it('stops at the finite attempt count', () => {
    expect(targetBudgetAllowsRetry({ maxAttempts: 3, maxDurationSeconds: undefined }, 3, 10, 20_000)).toBe(false)
  })

  it('allows unlimited attempts only until the target duration expires', () => {
    const policy: RetryPolicy = { ...exponential, maxAttempts: 'unlimited', maxDurationSeconds: 10 }
    expect(targetBudgetAllowsRetry(policy, 100, 1000, 10_999)).toBe(true)
    expect(targetBudgetAllowsRetry(policy, 100, 1000, 11_000)).toBe(false)
  })

  it('does not start another attempt when its delay would exceed the target deadline', () => {
    expect(targetBudgetAllowsRetry({ maxAttempts: 'unlimited', maxDurationSeconds: 10 }, 1, 1000, 8000, 3000)).toBe(false)
  })
})
