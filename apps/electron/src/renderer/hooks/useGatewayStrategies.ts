/**
 * useGatewayStrategies — the composer's routing options, kept live.
 *
 * Reads the gateway's status push (2s cadence) and projects it into the shape
 * `StrategySelector` wants: strategy ids paired with the model each one last
 * routed to.
 *
 * The projection lives here rather than in the component because it encodes a
 * decision the component should not have to make: **when there is no live model
 * yet, the strategy is still offered**. A freshly configured strategy has no
 * traffic, and hiding it would make the picker look empty until someone sent a
 * request through the gateway elsewhere.
 *
 * Also reports *why* picking is impossible, because "no strategies" and "the
 * gateway is off" need different copy — one is a setup step, the other is a
 * runtime state that may fix itself.
 *
 * Those two states also differ in whether sending should be blocked, so
 * `unavailable` deliberately covers only the cases where the gateway cannot
 * route at all (missing channel / not running). A running gateway with zero
 * strategies leaves `unavailable` null and `strategies` empty: the server guard
 * refuses such a session (`no_strategy_selected`), so the composer must block
 * it too rather than let the message fail after a round trip.
 */

import * as React from 'react'

import type { StrategyOption } from '../components/app-shell/input/StrategySelector'

export interface GatewayStrategiesState {
  strategies: StrategyOption[]
  /**
   * Non-null when the gateway itself cannot route (missing IPC channel, or not
   * running / disabled). Deliberately NOT set for "running but no strategies" —
   * that state is visible as `strategies.length === 0` and must still block
   * sending, because the server refuses it.
   */
  unavailable: string | null
}

/**
 * The gateway's live status, as pushed by the main process.
 */
export interface GatewayStatusPayload {
  running?: boolean
  enabled?: boolean
  strategies?: Array<{
    id: string
    /** Display name; absent in older main processes. */
    name?: string
    models?: string[]
    /**
     * The subset of `models` a request made now could actually land on. Empty
     * with a non-empty `models` means every availability window is closed.
     * Absent means an older main process (`models` is the whole truth there).
     */
    openModels?: string[]
    enabled?: boolean
    usable?: boolean
    reason?: string
  }>
  lastModels?: Record<string, string>
}

/**
 * Project a status payload into the composer's routing options.
 *
 * Exported (rather than inlined in the hook) because the `unavailable` rule is
 * a decision with consequences: see the comment below.
 */
export function projectGatewayStrategies(status: GatewayStatusPayload | null): {
  strategies: StrategyOption[]
  unavailable: string | null
} {
  const strategies: StrategyOption[] = (status?.strategies ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    lastModel: status?.lastModels?.[s.id],
    models: s.models,
    openModels: s.openModels,
    enabled: s.enabled,
    usable: s.usable,
    reason: s.reason,
  }))

  let unavailable: string | null = null
  if (!status) {
    // No payload at all: the channel is missing (older main process).
    unavailable = '当前构建不支持 LLM 网关'
  } else if (!status.running || status.enabled === false) {
    unavailable = 'LLM 网关未运行'
  }
  // Deliberately NOT: "running but zero groups". The server refuses such a
  // session (`no_strategy_selected`), so the composer must block it — which it
  // can only do if `unavailable` stays null and the empty `strategies` array is
  // what it sees.

  return { strategies, unavailable }
}

export function useGatewayStrategies(): GatewayStrategiesState {
  const [status, setStatus] = React.useState<GatewayStatusPayload | null>(null)

  React.useEffect(() => {
    let cancelled = false
    void window.electronAPI.llmGatewayGetStatus?.().then((s) => {
      if (!cancelled && s) setStatus(s as GatewayStatusPayload)
    })
    // Without this the model half of the label would freeze at first paint.
    const off = window.electronAPI.onLlmGatewayStatus?.((s: unknown) => {
      if (!cancelled) setStatus(s as GatewayStatusPayload)
    })
    return () => {
      cancelled = true
      off?.()
    }
  }, [])

  return React.useMemo(() => projectGatewayStrategies(status), [status])
}
