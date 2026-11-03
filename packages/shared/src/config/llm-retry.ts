import type { RetryPolicy } from './llm-planner.ts'

const EXPONENTIAL_BASE_MS = 1000
const EXPONENTIAL_CAP_MS = 30_000
const MAX_JITTER_FRACTION = 0.1

/** Delay for the next same-target attempt, honoring Retry-After as a minimum. */
export function retryDelayMs(
  policy: RetryPolicy,
  failedAttempts: number,
  retryAfterSeconds: number,
  random: () => number = Math.random,
): number {
  const configured = policy.intervalMode === 'exponential'
    ? Math.min(EXPONENTIAL_BASE_MS * (2 ** Math.max(0, failedAttempts - 1)), EXPONENTIAL_CAP_MS)
    : policy.backoffMs
  const retryAfterMs = Math.max(0, Math.ceil(retryAfterSeconds * 1000))
  const base = Math.max(configured, retryAfterMs)
  if (base === 0 || policy.intervalMode === 'fixed') return base
  const sample = Math.min(1, Math.max(0, random()))
  return Math.ceil(base * (1 + sample * MAX_JITTER_FRACTION) - 1e-9)
}

/** Whether another same-target call fits both the attempt and elapsed-time budgets. */
export function targetBudgetAllowsRetry(
  policy: Pick<RetryPolicy, 'maxAttempts' | 'maxDurationSeconds'>,
  attemptsUsed: number,
  targetStartedAtMs: number,
  nowMs: number,
  nextDelayMs = 0,
): boolean {
  if (policy.maxAttempts !== 'unlimited' && attemptsUsed >= policy.maxAttempts) return false
  if (policy.maxDurationSeconds !== undefined) {
    const deadline = targetStartedAtMs + policy.maxDurationSeconds * 1000
    if (nowMs >= deadline || nowMs + Math.max(0, nextDelayMs) >= deadline) return false
  }
  return true
}
