export interface WaitForCooldownConfig {
  enabled: boolean
  maxWaitSeconds?: number
}

export interface WaitForCooldownDraft {
  enabled: boolean
  maxWaitSeconds: number
}

export function waitForCooldownDraftFromConfig(config?: WaitForCooldownConfig): WaitForCooldownDraft {
  return {
    enabled: config?.enabled === true,
    maxWaitSeconds: Number.isInteger(config?.maxWaitSeconds) && config!.maxWaitSeconds! >= 1 && config!.maxWaitSeconds! <= 540
      ? config!.maxWaitSeconds!
      : 540,
  }
}

export function isWaitForCooldownDraftValid(draft: WaitForCooldownDraft): boolean {
  return !draft.enabled ||
    (Number.isInteger(draft.maxWaitSeconds) && draft.maxWaitSeconds >= 1 && draft.maxWaitSeconds <= 540)
}

export function serializeWaitForCooldownDraft(draft: WaitForCooldownDraft): WaitForCooldownConfig | undefined {
  // Disabled → omit the field entirely: the config stays clean and the loader
  // treats an absent field exactly like enabled=false.
  if (!draft.enabled) return undefined
  return draft.maxWaitSeconds === 540
    ? { enabled: true }
    : { enabled: true, maxWaitSeconds: draft.maxWaitSeconds }
}
