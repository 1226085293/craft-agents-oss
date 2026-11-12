import { describe, expect, it } from 'bun:test'
import { formatDecisionAnswerLine } from '../answer-line.ts'
import type { Task } from '../types.ts'

/**
 * The reply must name its task — and say who it is from.
 *
 * Observed: 「完成1.2后暂停」 reached the task supervisor with nothing identifying which task
 * it answered — with two tasks waiting, the words close whichever decision is read first.
 * Observed later: a lane read a system progress report as the user's words and displayed
 * 「用户拍板放行」 with no answer anywhere in the record. The header therefore carries
 * 消息来源/消息类型/效力, and the lane's rule is 看报头，不看括号.
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

describe('the delivered answer names its task and its source', () => {
  it('carries the header: source, type with task id, and effect', () => {
    const line = formatDecisionAnswerLine(task, '完成1.2后暂停')
    expect(line).toContain('消息来源：用户（任务卡拍板）')
    expect(line).toContain('消息类型：拍板答复 · 任务 T-1')
    expect(line).toContain('效力：')
    expect(line).toContain('task_update')
  })

  it('keeps the words verbatim below the header', () => {
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
    const line = formatDecisionAnswerLine(done, '好')
    expect(line).toContain('消息类型：拍板答复 · 任务 T-2')
    expect(line).toContain('好')
    expect(line).not.toContain('未完成步骤')
  })
})
