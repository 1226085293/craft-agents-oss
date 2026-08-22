/**
 * Pure render-mode decision for the chat-input model picker.
 *
 * The picker has four mutually-exclusive UIs. Centralizing the truth table
 * here keeps the chevron on the trigger button and the popover content
 * branch in agreement, and makes the rule trivially unit-testable.
 *
 * Precedence (highest first):
 *   1. unavailable     — current connection is gone / error state
 *   2. switcher        — multiple connections configured (mid-session model
 *                        switching is engine-supported: the Pi SDK applies a
 *                        new model between turns with full context, so users
 *                        may pick a different connection/model at ANY time,
 *                        not just before the first message)
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
  if (input.connectionUnavailable) return 'unavailable'
  if (input.connectionCount > 1) return 'switcher'
  if (input.connectionDefaultModel != null) return 'locked-single'
  return 'flat'
}
