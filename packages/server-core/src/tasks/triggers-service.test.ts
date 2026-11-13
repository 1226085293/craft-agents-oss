import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskService } from './task-service.ts'
import { loadTask, readJournal } from '@craft-agent/shared/tasks'

/**
 * Changing a trigger after the task exists.
 *
 * A task registered from 「每分钟发一次」 kept firing after the person said 「停了」: the only
 * writer was the board's own editor, so the lane that heard the words had no way to act on them.
 */
describe('a task can be re-scheduled and un-scheduled', () => {
  let root = ''
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = ''
  })

  const make = () => {
    root = mkdtempSync(join(tmpdir(), 'triggers-'))
    const service = new TaskService({
      workspaceRoot: root,
      sessionExists: () => true,
      wakeSupervisor: () => undefined,
    } as never)
    const task = service.create({
      name: 'T-1',
      instruction: '每分钟发一次你好',
      supervisorSessionId: 'sup',
      toolCallId: 'call-1',
      triggers: [{ kind: 'cron', expr: '* * * * *', enabled: true } as never],
    } as never)
    return { service, task }
  }

  it('creates with the list as it was given, and mirrors the first rule', () => {
    const { service, task } = make()
    const read = service.get(task.id)
    expect(read?.triggers).toHaveLength(1)
    expect(read?.trigger?.kind).toBe('cron')
  })

  it('replaces the whole list in one write', () => {
    const { service, task } = make()
    service.updateTriggers(task.id, [
      { kind: 'cron', expr: '0 9 * * *', enabled: true } as never,
      { kind: 'event', source: 'github', enabled: true } as never,
    ])
    const read = service.get(task.id)
    expect(read?.triggers).toHaveLength(2)
    expect(read?.triggers?.map((t) => t.kind)).toEqual(['cron', 'event'])
  })

  it('turns them all off with an empty list — 「停了」 is a real instruction', () => {
    const { service, task } = make()
    service.updateTriggers(task.id, [])
    const read = service.get(task.id)
    expect(read?.triggers).toEqual([])
    expect(read?.trigger).toEqual({ kind: 'manual' })
    // And it survives the round trip through the file, not just the in-memory copy.
    expect(loadTask(root, task.id)?.triggers).toEqual([])
  })

  it('records the change, so the board can explain why it stopped firing', () => {
    const { service, task } = make()
    service.updateTriggers(task.id, [])
    const entry = readJournal(root, task.id).find((e) => e.type === 'trigger_updated')
    expect(entry).toBeDefined()
  })
})
