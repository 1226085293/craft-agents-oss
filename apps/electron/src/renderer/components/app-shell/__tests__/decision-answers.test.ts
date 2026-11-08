import { beforeEach, describe, expect, it } from 'bun:test'
import {
  readDecisionAnswer,
  rememberDecisionAnswer,
  subscribeDecisionAnswers,
} from '../decision-answers.ts'

/**
 * One question, two cards; and a new question is a new question.
 *
 * Keying on the task alone made every answer belong to the task forever. A time window was
 * supposed to guard that, but the very next question usually arrives within it — the answer
 * resumes the task, the task stops again seconds later — so the new card showed the previous
 * reply as if it were its own. The decision's `askedAt` identifies the question; two questions
 * on one task are two keys.
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

describe('one answer, one question', () => {
  beforeEach(() => memoryStorage())

  it('is visible from the other surface, which derives the same question key', () => {
    rememberDecisionAnswer('T-1', 1_700_000_000_000, '放行')
    // Both cards carry the decision's own askedAt, so both derive this key.
    expect(readDecisionAnswer('T-1', 1_700_000_000_000)).toBe('放行')
  })

  it('does not leak into the next question on the same task', () => {
    rememberDecisionAnswer('T-1', 1_700_000_000_000, '完成1.2后暂停')
    // A new decision, seconds later — the case that failed: the task stopped again right after
    // the answer resumed it.
    expect(readDecisionAnswer('T-1', 1_700_000_003_000)).toBeNull()
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
    expect(notified).toBe(1)
  })
})
