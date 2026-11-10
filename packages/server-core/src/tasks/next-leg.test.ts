import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TaskService } from './task-service.ts'
import { applyPlanPatch, createTask, saveTask } from '@craft-agent/shared/tasks'
import type { Task } from '@craft-agent/shared/tasks'

interface Harness {
  service: TaskService
  root: string
  woken: string[]
  started: Array<{ taskId: string; agent?: string }>
  startResult: boolean
}

function harness(overrides: { startResult?: boolean; startNextLeg?: boolean } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'craft-nextleg-'))
  const woken: string[] = []
  const started: Array<{ taskId: string; agent?: string }> = []
  const h: Harness = {
    service: undefined as unknown as TaskService,
    root,
    woken,
    started,
    startResult: overrides.startResult ?? true,
  }
  h.service = new TaskService({
    workspaceRoot: root,
    sessionExists: () => false,
    wakeSupervisor: (_sessionId, text) => woken.push(text),
    ...(overrides.startNextLeg === false
      ? {}
      : {
          startNextLeg: async (task: Task, agent?: string) => {
            started.push({ taskId: task.id, ...(agent ? { agent } : {}) })
            return h.startResult
          },
        }),
  })
  return h
}

function seed(
  h: Harness,
  plan: Array<{ id: string; title: string; status: string; agent?: string }>,
  assignee?: string,
  directive?: string,
): Task {
  const task = createTask({
    id: 'T-1',
    name: '接口改造',
    instruction: '把接口改完',
    supervisorSessionId: 'sup',
    toolCallId: 'tc-1',
    now: 1,
    ...(assignee ? { assigneeAgentId: assignee } : {}),
    spec: {
      plan: plan as Task['spec'] extends undefined ? never : NonNullable<Task['spec']>['plan'],
      ...(directive ? { directive: { text: directive, at: 1 } } : {}),
    } as Task['spec'],
  }) as Task
  // A run has to be under way for a hand-off to be a legal transition.
  const running = { ...task, status: 'running' as const, currentSessionId: 'sess-1', sessionIds: ['sess-1'] }
  saveTask(h.root, running)
  return running
}

const handoff = {
  // `handoff` means "someone still has to continue", which is the only outcome
  // that can start a next section. `delivered` completes the task.
  outcome: 'handoff' as const,
  summary: '这一节做完了',
  artifacts: [{ path: '.' }],
  verify: { ran: ['true'], passed: true },
}

/**
 * A section that belongs to another agent starts that agent — and does not queue a
 * message in front of the user.
 *
 * The supervisor's conversation is the user's own. Waking it for every hand-off
 * would make the human wait behind bookkeeping, and the wait would grow with the
 * number of running tasks.
 */
