/**
 * Defense Module — Early-Stop Protection
 *
 * Unified entry point for the anti early-stop defense (L1 + L2).
 *
 * - L1 `system-discipline.ts`: execution-discipline block appended to the
 *   effective system prompt (goal-checklist self-check, actions-before-words,
 *   failure fallback, artifact read-back, balanced wrap-up).
 * - L2 `complexity-score.ts`: side-effect-weighted scoring of tool calls.
 * - L2 `session-lifecycle.ts`: FSM + resume guardrails.
 * - `evaluator.ts`: orchestrates L2 post-stop evaluation.
 *
 * Layer 3 (idle-word regex) was removed per issue #1 — regex matches word
 * surfaces, not semantics, and produced false positives.
 *
 * The whole defense is gated by a single user-controlled boolean in the
 * **init message**: `defenseEnabled`. L1 + L2 are both controlled by it;
 * there are no sub-policies.
 */

import { withExecutionDiscipline } from './system-discipline.ts';
import { DefenseEvaluator } from './evaluator.ts';

export {
  DefenseEvaluator,
  type DefenseEvaluationResult,
  type DefenseOptions,
} from './evaluator.ts';
export {
  EXECUTION_DISCIPLINE,
  EXECUTION_DISCIPLINE_EN,
  DISCIPLINE_MARKER,
  withExecutionDiscipline,
  stripExecutionDiscipline,
} from './system-discipline.ts';
export {
  complexityScore,
  classify,
  WEIGHTS,
  type ComplexityResult,
  type ToolCallLike,
} from './complexity-score.ts';
export { FsWatch, type FsWriteEvidence } from './fs-watch.ts';
export {
  State,
  SessionLifecycle,
  fnv1a,
  type SessionLifecycleOptions,
} from './session-lifecycle.ts';

/** Default defense master switch when omitted from the init message. */
export const DEFAULT_DEFENSE_ENABLED = true;

/**
 * Resolve the defense master switch from the init message.
 * Omitted/undefined → default (enabled). Explicit boolean wins.
 */
export function resolveDefenseEnabled(value: boolean | undefined): boolean {
  return value ?? DEFAULT_DEFENSE_ENABLED;
}
