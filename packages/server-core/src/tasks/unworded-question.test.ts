import { describe, expect, it } from 'bun:test'
import type { Task } from '@craft-agent/shared/tasks'
import {
  MAX_UNWORDED_QUESTION_NUDGES,
  UNWORDED_QUESTION_GRACE_MS,
  applyFindings,
  inspectTasks,
  type WatchdogDeps,
} from './task-watchdog.ts'

const NOW = 1_800_000_000_000

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'T-1',
    name: '状态图标验证',
    instruction: '只做 1.1',
    status: 'paused',
    pauseReason: 'asking',
    createdAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
    sessionIds: [],
    handoffs: [],
    lifecycle: { errorCount: 0, consecutiveFailures: 0 },
    stats: { runs: 1, activeMs: 0 },
    supervisorSessionId: 'sess_sup',
    ...over,
  } as Task
}

function deps(tasks: Task[]): WatchdogDeps {
  return {
    listTasks: () => tasks,
    sessionExists: () => true,
    notify: () => {},
    pause: () => {},
    now: () => NOW,
  }
}

/**
 * The state T-2 got stuck in, reproduced.
 *
 * A run handed back and the task paused on a decision; the supervisor's turn that should have
 * put that decision into words was cut off. The task then said 「等你拍板」 over an empty card,
 * nothing was running, and no rule looked at a paused task — so it waited for an answer nobody
 * had been asked for.
 */
describe('a pause whose question was never worded', () => {
  const asked = (over: Partial<Task> = {}) =>
    task({
      decision: {
        category: 'direction',
        label: '这一段做完了，等你决定',
        reason: '执行者把这一段交回来了',
        askedAt: NOW - UNWORDED_QUESTION_GRACE_MS - 1,
        deadlineAt: NOW + 60 * 60_000,
      },
      ...over,
    } as Partial<Task>)

  it('is noticed instead of waited on forever', () => {
    expect(inspectTasks(deps([asked()])).map((f) => f.kind)).toEqual(['unworded_question'])
  })

  it('is left alone while the supervisor still has time to say it', () => {
    const fresh = asked({
      decision: {
        category: 'direction',
        label: '这一段做完了，等你决定',
        reason: '',
        askedAt: NOW - 5_000,
        deadlineAt: NOW + 60 * 60_000,
      },
    })

    expect(inspectTasks(deps([fresh]))).toEqual([])
  })

  it('is left alone once the words arrive', () => {
    const worded = asked({
      pauseReason: 'needs_decision',
      decision: {
        category: 'direction',
        label: '这一段做完了，等你决定',
        reason: '',
        question: '仅放行 1.2，其余之后再定？',
        askedAt: NOW - UNWORDED_QUESTION_GRACE_MS - 1,
        deadlineAt: NOW + 60 * 60_000,
      },
    })

    expect(inspectTasks(deps([worded]))).toEqual([])
  })

  it('is left alone once the person has answered', () => {
    const answered = asked({
      decision: {
        category: 'direction',
        label: '这一段做完了，等你决定',
        reason: '',
        askedAt: NOW - UNWORDED_QUESTION_GRACE_MS - 1,
        deadlineAt: NOW + 60 * 60_000,
        resolvedAt: NOW - 1_000,
        resolution: 'approved',
      },
    })

    expect(inspectTasks(deps([answered]))).toEqual([])
  })

  it('has a limit on how many times it is nudged', () => {
    // The counter lives on the task so that a restart cannot restart the nudge loop.
    const nudged = asked({ stats: { runs: 1, activeMs: 0, unwordedRetries: MAX_UNWORDED_QUESTION_NUDGES } })

    // Still a finding — the task is still stuck — but the handler switches to telling the person
    // what is wrong instead of asking the supervisor again.
    expect(inspectTasks(deps([nudged])).map((f) => f.kind)).toEqual(['unworded_question'])
  })
})

/**
 * The nudge must not cancel the answer it is asking for.
 *
 * T-2 was nudged 32 times. The supervisor was mid-turn each time — composing the very question the
 * nudge asked for — and a message into a running turn arrives as a steering interruption, so every
 * ask cut the attempt short. The task could never be un-stuck by a system that kept interrupting
 * the fix.
 */
describe('nudging a supervisor about an unwritten question', () => {
  function run(over: { busy?: boolean; attempts?: number } = {}) {
    const sent: string[] = []
    const counted: number[] = []
    const stuck = task({
      pauseReason: 'asking',
      stats: { runs: 1, activeMs: 0, ...(over.attempts === undefined ? {} : { unwordedRetries: over.attempts }) },
      decision: {
        category: 'direction',
        label: '这一段做完了，等你决定',
        reason: '',
        askedAt: NOW - UNWORDED_QUESTION_GRACE_MS - 1,
        deadlineAt: NOW + 60 * 60_000,
      },
    } as Partial<Task>)

    applyFindings(
      {
        listTasks: () => [stuck],
        sessionExists: () => true,
        notify: (_id, text) => sent.push(text),
        pause: () => {},
        recordUnwordedRetry: (_id, attempts) => counted.push(attempts),
        sessionIdle: () => over.busy !== true,
        now: () => NOW,
      },
      inspectTasks({
        listTasks: () => [stuck],
        sessionExists: () => true,
        notify: () => {},
        pause: () => {},
        sessionIdle: () => over.busy !== true,
        now: () => NOW,
      }),
    )
    return { sent, counted }
  }

  it('waits for the supervisor to be between turns', () => {
    const { sent, counted } = run({ busy: true })

    // Nothing sent, and — just as important — nothing counted: a busy supervisor must not burn the
    // one budget it needs to finish saying what it is already saying.
    expect(sent).toEqual([])
    expect(counted).toEqual([])
  })

  it('asks once the supervisor is idle', () => {
    const { sent, counted } = run({ attempts: 1 })

    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('问题还没写出来')
    expect(counted).toEqual([2])
  })

  it('stops for good once the limit is reached', () => {
    const { sent, counted } = run({ attempts: MAX_UNWORDED_QUESTION_NUDGES })

    expect(sent).toEqual([])
    expect(counted).toEqual([])
  })

  it('says it is the last time on the final attempt', () => {
    const { sent } = run({ attempts: MAX_UNWORDED_QUESTION_NUDGES - 1 })

    expect(sent[0]).toContain('最后一次提醒')
  })
})
