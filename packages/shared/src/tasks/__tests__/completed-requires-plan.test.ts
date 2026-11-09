import { describe, expect, it } from 'bun:test'
import { applyTransition } from '../state.ts'
import { resumeDecisionFor } from '../resume-decision.ts'
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
 * Who decides what the reply meant: a model, not a keyword table.
 *
 * The resume path reads one fact — has anybody written an authorisation since the reply arrived
 * (`spec.authorizedAt` vs `decision.answer.at`) — and refuses until they have. No words are read.
 */
describe('an answer nobody has acted on', () => {
  const answered = (over: Record<string, unknown> = {}) =>
    task({
      decision: {
        category: 'direction',
        label: 'x',
        reason: 'x',
        askedAt: 1,
        deadlineAt: 2,
        resolvedAt: 3,
        answer: { text: '停止剩下的任务，然后将docs改名为docs2', at: 100 },
      },
      ...over,
    } as never)

  it('does not resume the task', () => {
    const verdict = resumeDecisionFor(answered())
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.why).toContain('翻译成指令')
  })

  it('resumes once somebody wrote a directive after the reply', () => {
    const verdict = resumeDecisionFor(
      answered({ spec: { scope: 'x', cwd: '/tmp', directive: { text: '把收尾做完', at: 200 } } } as never),
    )
    expect(verdict.allowed).toBe(true)
    if (verdict.allowed) expect(verdict.directive).toBe('把收尾做完')
  })

  it('stays paused when the boundary predates the reply', () => {
    // The directive from the PREVIOUS answer must not be read as this answer's meaning.
    const verdict = resumeDecisionFor(
      answered({ spec: { scope: 'x', cwd: '/tmp', directive: { text: '做到 1.2 就停', at: 50 } } } as never),
    )
    expect(verdict.allowed).toBe(false)
  })

  it('does not resume a task whose question is still open', () => {
    const verdict = resumeDecisionFor(
      task({
        decision: { category: 'direction', label: 'x', reason: 'x', askedAt: 1, deadlineAt: 2 },
      } as never),
    )
    expect(verdict.allowed).toBe(false)
  })

  it('resumes a task that never asked anything', () => {
    expect(resumeDecisionFor(task()).allowed).toBe(true)
  })
})
