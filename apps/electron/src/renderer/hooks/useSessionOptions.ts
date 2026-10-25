/**
 * Session Options Types
 *
 * Type definitions and helpers for session-scoped settings.
 * The actual hook is in AppShellContext.tsx as useSessionOptionsFor().
 *
 * ADDING A NEW SESSION OPTION:
 * 1. Add field to SessionOptions interface below
 * 2. Update defaultSessionOptions
 * 3. Add UI control in FreeFormInput.tsx (or wherever needed)
 */

import type { PermissionMode } from '../../shared/types'
import type { ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels'
import { DEFAULT_THINKING_LEVEL } from '@craft-agent/shared/agent/thinking-levels'

/**
 * All session-scoped options in one place.
 */
export interface SessionOptions {
  /** Permission mode ('safe', 'ask', 'allow-all') */
  permissionMode: PermissionMode
  /** Monotonic version from backend permission mode state (used to ignore stale events) */
  permissionModeVersion?: number
  /** Session-level thinking level — sticky, persisted. See {@link ThinkingLevel}. */
  thinkingLevel: ThinkingLevel
  /**
   * LLM gateway strategy id this session routes through.
   *
   * Sticky and persisted like `thinkingLevel`. Empty means "not chosen yet",
   * which the composer renders as an explicit prompt rather than silently
   * falling back — picking a routing policy should be a visible act.
   */
  strategy?: string
}

/**
 * Strategy the user set as the default in Settings → LLM 管理.
 *
 * Stored in localStorage because it is a UI preference (the gateway has no
 * per-user default field); `defaultSessionOptions` is evaluated once per
 * window, so a change there applies to sessions started afterwards.
 */
export const DEFAULT_STRATEGY_STORAGE_KEY = 'llm-proto.default-strategy'

export function readDefaultStrategy(): string {
  try {
    return typeof localStorage !== 'undefined' ? (localStorage.getItem(DEFAULT_STRATEGY_STORAGE_KEY) ?? '') : ''
  } catch {
    return ''
  }
}

/** Default values for new sessions */
export const defaultSessionOptions: SessionOptions = {
  permissionMode: 'ask', // Default to ask mode (prompt for permissions)
  thinkingLevel: DEFAULT_THINKING_LEVEL, // Default to 'medium' level
  // `strategy` is deliberately omitted. It lives in localStorage and can be
  // changed from Settings while this window is open, so freezing it at module
  // load made every new session fall back to "未选择策略组" until a reload.
  // Callers resolve it at read time via `readDefaultStrategy()`.
}

/** Type for partial updates to session options */
export type SessionOptionUpdates = Partial<SessionOptions>

/** Helper to merge session options with updates */
export function mergeSessionOptions(
  current: SessionOptions | undefined,
  updates: SessionOptionUpdates
): SessionOptions {
  const merged: SessionOptions = {
    ...defaultSessionOptions,
    ...(current ?? {}),
    ...updates,
  }
  // Resolve the strategy preference at call time. An explicit value — including
  // the empty string the user picks to mean "no default" — always wins; only an
  // untouched session picks up the current default.
  if (merged.strategy === undefined) merged.strategy = readDefaultStrategy()
  return merged
}

