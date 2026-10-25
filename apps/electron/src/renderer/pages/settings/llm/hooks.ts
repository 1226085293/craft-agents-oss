/**
 * Data hooks for the LLM gateway settings page.
 *
 * Every read/write goes through `window.electronAPI.llmGateway*` — the gateway
 * lives in the main process and the channel map
 * (`packages/shared/src/protocol/channels.ts`) is the single source of truth.
 * Optional calls (`?.`) throughout because a renderer can outlive a preload
 * that never registered the channel; the page degrades to an empty state there
 * rather than crashing.
 *
 * Two-way binding (the v30 requirement):
 *   - a write goes through SAVE_CONFIG and then re-reads, so the UI shows the
 *     server's accepted shape rather than what we optimistically assumed;
 *   - a read re-runs on every `onLlmGatewayStatus` push, so a config edited
 *     outside the window (hand edit, watcher hot-reload) shows up live.
 */

import * as React from 'react'
import type {
  GatewayStatus,
  LlmConfigShape,
  LlmKeyStateShape,
  ProviderDetailShape,
  UsageOverview,
  TimeBucket,
} from './types'

/** Live gateway status, refreshed by the server's 2s push. */
export function useGatewayStatus(): GatewayStatus | null {
  const [status, setStatus] = React.useState<GatewayStatus | null>(null)

  React.useEffect(() => {
    let cancelled = false
    void window.electronAPI.llmGatewayGetStatus?.().then((s) => {
      if (!cancelled && s) setStatus(s as GatewayStatus)
    })

    // Without this the cooldown counters would freeze at the initial fetch.
    const off = window.electronAPI.onLlmGatewayStatus?.((s: unknown) => {
      if (!cancelled) setStatus(s as GatewayStatus)
    })
    return () => {
      cancelled = true
      off?.()
    }
  }, [])

  return status
}

/** Per-key live state, flattened out of the status push. */
export function useKeyStates(): Map<string, LlmKeyStateShape> {
  const status = useGatewayStatus()
  return React.useMemo(() => {
    const m = new Map<string, LlmKeyStateShape>()
    status?.keyStates?.forEach((k) => m.set(`${k.provider}/${k.keyId}`, k))
    return m
  }, [status])
}

/** The whole gateway config, with a reload trigger for after writes. */
export function useLlmConfig(): {
  config: LlmConfigShape | null
  /** Re-read from the server — the only way to see its accepted shape. */
  reload: () => void
} {
  const [config, setConfig] = React.useState<LlmConfigShape | null>(null)
  const [nonce, setNonce] = React.useState(0)

  React.useEffect(() => {
    void window.electronAPI
      .llmGatewayGetConfig?.()
      .then((c: unknown) => setConfig(c as LlmConfigShape | null))
      .catch(() => setConfig(null))
  }, [nonce])

  const reload = React.useCallback(() => setNonce((n) => n + 1), [])
  return { config, reload }
}

/**
 * Usage overview for one time bucket.
 *
 * The filter is resolved server-side (the RPC takes `range`) so every card
 * driven by this hook sees the same window. Aggregating only some charts
 * client-side is what made the old day/week/month switch look like a global
 * filter while quietly moving one bar chart.
 */
export function useUsageOverview(bucket: TimeBucket): {
  overview: UsageOverview | null
  loading: boolean
  reload: () => void
} {
  const [overview, setOverview] = React.useState<UsageOverview | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [nonce, setNonce] = React.useState(0)

  const load = React.useCallback(() => {
    setLoading(true)
    void window.electronAPI
      .llmGatewayGetUsage?.({ range: bucket })
      .then((res: unknown) =>
        setOverview((res as { overview: UsageOverview } | undefined)?.overview ?? null))
      .catch(() => setOverview(null))
      .finally(() => setLoading(false))
  }, [bucket])

  React.useEffect(() => {
    void load()
  }, [load, nonce])

  const reload = React.useCallback(() => setNonce((n) => n + 1), [])
  return { overview, loading, reload }
}

