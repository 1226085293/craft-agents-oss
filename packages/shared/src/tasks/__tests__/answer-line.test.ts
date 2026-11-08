import { describe, expect, it } from 'bun:test'
import { formatDecisionAnswerLine } from '../answer-line.ts'
import type { Task } from '../types.ts'

/**
 * The reply must name its task.
 *
 * Observed: 「完成1.2后暂停」 reached the task supervisor with nothing identifying which task
 * it answered — with two tasks waiting, the words close whichever decision is read first.
 */
const task = {
  id: 'T-1',
  spec: {
    plan: [
      { id: '1', title: 'a', status: 'done' },
      { id: '1.2', title: 'b', status: 'todo' },
      { id: '2', title: 'c', status: 'todo' },
    ],
  },
} as unknown as Task

describe('the delivered answer names its task', () => {
  it('prefixes the task id', () => {
    expect(formatDecisionAnswerLine(task, '完成1.2后暂停')).toContain('〔任务 T-1 拍板答复〕')
  })

  it('keeps the words verbatim after the prefix', () => {
    expect(formatDecisionAnswerLine(task, '  完成1.2后暂停  ')).toContain('完成1.2后暂停')
  })

  it('says what is still open, so the answer can be applied without re-reading the plan', () => {
    const line = formatDecisionAnswerLine(task, '放行')
    expect(line).toContain('未完成步骤：1.2、2')
    // A finished step is not "still open".
    expect(line).not.toContain('未完成步骤：1、')
  })

  it('omits the remaining line when nothing is left', () => {
    const done = {
      id: 'T-2',
      spec: { plan: [{ id: '1', title: 'a', status: 'done' }] },
    } as unknown as Task
    expect(formatDecisionAnswerLine(done, '好')).toBe('〔任务 T-2 拍板答复〕好')
  })
})
