import { describe, expect, it } from 'bun:test'
import { inspectTasks, MAX_PROCESS_LOST_RETRIES, processLostGraceMs } from './task-watchdog.ts'
import type { WatchdogDeps } from './task-watchdog.ts'
import type { Task } from '@craft-agent/shared/tasks'

/**
 * A task paused because its executor died was never looked at again.
 *
 * `inspectTasks` starts every rule with `if (task.status !== 'running') continue`, so `paused`
 * meant invisible — including the one pause with an obvious recovery. Observed: a task left
 * `running` by a killed process was recovered to `paused / process_lost` (that part worked) and
 * then sat there with nothing watching it, while the design says retry once and then ask a human.
 */
function deps(tasks: Task[], now: number): WatchdogDeps {
  return {
    listTasks: () => tasks,
    sessionExists: () => false,
    pause: () => {},
    notify: () => {},
    now: () => now,
  }
}

function lostTask(over: Partial<Task> = {}): Task {
  const now = 1_000_000
  return {
    id: 'T-1',
    name: '孤儿任务',
    instruction: 'x',
    status: 'paused',
    pauseReason: 'process_lost',
    supervisorSessionId: 's1',
    sessionIds: ['ghost'],
    handoffs: [],
    lifecycle: { errorCount: 0, consecutiveFailures: 0 },
    createdAt: now - 100_000,
    updatedAt: now - 100_000,
    lastHeartbeatAt: now - 100_000,
    version: 1,
    currentSessionId: 'ghost',
    stats: { runs: 1, activeMs: 0, lastHeartbeatAt: now - 100_000 },
    ...over,
  } as Task
}

describe('a task whose executor was lost', () => {
  it('is retried once', () => {
    const now = 1_000_000
    const findings = inspectTasks(deps([lostTask()], now))
    expect(findings.map((f) => f.kind)).toContain('resume_lost')
  })

  it('is not retried a second time', () => {
    const now = 1_000_000
    const task = lostTask({ stats: { runs: 1, activeMs: 0, lostRetries: MAX_PROCESS_LOST_RETRIES } as never })
    expect(inspectTasks(deps([task], now)).map((f) => f.kind)).not.toContain('resume_lost')
  })

  it('waits out the grace period first', () => {
    const now = 1_000_000
    const task = lostTask({ updatedAt: now, lastHeartbeatAt: now, stats: { runs: 1, activeMs: 0, lastHeartbeatAt: now } as never })
    expect(inspectTasks(deps([task], now)).map((f) => f.kind)).not.toContain('resume_lost')
    expect(processLostGraceMs()).toBeGreaterThan(0)
  })

  it('leaves other pause reasons alone', () => {
    const now = 1_000_000
    const task = lostTask({ pauseReason: 'budget' } as never)
    expect(inspectTasks(deps([task], now)).map((f) => f.kind)).not.toContain('resume_lost')
  })

  it('still ignores completed tasks', () => {
    const now = 1_000_000
    const task = lostTask({ status: 'completed' } as never)
    expect(inspectTasks(deps([task], now))).toHaveLength(0)
  })
})
