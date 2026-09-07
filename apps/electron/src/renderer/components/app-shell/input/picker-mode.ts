/**
 * Pure render-mode decision for the chat-input model picker.
 *
 * The picker has four mutually-exclusive UIs. Centralizing the truth table
 * here keeps the chevron on the trigger button and the popover content
 * branch in agreement, and makes the rule trivially unit-testable.
 *
 * Precedence (highest first):
 *   1. unavailable     — the session's connection is gone AND no other
 *                        connection exists to switch to (true dead end)
 *   2. switcher        — anything with ≥2 connections configured, or a
 *                        session whose connection was deleted with ≥1
 *                        connection remaining (mid-session model switching
 *                        is engine-supported: the Pi SDK applies a new model
 *                        between turns with full context, so users may pick
 *                        a different connection/model at ANY time, not just
 *                        before the first message)
 *   3. locked-single   — `pi_compat` connection with ≤1 model AND no other
 *                        connection to switch to: there is genuinely nothing
 *                        else to pick, so show the single row as locked
 *   4. flat            — fall-through: list models for the active connection
 *
 * History:
 * - #727: `switcher` deliberately wins over `locked-single` so users whose
 *   default was a single-model `pi_compat` connection could still reach the
 *   switcher on a fresh chat.
 * - Mid-session switching (2026-08-22): previously the switcher required an
 *   empty session because the backend rejected connection changes after the
 *   first message. With hot connection switching in place, non-empty
 *   sessions reach the switcher too; `locked-single` now only fires when
 *   there is truly no alternative to display.
 * - Deleted-connection escape (2026-09-07): a session whose locked
 *   connection was deleted used to fall into `unavailable` — a dead end
 *   telling users to create a new session. The backend hot-switch only
 *   validates the TARGET connection, so switching was always safe; the
 *   switcher is also the only picker UI whose selection route
 *   (`onConnectionChange`) actually rebinds the session's connection
 *   (`flat`/`locked-single` only call `onModelChange`, which cannot rebind
 *   a locked session). `unavailable` therefore requires connectionCount=0.
 */

export type PickerMode = 'unavailable' | 'switcher' | 'locked-single' | 'flat'

export interface PickerModeInput {
  connectionUnavailable: boolean
  /** Non-null when the active connection is `pi_compat` with ≤1 model. */
  connectionDefaultModel: string | null
  /** True when the session has no messages yet. Kept for API compat. */
  isEmptySession: boolean
  /** Total number of configured connections in the workspace. */
  connectionCount: number
}

export function derivePickerMode(input: PickerModeInput): PickerMode {
  // Session's connection was deleted: escape through the switcher whenever
  // anything is configured (even a single connection — the switcher's pick
  // route rebinds the session). Dead-end only when there is nothing at all.
  if (input.connectionUnavailable) {
    return input.connectionCount > 0 ? 'switcher' : 'unavailable'
  }
  if (input.connectionCount > 1) return 'switcher'
  if (input.connectionDefaultModel != null) return 'locked-single'
  return 'flat'
}
