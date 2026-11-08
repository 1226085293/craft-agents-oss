/**
 * Which decision cards have already been answered — shared by both surfaces.
 *
 * The same question is drawn twice: as a card in the conversation, and as the decision
 * section of the task detail page. Each used to remember its own answer under its own
 * key, so answering one left the other offering its buttons — and answering the second
 * sent the reply again. A question with two answer paths is a question that can be
 * answered twice.
 *
 * So the key is the QUESTION, not the surface: task id plus the moment it was asked.
 * Both cards derive the same key from the same decision, which is what makes one answer
 * visible in both places. The answer also carries the time it was given, so a decision
 * asked later on the same task is a different question and starts unanswered.
 *
 * `localStorage` because this is UI memory about what this reader already did, not a fact
 * about the task. The task's own record carries `decision.answer` for anything that must
 * be authoritative across machines.
 */
const KEY_PREFIX = 'craft.decisionAnswer:'

interface StoredAnswer {
  text: string
  /** When it was given. Compared against a decision's `askedAt` to tell questions apart. */
  at: number
}

/** Renderer storage is not guaranteed (tests, private mode); absence is not an error. */
function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function keyFor(taskId: string, askedAt: number | undefined): string {
  return `${KEY_PREFIX}task:${taskId}:${askedAt ?? 0}`
}

/**
 * The answer for this question, if this reader already gave one.
 *
 * `askedAt` guards the re-ask case: a task can legitimately stop for a decision more than
 * once, and the second question must not inherit the first one's answer.
 */
export function readDecisionAnswer(taskId: string, askedAt: number | undefined): string | null {
  try {
    const raw = store()?.getItem(keyFor(taskId, askedAt))
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredAnswer
    return typeof parsed?.text === 'string' ? parsed.text : null
  } catch {
    return null
  }
}

const listeners = new Set<() => void>()

export function rememberDecisionAnswer(taskId: string, askedAt: number | undefined, answer: string): void {
  try {
    const payload: StoredAnswer = { text: answer, at: Date.now() }
    store()?.setItem(keyFor(taskId, askedAt), JSON.stringify(payload))
  } catch {
    // A full or unavailable store must not break answering.
  }
  // The other surface is mounted somewhere else and has no way to know. Telling the
  // subscribers is what turns "one card answered" into "the question is answered".
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // A broken listener must not stop the rest.
    }
  }
}

/**
 * Re-read on any answer anywhere.
 *
 * Returns the unsubscribe, so a card can stop listening when it unmounts.
 */
export function subscribeDecisionAnswers(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
