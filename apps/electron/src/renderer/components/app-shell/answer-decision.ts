/**
 * How a person's answer leaves a card.
 *
 * Two surfaces ask the same question — the card in the conversation and the decision section
 * on the task page — and each used to build its own request. They drifted exactly where it
 * mattered: one passed the task id and the session it was asked in, the other passed neither,
 * so the same reply arrived at the supervisor named in one case and as bare words in the
 * other. Same intent, two implementations, different behaviour.
 *
 * One function, one argument shape, so adding a field to the answer does not mean finding
 * every card that can produce one.
 */
export interface DecisionAnswer {
  workspaceId: string
  /** The task the card belongs to, when it knows one. */
  taskId?: string
  /** The session the question was shown in; the server's fallback when `taskId` is absent. */
  askedBySessionId?: string
  /**
   * Which of the task's questions this reply closes.
   *
   * Without it the server closes 「the newest open question」, so with several cards on screen a
   * click on the first one answered the last — observed live as an answer recorded against the
   * wrong question, followed by 「no pending decision on this task」 on the card that was left.
   */
  decisionId?: string
  text: string
}

export interface DecisionAnswerResult {
  accepted: boolean
  reason?: string
}

export async function submitDecisionAnswer(answer: DecisionAnswer): Promise<DecisionAnswerResult> {
  const text = answer.text.trim()
  if (!text) return { accepted: false, reason: '答复是空的' }

  // The preload builds this method from CHANNEL_MAP, so it exists in every build that
  // ships the map; the old `if (api.tasksAnswer)` guard was only hiding a missing
  // declaration (the parity test caught it). No version skew to defend against.
  const result = await window.electronAPI.tasksAnswer(
    answer.workspaceId,
    answer.taskId ?? '',
    text,
    answer.askedBySessionId,
    answer.decisionId,
  )
  // The server knows which task it refused for; pass its reason through rather than
  // inventing a generic one, because "no pending decision" and "no task to answer" are
  // different facts and the person can act on the difference.
  return { accepted: result?.accepted !== false, ...(result?.reason ? { reason: result.reason } : {}) }
}
