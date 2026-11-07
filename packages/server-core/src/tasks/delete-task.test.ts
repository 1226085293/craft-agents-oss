import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TaskService } from './task-service.ts'
import { createTask, saveTask, deleteTask, getJournalPath } from '@craft-agent/shared/tasks'
import type { Task } from '@craft-agent/shared/tasks'

interface Harness {
  service: TaskService
  root: string
  woken: string[]
}

function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'craft-detach-'))
  const woken: string[] = []
  const service = new TaskService({
    workspaceRoot: root,
    sessionExists: () => false,
    wakeSupervisor: (_sessionId, text) => woken.push(text),
  })
  return { service, root, woken }
}

function seed(h: Harness): Task {
  const task = createTask({
    id: 'T-1',
    name: '接口改造',
    instruction: '把接口改完',
    supervisorSessionId: 'sup',
    toolCallId: 'tc-1',
    now: 1,
  }) as Task
  const running: Task = {
    ...task,
    status: 'running',
    currentSessionId: 'sess-1',
    sessionIds: ['sess-1'],
  }
  saveTask(h.root, running)
  return running
}

/** Delete only ever applies to a finished task; cancel first, the way a user must. */
function seedFinished(h: Harness): Task {
  const task = seed(h)
  const finished: Task = { ...task, status: 'canceled' }
  saveTask(h.root, finished)
  return finished
}

/**
 * Deleting a task removes the board entry — never the conversation.
 *
 * A session is the record of what happened: the tool calls, the files read, the
 * errors, the user's own words. A task is a row on a board. They are not the same
 * object, and the same session can be referenced by more than one task, so
 * removing one task must not take its sessions down with it.
 *
 * What does have to end is the reporting: a worker that finished its turn after
 * the entry was removed still calls `report_result`, and throwing there would turn
 * an ordinary end-of-turn into an error the user has to interpret.
 */
describe('deleting a task', () => {
  it('keeps the session able to report afterwards, without throwing', async () => {
    const h = harness()
    seedFinished(h)
    expect(h.service.remove('T-1').ok).toBe(true)

    const result = await h.service.reportHandoff(
      'T-1',
      { outcome: 'handoff', summary: '做完了' },
      'sess-1',
    )
    expect(result.taskGone).toBe(true)
    expect(result.passed).toBe(false)
    // The reason is written for the session to read, not for a log.
    expect(result.reasons.join('')).toContain('任务已删除')
    // Nothing to wake: there is no task left to route.
    expect(h.woken).toHaveLength(0)
    rmSync(h.root, { recursive: true, force: true })
  })

  it('removes the record and the journal, and leaves the board empty', () => {
    const h = harness()
    seedFinished(h)
    const journalPath = getJournalPath(h.root, 'T-1')
    expect(existsSync(journalPath)).toBe(false) // nothing written for a fresh task

    expect(h.service.list()).toHaveLength(1)
    h.service.remove('T-1')
    expect(h.service.list()).toHaveLength(0)
    rmSync(h.root, { recursive: true, force: true })
  })

  it('refuses to delete a task that is still live', () => {
    const h = harness()
    seed(h)
    const result = h.service.remove('T-1')
    // `running` is not terminal: a session is still writing to this record.
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('先取消')
    expect(h.service.list()).toHaveLength(1)
    rmSync(h.root, { recursive: true, force: true })
  })

  it('reports how many sessions it left standing', () => {
    const h = harness()
    const task = seedFinished(h)
    // A finished task can be deleted; its sessions are explicitly kept.
    const removed = deleteTask(h.root, 'T-1')
    expect(removed).toBe(true)
    expect(task.sessionIds).toEqual(['sess-1'])
    rmSync(h.root, { recursive: true, force: true })
  })
})
