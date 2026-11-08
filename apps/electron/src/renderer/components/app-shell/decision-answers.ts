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

/**
 * Keyed by task alone, not by when it was asked.
 *
 * The two surfaces derive their `askedAt` from different records — the task's decision and
 * the card's request payload — and those are two different timestamps. Using them in the
 * key meant the task page and the conversation never agreed on which answer belonged to
 * which question, so answering one left the other's buttons live.
 *
 * A task id is stable, so it is the key. Whether the stored answer still applies is decided
 * by `readDecisionAnswer`'s `askedAt` comparison: an answer given before the current
 * question was asked belongs to a previous one.
 */
function keyFor(taskId: string): string {
  return `${KEY_PREFIX}task:${taskId}`
}

/**
 * The answer for this question, if this reader already gave one.
 *
 * `askedAt` guards the re-ask case: a task can legitimately stop for a decision more than
 * once, and the second question must not inherit the first one's answer.
 */
export function readDecisionAnswer(taskId: string, askedAt: number | undefined): string | null {
  try {
    const raw = store()?.getItem(keyFor(taskId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredAnswer
    if (typeof parsed?.text !== 'string') return null
    // An answer older than the question on screen is about a previous question: the task
    // can legitimately stop again, and that new question must start unanswered.
    if (typeof askedAt === 'number' && typeof parsed.at === 'number' && parsed.at < askedAt) {
      return null
    }
    return parsed.text
  } catch {
    return null
  }
}

const listeners = new Set<() => void>()

export function rememberDecisionAnswer(taskId: string, askedAt: number | undefined, answer: string): void {
  try {
    const payload: StoredAnswer = { text: answer, at: Date.now() }
    store()?.setItem(keyFor(taskId), JSON.stringify(payload))
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
