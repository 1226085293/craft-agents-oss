export type RetryAttemptCount = 1 | 2 | 3 | 4 | 5 | 'unlimited'
export type RetryIntervalMode = 'fixed' | 'exponential'

export interface RetrySettingsConfig {
  maxAttempts?: number | 'unlimited'
  maxDurationSeconds?: number
  intervalMode?: RetryIntervalMode
  backoffMs?: number
  onStatusCodes?: number[]
}

export interface RetrySettingsDraft {
  maxAttempts: RetryAttemptCount
  /** Only serialized when maxAttempts is 'unlimited'. */
  maxDurationSeconds: number
  intervalMode: RetryIntervalMode
  /** Seconds; persisted as milliseconds in the shared config. */
  backoffSeconds: number
  onStatusCodes?: number[]
}

export function retryDraftFromConfig(retry?: RetrySettingsConfig): RetrySettingsDraft {
  const maxAttempts = retry?.maxAttempts === 'unlimited'
    ? 'unlimited'
    : Number.isInteger(retry?.maxAttempts) && retry!.maxAttempts! >= 1 && retry!.maxAttempts! <= 5
      ? retry!.maxAttempts as RetryAttemptCount
      : 3
  return {
    maxAttempts,
    maxDurationSeconds: retry?.maxDurationSeconds ?? 300,
    intervalMode: retry?.intervalMode ?? 'fixed',
    backoffSeconds: (retry?.backoffMs ?? 500) / 1000,
    ...(retry?.onStatusCodes ? { onStatusCodes: [...retry.onStatusCodes] } : {}),
  }
}

export function isRetryDraftValid(draft: RetrySettingsDraft): boolean {
  if (draft.maxAttempts === 'unlimited' &&
      (!Number.isInteger(draft.maxDurationSeconds) || draft.maxDurationSeconds < 1 || draft.maxDurationSeconds > 86400)) {
    return false
  }
  return draft.intervalMode !== 'fixed' ||
    (Number.isFinite(draft.backoffSeconds) && draft.backoffSeconds >= 0 && draft.backoffSeconds <= 300)
}

export function serializeRetryDraft(draft: RetrySettingsDraft): RetrySettingsConfig {
  const serialized: RetrySettingsConfig = {
    maxAttempts: draft.maxAttempts,
    intervalMode: draft.intervalMode,
    ...(draft.onStatusCodes ? { onStatusCodes: [...draft.onStatusCodes] } : {}),
  }
  if (draft.maxAttempts === 'unlimited') {
    serialized.maxDurationSeconds = draft.maxDurationSeconds
  }
  if (draft.intervalMode === 'fixed') {
    serialized.backoffMs = Math.max(0, Math.round(draft.backoffSeconds * 1000))
  }
  return serialized
}
