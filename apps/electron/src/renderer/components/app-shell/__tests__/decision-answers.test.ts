import { beforeEach, describe, expect, it } from 'bun:test'
import {
  readDecisionAnswer,
  rememberDecisionAnswer,
  subscribeDecisionAnswers,
} from '../decision-answers.ts'

/**
 * One question, two cards. Answering either must settle both, or the second one keeps
 * offering buttons and the reply goes out twice.
 */
function memoryStorage(): void {
  const map = new Map<string, string>()
  ;(globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    },
  } as Storage
}

describe('one answer, both surfaces', () => {
  beforeEach(() => memoryStorage())

  /**
   * The two surfaces read `askedAt` from different records — the task's decision and the
   * card's request payload — and those are two different timestamps. Keying on it meant
   * they never agreed, so answering the task page left the conversation card's buttons
   * live and the reply could go out twice.
   */
  it('is visible from the other surface even when its askedAt differs', () => {
    rememberDecisionAnswer('T-1', 1_700_000_000_000, '放行')

    // The card's payload carries a slightly different timestamp for the same question.
    expect(readDecisionAnswer('T-1', 1_700_000_000_123)).toBe('放行')
    expect(readDecisionAnswer('T-1', undefined)).toBe('放行')
  })

  it('tells the other card as soon as one answers', () => {
    let notified = 0
    const off = subscribeDecisionAnswers(() => {
      notified += 1
    })

    rememberDecisionAnswer('T-1', 1_700_000_000_000, '放行')

    expect(notified).toBe(1)
    off()
    rememberDecisionAnswer('T-1', 1_700_000_000_000, '放行')
    // Unsubscribed is unsubscribed: a stale card must not react.
    expect(notified).toBe(1)
  })

  it('does not let a later question inherit an earlier answer', () => {
    rememberDecisionAnswer('T-1', 1_700_000_000_000, '放行')
    // The same task stops again ten minutes after the answer: a different question. (A few
    // seconds of drift is tolerated on purpose — the two surfaces stamp `askedAt` from
    // different records, and treating that as "previous question" puts the buttons back.)
    expect(readDecisionAnswer('T-1', Date.now() + 10 * 60_000)).toBeNull()
  })
})
