import {
  isLocalConnection,
  type LlmConnection,
} from '@config/llm-connections'

/** A single entry of `LlmConnection.models` — either a full definition or a bare id. */
type ConnectionModel = NonNullable<LlmConnection['models']>[number]

/**
 * Format token count for display (e.g., 1500 -> "1.5k", 200000 -> "200k").
 * Shared by the desktop model dropdown and the compact (drawer) model picker.
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}k`
  }
  return tokens.toString()
}

/**
 * Strip the "pi/" prefix from model IDs/display names so the user sees a
 * provider-agnostic label in the picker (e.g., "pi/claude-opus" → "claude-opus").
 */
export function stripPiPrefixForDisplay(value: string): string {
  return value.startsWith('pi/') ? value.slice(3) : value
}

/**
 * Models offered by a connection in the picker, honouring the per-connection
 * `enabledModels` allowlist.
 *
 * `enabledModels` empty/absent means "everything is enabled" (back-compat with
 * connections created before the allowlist existed), so the raw list is
 * returned untouched in that case.
 */
export function getAvailableModels(
  connection: Pick<LlmConnection, 'models' | 'enabledModels'> | null | undefined,
  fallback: ConnectionModel[] = [],
): ConnectionModel[] {
  const models = connection?.models?.length ? connection.models : fallback
  const enabled = connection?.enabledModels
  if (!enabled?.length) return models
  const allowlist = new Set(enabled)
  return models.filter(m => allowlist.has(typeof m === 'string' ? m : m.id))
}

export type ConnectionGroup = [groupName: string, connections: LlmConnection[]]

/**
 * Group connections for hierarchical picker rendering.
 *
 * The group is decided by the **auth provider**, not `providerType`. There is one backend now, so
 * `providerType` is `pi` or `pi_compat` for everything; what used to make a connection
 * 「Anthropic」 was `providerType === 'anthropic'`, and that value no longer exists. A connection
 * whose `piAuthProvider` is `anthropic` is the same thing it always was — a connection to
 * api.anthropic.com — so that field is what the heading follows.
 *
 * Order is significant for UI: Anthropic, Local, Craft Agents Backend. Empty groups are dropped.
 */
export function groupConnectionsByProvider<T extends LlmConnection>(
  connections: readonly T[],
): Array<[string, T[]]> {
  const groups: Record<string, T[]> = {
    'Anthropic': [],
    'Local': [],
    'Craft Agents Backend': [],
  }
  for (const conn of connections) {
    const authProvider = conn.piAuthProvider
    if (conn.providerType === 'pi_compat' && isLocalConnection(conn)) {
      groups['Local'].push(conn)
    } else if (authProvider === 'anthropic') {
      // api.anthropic.com, reached through Pi — this used to be `providerType: 'anthropic'`.
      groups['Anthropic'].push(conn)
    } else {
      groups['Craft Agents Backend'].push(conn)
    }
  }
  return Object.entries(groups).filter(([, conns]) => conns.length > 0)
}
