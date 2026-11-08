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

  it('is visible to whoever derives the same question key', () => {
    // Task page: task id + when the question was asked.
    rememberDecisionAnswer('T-1', 1_700_000_000_000, '放行')
    // Conversation card derives the same key from the same decision.
    expect(readDecisionAnswer('T-1', 1_700_000_000_000)).toBe('放行')
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
    // The same task stops again later; that is a different question.
    expect(readDecisionAnswer('T-1', 1_700_000_500_000)).toBeNull()
  })
})