/** Per-provider usage + recent requests, for the provider detail drawer. */
export function useProviderDetail(providerId: string | null): {
  detail: ProviderDetailShape | null
  loading: boolean
  reload: () => void
} {
  const [detail, setDetail] = React.useState<ProviderDetailShape | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [nonce, setNonce] = React.useState(0)

  React.useEffect(() => {
    if (!providerId) {
      setDetail(null)
      return
    }
    let cancelled = false
    setLoading(true)
    // The channel takes the bare id, not an object, and resolves the payload
    // itself (not wrapped in `{ detail }`).
    void window.electronAPI
      .llmGatewayGetProviderDetail?.(providerId)
      .then((res: unknown) => {
        if (!cancelled) setDetail((res as ProviderDetailShape | null) ?? null)
      })
      .catch(() => {
        if (!cancelled) setDetail(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [providerId, nonce])

  return { detail, loading, reload: () => setNonce((n) => n + 1) }
}

/**
 * Persist the config and report whether the server accepted it.
 *
 * The RPC resolves `{ ok: true }` or `{ ok: false, errors }` — it does not throw
 * on validation failure, so a rejected save is a normal return value and the
 * caller keeps its draft. That matters for the preset editor: an empty name
 * must leave the modal open with what was typed, not wipe it.
 */
export function useSaveConfig(): (
  next: LlmConfigShape,
) => Promise<{ ok: true } | { ok: false; error: string }> {
  return React.useCallback(async (next: LlmConfigShape) => {
    const res = (await window.electronAPI.llmGatewaySaveConfig?.(next)) as
      | { ok: true }
      | { ok: false; errors: string[] }
      | undefined
    if (res && res.ok === false) return { ok: false as const, error: res.errors.join('；') }
    if (!res) return { ok: false as const, error: '网关不可用（当前构建缺少该通道）' }
    return { ok: true as const }
  }, [])
}

/**
 * Ask the gateway to probe one provider's upstream.
 *
 * `elapsedMs` is always present from the RPC (success or failure) and is worth
 * surfacing: a 200 after 9s is a different problem from one after 200ms.
 */
export function useTestConnection(): (
  providerId: string,
  keyId?: string,
) => Promise<{ ok: boolean; error?: string; elapsedMs?: number }> {
  return React.useCallback(async (providerId: string, keyId?: string) => {
    const res = (await window.electronAPI.llmGatewayTestConnection?.({
      providerId,
      ...(keyId ? { keyId } : {}),
    })) as { success?: boolean; error?: string; elapsedMs?: number } | undefined
    if (!res) return { ok: false, error: '网关不可用（当前构建缺少该通道）' }
    return {
      ok: res.success ?? false,
      ...(res.error ? { error: res.error } : {}),
      ...(res.elapsedMs !== undefined ? { elapsedMs: res.elapsedMs } : {}),
    }
  }, [])
}

/**
 * Ask a provider's upstream which models it serves.
 *
 * Kept separate from the connection probe: that one needs a model name to
 * send, so it cannot bootstrap a provider that has none yet, which is exactly
 * the state a freshly created provider is in.
 */
export function useListModels(): (
  providerId: string,
  keyId?: string,
) => Promise<{ ok: boolean; error?: string; models: string[]; elapsedMs?: number }> {
  return React.useCallback(async (providerId: string, keyId?: string) => {
    const res = (await window.electronAPI.llmGatewayListModels?.({
      providerId,
      ...(keyId ? { keyId } : {}),
    })) as { success?: boolean; error?: string; models?: string[]; elapsedMs?: number } | undefined
    if (!res) return { ok: false, error: '网关不可用（当前构建缺少该通道）', models: [] }
    return {
      ok: res.success ?? false,
      models: Array.isArray(res.models) ? res.models : [],
      ...(res.error ? { error: res.error } : {}),
      ...(res.elapsedMs !== undefined ? { elapsedMs: res.elapsedMs } : {}),
    }
  }, [])
}

/** Clear one key's cooldown so the scheduler can use it immediately. */
export function useClearKeyCooldown(): (providerId: string, keyId: string) => Promise<boolean> {
  return React.useCallback(async (providerId: string, keyId: string) => {
    const res = (await window.electronAPI.llmGatewayClearKeyCooldown?.({
      provider: providerId,
      keyId,
    })) as { ok?: boolean } | undefined
    return res?.ok ?? false
  }, [])
}
