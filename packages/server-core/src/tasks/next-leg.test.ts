import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TaskService } from './task-service.ts'
import { createTask, saveTask } from '@craft-agent/shared/tasks'
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

function seed(h: Harness, plan: Array<{ id: string; title: string; status: string; agent?: string }>, assignee?: string): Task {
  const task = createTask({
    id: 'T-1',
    name: '接口改造',
    instruction: '把接口改完',
    supervisorSessionId: 'sup',
    toolCallId: 'tc-1',
    now: 1,
    ...(assignee ? { assigneeAgentId: assignee } : {}),
    spec: { plan: plan as Task['spec'] extends undefined ? never : NonNullable<Task['spec']>['plan'] },
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
    // The supervisor is not woken when the next leg already started.
    expect(h.woken).toHaveLength(0)
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
