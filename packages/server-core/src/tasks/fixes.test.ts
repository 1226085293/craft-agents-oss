import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TaskService, SPIN_LIMIT, isSpinningInPlace } from './task-service.ts'
import { createTask, saveTask } from '@craft-agent/shared/tasks'
import type { Task } from '@craft-agent/shared/tasks'

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'craft-fixes-'))
  const woken: string[] = []
  const service = new TaskService({
    workspaceRoot: root,
    sessionExists: () => true,
    wakeSupervisor: (_sessionId, text) => woken.push(text),
  })
  return { service, root, woken }
}

function seed(h: { root: string }, overrides: Partial<Task> = {}): Task {
  const base = createTask({
    id: 'T-1',
    name: '接口改造',
    instruction: '把接口改完',
    supervisorSessionId: 'sup',
    toolCallId: 'tc-1',
    now: 1,
  }) as Task
  const task = { ...base, status: 'running' as const, ...overrides }
  saveTask(h.root, task)
  return task
}

/**
 * The board reported "2 / 8" for a task that had started one worker.
 *
 * `startRun` is called twice per run: once with a `pending:<reason>` placeholder to
 * hold the lock before the session exists, then again with the real id. Only the
 * real id is a session.
 */
describe('run placeholders', () => {
  it('does not count the pending placeholder as a session', () => {
    const h = harness()
    seed(h)
    const claimed = h.service.startRun('T-1', 'pending:manual')
    expect(claimed.ok).toBe(true)
    const task = claimed.ok ? claimed.task : null
    expect(task?.sessionIds).toEqual([])
    expect(task?.currentWorkerSessionId).toBeUndefined()
    rmSync(h.root, { recursive: true, force: true })
  })

  it('records the real session when it arrives', () => {
    const h = harness()
    seed(h)
    h.service.startRun('T-1', 'pending:manual')
    const real = h.service.startRun('T-1', 'sess-1')
    const task = real.ok ? real.task : null
    expect(task?.sessionIds).toEqual(['sess-1'])
    expect(task?.currentWorkerSessionId).toBe('sess-1')
    rmSync(h.root, { recursive: true, force: true })
  })
})

/**
 * A worker that hits a wall reports a hand-off at every step, and each one lands in
 * the timeline looking like progress. Observed in a real run: ten shell calls,
 * repeated "cannot write here" hand-offs, plan never moved, task still `running`.
 */
describe('spinning in place', () => {
  const plan = [
    { id: '1', title: '一节', status: 'doing' as const, updatedAt: 1 },
    { id: '1.1', title: '一步', status: 'doing' as const, updatedAt: 1 },
  ]

  it('detects repeated hand-offs with no step finished', () => {
    const task = {
      handoffs: Array.from({ length: SPIN_LIMIT }, (_, i) => ({
        at: 100 + i,
        fromSessionId: 'sess-1',
        outcome: 'handoff' as const,
        summary: '还是不行',
      })),
      spec: { plan },
    } as unknown as Task
    expect(isSpinningInPlace(task)).toBe(true)
  })

  it('does not fire when a step finished in that stretch', () => {
    const advanced = [
      { id: '1', title: '一节', status: 'doing' as const, updatedAt: 1 },
      { id: '1.1', title: '一步', status: 'done' as const, updatedAt: 150 },
    ]
    const task = {
      handoffs: Array.from({ length: SPIN_LIMIT }, (_, i) => ({
        at: 100 + i,
        fromSessionId: 'sess-1',
        outcome: 'handoff' as const,
        summary: '做完一步',
      })),
      spec: { plan: advanced },
    } as unknown as Task
    expect(isSpinningInPlace(task)).toBe(false)
  })

  it('does not fire on a task with no plan to measure against', () => {
    const task = {
      handoffs: Array.from({ length: SPIN_LIMIT }, (_, i) => ({
        at: 100 + i,
        fromSessionId: 'sess-1',
        outcome: 'handoff' as const,
        summary: 'x',
      })),
      spec: {},
    } as unknown as Task
    expect(isSpinningInPlace(task)).toBe(false)
  })
})
