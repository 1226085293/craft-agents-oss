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
/** Default values for new sessions */
export const defaultSessionOptions: SessionOptions = {
  permissionMode: 'ask', // Default to ask mode (prompt for permissions)
  thinkingLevel: DEFAULT_THINKING_LEVEL, // Default to 'medium' level
  // `strategy` is deliberately omitted: the server resolves it from the
  // agent profile (then the first enabled group), so the renderer has no
  // second copy to keep in sync.
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
  return merged
}

