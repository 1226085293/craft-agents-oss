/**
 * Notices for a supervisor, held until it is between turns.
 *
 * Two things were wrong with handing each notice straight to a running turn:
 *
 * 1. A message sent into a live turn arrives as a steering interruption. The supervisor was pulled
 *    out of what it was doing to read bookkeeping — hand-off results, retry notices — and, when it
 *    was the retry that was asked for, the interruption cancelled the attempt it was chasing.
 * 2. Nothing coalesced them. One task produced two 「连续失败」 notices in a row and the supervisor
 *    answered the same thing twice, because nothing recorded that these were the same subject.
 *
 * So entries are keyed by SUBJECT (`T-1:failures`), not by text. A second notice about a subject
 * replaces the first: one task, one pending message — and only once that one has landed does the
 * supervisor act on its result, which is what makes a three-attempt retry budget mean three attempts
 * instead of three messages.
 *
 * Pure and free of IO so the rule can be tested without a session.
 */
export class SupervisorNoticeQueue {
  private readonly pending = new Map<string, Map<string, string>>()

  /** Hold `text` under `subject` for `sessionId`, replacing anything waiting there. */
  hold(sessionId: string, subject: string, text: string): void {
    const waiting = this.pending.get(sessionId) ?? new Map<string, string>()
    waiting.set(subject, text)
    this.pending.set(sessionId, waiting)
  }

  /** How many notices are waiting for this session (0 when it is free). */
  size(sessionId: string): number {
    return this.pending.get(sessionId)?.size ?? 0
  }

  /** Subjects currently held, in the order they first arrived. */
  subjects(sessionId: string): string[] {
    return [...(this.pending.get(sessionId)?.keys() ?? [])]
  }

  /**
   * Take everything waiting for this session, as one message.
   *
   * One message rather than one per notice: they are reports, and three separate messages start three
   * turns to read one batch. Each line already names its task, so nothing is lost by joining them.
   */
  take(sessionId: string): string | undefined {
    const waiting = this.pending.get(sessionId)
    if (!waiting?.size) return undefined
    this.pending.delete(sessionId)
    return [...waiting.values()].join('\n\n')
  }
}
