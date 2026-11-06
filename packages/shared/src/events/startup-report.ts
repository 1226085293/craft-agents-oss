/**
 * One sentence that explains why plugins are not running.
 *
 * Cordis reports a stuck plugin by naming the services it is waiting on; Craft
 * has the same information (`ready`, `missingConfig`, dependency states) but it
 * was only visible by opening each plugin's detail page. At boot that means a
 * user sees five plugins and no reason any of them is idle.
 *
 * This is pure and shared so the server can log it and the UI can render it
 * without either side inventing its own wording.
 */

export interface PluginStateInput {
  id: string
  name?: string
  enabled: boolean
  /** Structural readiness: runtime present, dependencies resolvable. */
  ready: boolean
  /** Required config keys the user has not filled in. */
  missingConfig?: string[]
  /** Dependency entries, already probed. */
  dependencies?: ReadonlyArray<{ label: string; state: string }>
  /** Present when the process was started and then failed. */
  affinity?: { state?: string; lastError?: string | null }
  status?: { state?: string; lastError?: string | null } | undefined
}

export interface PluginStartupReport {
  running: number
  waiting: number
  failed: number
  /** Human sentence; empty when everything that is enabled is running. */
  summary: string
  /** Per-plugin reason, for a list or a tooltip. */
  reasons: Array<{ id: string; label: string; reason: string }>
}

/**
 * Classify one plugin.
 *
 * The distinction that matters to a user: "not running yet because it needs
 * something from me" (waiting) versus "I tried and it broke" (failed) versus
 * "you turned it off" (silent — nobody needs to be told).
 */
function classify(input: PluginStateInput): { kind: 'running' | 'waiting' | 'failed' | 'off'; reason?: string } {
  if (!input.enabled) return { kind: 'off' }

  const state = input.status?.state ?? input.affinity?.state
  const error = input.status?.lastError ?? input.affinity?.lastError ?? undefined
  if (state === 'failed') {
    return { kind: 'failed', reason: error ? `启动失败：${error}` : '启动失败' }
  }
  if (state === 'running') return { kind: 'running' }

  const missing = input.missingConfig ?? []
  if (missing.length > 0) return { kind: 'waiting', reason: `等待配置：${missing.join('、')}` }

  const blocking = (input.dependencies ?? []).filter(
    (dep) => dep.state === 'missing' || dep.state === 'mismatch',
  )
  if (blocking.length > 0) {
    return { kind: 'waiting', reason: `依赖未满足：${blocking.map((d) => d.label).join('、')}` }
  }

  if (!input.ready) return { kind: 'waiting', reason: '没有可运行的程序' }

  // Ready but not running: the supervisor has not got to it yet, or the last
  // attempt stopped. Either way it is not a user problem, so do not shout.
  return { kind: 'waiting', reason: '尚未启动' }
}

export function buildStartupReport(inputs: PluginStateInput[]): PluginStartupReport {
  let running = 0
  let waiting = 0
  let failed = 0
  const reasons: PluginStartupReport['reasons'] = []

  for (const input of inputs) {
    const verdict = classify(input)
    if (verdict.kind === 'running') {
      running += 1
      continue
    }
    if (verdict.kind === 'off') continue
    if (verdict.kind === 'failed') failed += 1
    else waiting += 1
    reasons.push({
      id: input.id,
      label: input.name ?? input.id,
      reason: verdict.reason ?? '',
    })
  }

  const parts: string[] = []
  if (running > 0) parts.push(`${running} 个运行中`)
  if (waiting > 0) parts.push(`${waiting} 个等待中`)
  if (failed > 0) parts.push(`${failed} 个启动失败`)

  const summary =
    parts.length === 0
      ? '没有启用的插件'
      : `${parts.join('，')}${reasons.length ? `｜${reasons.map((r) => `${r.label}：${r.reason}`).join('；')}` : ''}`

  return { running, waiting, failed, summary, reasons }
}
