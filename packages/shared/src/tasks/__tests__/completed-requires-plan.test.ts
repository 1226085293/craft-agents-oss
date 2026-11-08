import { describe, expect, it } from 'bun:test'
import { applyTransition } from '../state.ts'
import { resumeDecisionFor, answerEndsTask } from '../resume-decision.ts'
import { formatFrontierLine } from '../brief.ts'
import type { Task } from '../types.ts'

/**
 * 「完成」 and 「停止」 are different outcomes, and the system conflated them.
 *
 * The user said 「停止剩下的任务」. The supervisor set `completed`; the plan still showed
 * 「1 doing」 and 「2 todo」. The board read finished, the checklist read unfinished, and the
 * next session inherited a half-done plan from a task that no longer existed.
 */
function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'T-1',
    name: '状态图标验证',
    instruction: '建立任务',
    status: 'running',
    supervisorSessionId: 's1',
    sessionIds: ['s2'],
    handoffs: [],
    lifecycle: { errorCount: 0, consecutiveFailures: 0 },
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    spec: {
      scope: 'x',
      cwd: '/tmp',
      plan: [
        { id: '1', title: '写文件', status: 'doing' },
        { id: '1.1', title: '创建', status: 'done' },
        { id: '2', title: '收尾', status: 'todo' },
      ],
    },
    ...overrides,
  } as Task
}

describe('completing a task whose plan is not finished', () => {
  it('is refused, and names what is left', () => {
    expect(() => applyTransition(task(), 'completed', { now: 2 })).toThrow(/1|2/)
  })

  it('says stopping is canceled, not completed', () => {
    expect(() => applyTransition(task(), 'completed', { now: 2 })).toThrow(/canceled/)
  })

  it('allows canceled for the same task', () => {
    const result = applyTransition(task(), 'canceled', { now: 2 })
    expect(result.task.status).toBe('canceled')
  })

  it('allows completed when everything is closed', () => {
    const done = task({
      spec: {
        scope: 'x',
        cwd: '/tmp',
        plan: [
          { id: '1', title: '写文件', status: 'done' },
          { id: '1.1', title: '创建', status: 'done' },
          { id: '2', title: '收尾', status: 'done' },
        ],
      } as never,
    })
    expect(applyTransition(done, 'completed', { now: 2 }).task.status).toBe('completed')
  })

  it('allows completed for a task with no plan at all', () => {
    expect(applyTransition(task({ spec: { scope: 'x', cwd: '/tmp' } as never }), 'completed', { now: 2 }).task.status).toBe('completed')
  })
})

/**
 * 「停止剩下的任务」 was not in the end-words list, so the resume path lifted the pause and
 * handed the worker a brief that ended with instructions to expand the next outline.
 */
describe('a reply that stops the rest', () => {
  it('is recognised as an ending', () => {
    expect(answerEndsTask('停止剩下的任务，然后将docs改名为docs2')).toBe(true)
    expect(answerEndsTask('到此为止，结束任务')).toBe(true)
  })

  it('is not confused with a release', () => {
    expect(answerEndsTask('放行步骤 2（收尾），把任务做完')).toBe(false)
    expect(answerEndsTask('完成1.2后暂停')).toBe(false)
  })

  it('refuses the resume', () => {
    const verdict = resumeDecisionFor(
      task({
        decision: {
          category: 'direction',
          label: 'x',
          reason: 'x',
          askedAt: 1,
          deadlineAt: 2,
          resolvedAt: 3,
          answer: { text: '停止剩下的任务，然后将docs改名为docs2', at: 4 },
        },
      }),
    )
    expect(verdict.allowed).toBe(false)
  })

  it('and the brief does not tell the worker to continue', () => {
    const line = formatFrontierLine(
      task({
        decision: {
          category: 'direction',
          label: 'x',
          reason: 'x',
          askedAt: 1,
          deadlineAt: 2,
          resolvedAt: 3,
          answer: { text: '停止剩下的任务，然后将docs改名为docs2', at: 4 },
        },
      }),
    )
    expect(line).toContain('叫停')
    // The contradiction that made the worker continue.
    expect(line).not.toContain('还没有小节')
    expect(line).not.toContain('直接开始第一个小节')
  })
})
