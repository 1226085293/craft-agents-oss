/**
 * Which decision cards have already been answered.
 *
 * The answer used to be remembered in `React.useState` and nowhere else, so a reload
 * brought the buttons back on a question that was already answered — a stale control
 * that invites the same answer twice. A decision card is a question, and a question
 * that has been answered must not keep asking.
 *
 * Stored per request id (the `DecisionRequest.id` written into the message row, or the
 * task id plus its `askedAt` for the task card), so the two surfaces of one decision
 * agree and the state outlives the renderer.
 *
 * `localStorage` rather than a store round-trip on purpose: this is UI memory about what
 * the reader already did on this machine, not a fact about the task. The task's own
 * record carries `decision.answer` for anything that must be authoritative.
 */
const KEY_PREFIX = 'craft.decisionAnswer:'

/** Renderer storage is not guaranteed (tests, private mode); absence is not an error. */
function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function readDecisionAnswer(key: string): string | null {
  try {
    return store()?.getItem(KEY_PREFIX + key) ?? null
  } catch {
    return null
  }
}

export function rememberDecisionAnswer(key: string, answer: string): void {
  try {
    store()?.setItem(KEY_PREFIX + key, answer)
  } catch {
    // A full or unavailable store must not break answering.
  }
}

/** A task card's key: the decision it is showing, not the task, which can ask again. */
export function taskDecisionKey(taskId: string, askedAt: number | undefined): string {
  return `task:${taskId}:${askedAt ?? 0}`
}

/** A chat card's key: the request id, which is stable in the persisted message row. */
export function requestDecisionKey(requestId: string): string {
  return `request:${requestId}`
}
