/**
 * 「单目标时限」是否短到毫无意义。
 *
 * 网关的重试预算是**单目标从首次尝试起算的墙钟时间**：
 * `targetBudgetAllowsRetry()`（packages/shared/src/config/llm-retry.ts）在
 * `now >= startedAt + maxDurationSeconds` 时直接判死，而这一次尝试本身可能
 * 被 preset 的 `firstByteSeconds` 拖满。于是「无限（时限）」填一个小于等于首
 * 字节超时的值时，第一次超时就已耗尽预算 —— 界面上写着「无限重试」，实际是
 * 一次都不重试（2026-11-05，`261105-onyx-steel`：amd 首字节 30 秒、时限 5 秒，
 * 每个目标只试一次）。
 *
 * 这里只做提示，不校验、不改写：时限是合法的用户选择，缺的只是它和
 * `firstByteSeconds` 的关系没有被说出来。
 */

import type { LlmPresetShape } from '../types'
import type { ProtoProvider } from './viewmodel'

/** 与 shared `DEFAULT_PRESET.firstByteSeconds` 保持一致。 */
export const DEFAULT_FIRST_BYTE_SECONDS = 30

/** 建议的时限：留出三次尝试的余量（首字节 + 退避 + 一次真正的重试）。 */
const SUGGESTED_ATTEMPTS = 3

export interface SlowestFirstByte {
  seconds: number
  /** 拥有这条最慢预算的提供商名字，用于把提示落到具体对象上。 */
  providerName: string
}

/**
 * 该组最慢的首字节超时。
 *
 * 解析顺序照抄 shared 的 `presetFor`：key 自己声明的类型 → 提供商默认类型 →
 * 内置默认值。停用的 key 不参与：它不会承载请求，算进去只会造出假的警告。
 * 没有 key 的提供商（keyless 中继）走它的默认类型。
 */
export function slowestFirstByte(args: {
  members: string[]
  providers: ProtoProvider[]
  presets: Record<string, LlmPresetShape>
}): SlowestFirstByte | null {
  const { members, providers, presets } = args
  let slowest: SlowestFirstByte | null = null

  const consider = (presetId: string, provider: ProtoProvider): void => {
    const seconds = presets[presetId]?.firstByteSeconds ?? DEFAULT_FIRST_BYTE_SECONDS
    if (!Number.isFinite(seconds) || seconds <= 0) return
    if (!slowest || seconds > slowest.seconds) {
      slowest = { seconds, providerName: provider.name || provider.id }
    }
  }

  for (const providerId of members) {
    const provider = providers.find((p) => p.id === providerId)
    if (!provider) continue
    const enabledKeys = provider.keyRows.filter((key) => key.enabled !== false)
    if (enabledKeys.length === 0) {
      consider(provider.defaultType, provider)
      continue
    }
    for (const key of enabledKeys) {
      // 空类型 = 继承提供商默认类型；指向已删除类型的 key 也留空（见 viewmodel）。
      consider(key.type || provider.defaultType, provider)
    }
  }
  return slowest
}

/**
 * 需要提醒时返回一段可直接渲染的文案，否则 null。
 *
 * 判定阈值是 `<=`：时限恰好等于首字节超时同样走不通 —— 那次尝试会用到
 * deadline，重试的前置判断 `now >= deadline` 已经成立。
 */
export function retryTimeLimitWarning(args: {
  maxDurationSeconds: number
  members: string[]
  providers: ProtoProvider[]
  presets: Record<string, LlmPresetShape>
}): string | null {
  const { maxDurationSeconds } = args
  // 非法值由字段自己的校验文案负责，这里不重复报错。
  if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds < 1) return null
  const slowest = slowestFirstByte(args)
  if (!slowest) return null
  if (maxDurationSeconds > slowest.seconds) return null

  const suggested = Math.min(86400, Math.ceil(slowest.seconds * SUGGESTED_ATTEMPTS))
  return (
    `本组最慢的首字节超时是 ${slowest.seconds} 秒（${slowest.providerName}）：` +
    `时限 ≤ ${slowest.seconds} 秒时，一次超时就会耗尽预算，「无限」实际等于不重试。` +
    `建议至少 ${suggested} 秒（约 ${SUGGESTED_ATTEMPTS} 次尝试的余量）。`
  )
}
