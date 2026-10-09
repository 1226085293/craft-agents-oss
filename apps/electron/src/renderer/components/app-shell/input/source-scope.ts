/**
 * 数据源选择集合的模式语义（与后端 SessionManager.resolveSessionSourceSlugs 对应）：
 * - auto：agent 在已授权源中自主选择，用户勾选集合不参与约束（视为空）；
 * - only：已授权 ∩ 用户选择；
 * - exclude：已授权 − 用户排除。
 *
 * 所有函数都返回"原数组引用"表示无需更新，便于调用方用 `!==` 判断是否
 * 发生了有效变更（避免无谓的 setState 与 IPC 往返）。
 */

export type SourceScope = 'auto' | 'only' | 'exclude'

/**
 * 切换 scope 时选择集合的落定值。
 *
 * - 切到 auto：清除勾选——auto 下勾选集合无意义，保留只会让 UI 看起来
 *   仍受约束，且再次勾选时会连同旧勾选一起收窄为 only。
 * - auto → only：输入框里 @ 提及的已授权源默认勾选；没 @ 则不勾选。
 * - auto → exclude：输入框里 @ 提及的源不加入排除列表（被提及=被强调）；
 *   没 @ 则不勾选。
 * - only ↔ exclude：反向——但仅当当前集合非空时才反选（空集保持空，
 *   避免“没选任何源”时反向规则误触发）。
 * - 同模式“切换”：无变化（返回原引用）。
 *
 * 参数：
 * - `authorized`：已授权（enabled）源 slug 列表，反向运算的全集；不在其中
 *   的陈旧勾选会被顺带丢弃。
 * - `mentioned`：输入框当前 @ 提及的源 slug（仅 auto 切换时使用）。
 */
export function resolveSlugsOnScopeChange(
  from: SourceScope,
  to: SourceScope,
  current: string[],
  authorized: string[],
  mentioned: string[] = [],
): string[] {
  if (to === 'auto') return []
  if (from === 'auto') {
    // 没 @ 任何源 → 不勾选；@ 了 → 只勾选被 @ 且已授权的源
    const m = authorized.filter((slug) => mentioned.includes(slug))
    return m.length > 0 ? m : []
  }
  if (from !== to) {
    // 反向规则仅对非空集合生效；空集合（没选任何源）保持空
    if (current.length === 0) return current
    return authorized.filter((slug) => !current.includes(slug))
  }
  return current
}

/**
 * @ 提及（或发送时解析到）一个数据源时，按当前模式更新选择集合，scope 本身不变：
 * - auto：不做任何行为；
 * - only：未勾选则勾选；已勾选则保持不变；
 * - exclude：在排除列表（勾选）中则取消勾选；不在则保持不变。
 */
export function resolveSlugsOnSourceMention(scope: SourceScope, current: string[], slug: string): string[] {
  if (scope === 'only' && !current.includes(slug)) return [...current, slug]
  if (scope === 'exclude' && current.includes(slug)) return current.filter((s) => s !== slug)
  return current
}

/**
 * 从输入文本删除 @ 提及时的选择集合更新：
 * 仅 only 模式联动（删除提及 = 取消勾选）；auto / exclude 不反向修改选择。
 */
export function resolveSlugsOnMentionRemoved(scope: SourceScope, current: string[], removed: string[]): string[] {
  if (scope !== 'only' || removed.length === 0) return current
  const next = current.filter((s) => !removed.includes(s))
  return next.length === current.length ? current : next
}