describe('starting the next section', () => {
  it('starts the agent that owns the next step', async () => {
    const h = harness()
    seed(
      h,
      [
        { id: '1', title: '接口', status: 'doing' },
        { id: '1.1', title: '改 handler', status: 'done', agent: 'agent-api' },
        { id: '2', title: '测试', status: 'todo' },
        { id: '2.1', title: '写用例', status: 'todo', agent: 'agent-qa' },
      ],
      'agent-api',
    )
    await h.service.reportHandoff('T-1', handoff, 'sess-1')
    expect(h.started).toEqual([{ taskId: 'T-1', agent: 'agent-qa' }])
    /**
     * The supervisor is told even though it has nothing to route.
     *
     * Skipping the notice was justified as 「nothing to route」, and it left the person who
     * had asked to be told at this boundary hearing nothing at all. Observed live: 1.1
     * passed, 1.2 opened automatically against the user's instruction, and the supervisor
     * only found out when it happened to look at the task.
     */
    expect(h.woken.length).toBeGreaterThan(0)
    expect(h.woken.join(String.fromCharCode(10))).toContain('已自动开始下一节')
    rmSync(h.root, { recursive: true, force: true })
  })

  it('leaves the task with the same agent alone', async () => {
    const h = harness()
    seed(
      h,
      [
        { id: '1', title: '接口', status: 'doing' },
        { id: '1.1', title: '改 handler', status: 'done', agent: 'agent-api' },
        { id: '1.2', title: '补类型', status: 'todo', agent: 'agent-api' },
      ],
      'agent-api',
    )
    await h.service.reportHandoff('T-1', handoff, 'sess-1')
    // Same owner: continuing is the same session's business, so nothing is started
    // and the supervisor is told.
    expect(h.started).toHaveLength(0)
    expect(h.woken.length).toBeGreaterThan(0)
    rmSync(h.root, { recursive: true, force: true })
  })

  it('falls back to the supervisor when the run gate refuses', async () => {
    const h = harness({ startResult: false })
    seed(
      h,
      [
        { id: '1', title: '接口', status: 'doing' },
        { id: '1.1', title: '改 handler', status: 'done', agent: 'agent-api' },
        { id: '2', title: '测试', status: 'todo' },
        { id: '2.1', title: '写用例', status: 'todo', agent: 'agent-qa' },
      ],
      'agent-api',
    )
    await h.service.reportHandoff('T-1', handoff, 'sess-1')
    expect(h.started).toHaveLength(1)
    // Refused by the gate — this is exactly when a human should hear about it.
    expect(h.woken.length).toBeGreaterThan(0)
    rmSync(h.root, { recursive: true, force: true })
  })
})

describe('two rules answered "may work continue"', () => {
  it('does not start the next leg when the directive says the slice was the whole job', async () => {
    /**
     * Observed live twice, at 10:21:18 and 10:32:24. The same hand-off paused the task as
     * 「已按指示停止」 and opened 1.2 in a fresh session in the same instant: `sliceDeliveredButPlanOpen`
     * paused, the ownership rule started, and neither knew about the other. The second time the
     * person found a session working on 1.2 while the board said the task had stopped.
     */
    const h = harness()
    seed(
      h,
      [
        { id: '1', title: '写文件', status: 'doing' },
        { id: '1.1', title: '创建', status: 'done', agent: 'agent-a' },
        { id: '2', title: '收尾', status: 'todo' },
        { id: '2.1', title: '核对', status: 'todo', agent: 'agent-b' },
      ],
      'agent-a',
      // The authorisation boundary: this slice is all the person allowed.
      '只做 1.1，做完就停',
    )
    await h.service.reportHandoff('T-1', handoff, 'sess-1')
    // A different owner IS a boundary — but the directive says stop, and it wins.
    expect(h.started).toHaveLength(0)
    expect(h.service.get('T-1')?.pauseReason).toBe('awaiting_release')
    rmSync(h.root, { recursive: true, force: true })
  })

  it('stores an agent id the same way the roster spells it', async () => {
    /**
     * A worker wrote `@builtin-default` where the roster said `builtin-default` — a mention habit,
     * not a different agent — and the identity comparison read the mismatch as 「someone else owns
     * the next step」, which is what started 1.2 on its own at 10:32:24.
     *
     * The id is normalized where it is stored, so no reader has to know about the decoration.
     */
    const h = harness()
    const task = seed(
      h,
      [
        { id: '1', title: '写文件', status: 'doing' },
        { id: '1.1', title: '创建', status: 'doing', agent: 'builtin-default' },
        { id: '1.2', title: '读回', status: 'todo', agent: 'builtin-default' },
      ],
      undefined,
    )
    /**
     * Asked of the writer directly, not of the record it wrote: `loadTask` normalizes on read as
     * well, so a check through `get()` would pass even with the writer reverted — it would be
     * testing the loader twice.
     */
    const patched = applyPlanPatch(
      task.spec?.plan,
      { id: '1.1', status: 'done', agent: '@builtin-default' },
      10,
    )
    expect(patched.plan?.find((step) => step.id === '1.1')?.agent).toBe('builtin-default')
    rmSync(h.root, { recursive: true, force: true })
  })
})

describe('a refusal is feedback, not news', () => {
  it('does not wake the supervisor when the gate refuses and the task keeps running', async () => {
    /**
     * Observed live: 1.2 refused at 11:10:38 for a missing `artifacts` list, retried and
     * accepted at 11:10:44. The supervisor was woken twice for one step — the first time to
     * be told about a problem that the worker fixed six seconds later without help.
     *
     * The refusal already reaches the worker, in the same turn, with the reason. Waking the
     * supervisor for it makes a self-correction look like an incident.
     */
    const h = harness()
    seed(
      h,
      [
        { id: '1', title: '写文件', status: 'doing' },
        { id: '1.1', title: '创建', status: 'doing', agent: 'builtin-default' },
      ],
      undefined,
    )
    // No artifacts, no verify: the rules refuse it, and nothing about the task changes.
    const result = await h.service.reportHandoff('T-1', { outcome: 'handoff', summary: '做完了' } as never, 'sess-1')
    expect(result.passed).toBe(false)
    expect(result.reasons.length).toBeGreaterThan(0)
    expect(h.woken).toHaveLength(0)
    expect(h.service.get('T-1')?.status).toBe('running')
    rmSync(h.root, { recursive: true, force: true })
  })

  it('still wakes the supervisor when the refusal changes the task', async () => {
    /**
     * A refusal that pauses the task (fuse, spinning in place) is a milestone: the task has
     * stopped and a person or the supervisor has to act. Silence there would strand it.
     */
    const h = harness()
    seed(
      h,
      [
        { id: '1', title: '写文件', status: 'doing' },
        { id: '1.1', title: '创建', status: 'doing', agent: 'builtin-default' },
      ],
      undefined,
    )
    for (let i = 0; i < 3; i += 1) {
      await h.service.reportHandoff('T-1', { outcome: 'handoff', summary: '做完了' } as never, 'sess-1')
    }
    // The failure fuse pauses it, which is a fact the supervisor has to hear.
    expect(h.service.get('T-1')?.status).toBe('paused')
    expect(h.woken.length).toBeGreaterThan(0)
    rmSync(h.root, { recursive: true, force: true })
  })
})

describe('a finished task stays finished', () => {
  it('refuses to start a run once it is completed', async () => {
    /**
     * Live: the supervisor set T-1 to `completed` at 11:52:21 and to `running` at 11:52:29.
     * `applyTransition` refuses `completed → running`, but `startRun` builds its record
     * directly and `updateTask({status:'running'})` goes straight to `runTask` — so the task
     * came back to life after the person had been told it was done, the worker filed three
     * `delivered` hand-offs, and the user lane read 「任务已全部完成」 three times.
     */
    const h = harness()
    seed(
      h,
      [
        { id: '1', title: '写文件', status: 'doing' },
        { id: '1.1', title: '创建', status: 'done', agent: 'builtin-default' },
      ],
      undefined,
    )
    h.service.setStatus('T-1', 'completed')
    const result = h.service.startRun('T-1', 'sess-1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('已经完成')
    expect(h.service.get('T-1')?.status).toBe('completed')
    rmSync(h.root, { recursive: true, force: true })
  })

  it('ignores a hand-off filed after completion', async () => {
    // The report is answered — a worker mid-turn must not get an exception — but it changes
    // nothing and wakes nobody: the task ended when it ended.
    const h = harness()
    seed(
      h,
      [
        { id: '1', title: '写文件', status: 'doing' },
        { id: '1.1', title: '创建', status: 'done', agent: 'builtin-default' },
      ],
      undefined,
    )
    h.service.setStatus('T-1', 'completed')
    const before = h.service.get('T-1')!.handoffs.length
    const result = await h.service.reportHandoff('T-1', handoff, 'sess-1')
    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toContain('已经完成')
    expect(h.service.get('T-1')!.handoffs.length).toBe(before)
    expect(h.woken).toHaveLength(0)
    rmSync(h.root, { recursive: true, force: true })
  })
})
