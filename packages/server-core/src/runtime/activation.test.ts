import { describe, it, expect } from 'bun:test'
import { activateInOrder } from './activation.ts'

/**
 * The invariant this replaces was a comment ("register before the loops start").
 * These cases make it a property: a subsystem never runs before what it depends
 * on, and never runs at all if that dependency is missing.
 */

describe('activateInOrder', () => {
  it('activates a dependency before its dependent, regardless of list order', () => {
    const order: string[] = []
    const result = activateInOrder([
      { id: 'watchdog', requires: ['task-service'], activate: () => order.push('watchdog') },
      { id: 'task-service', activate: () => order.push('task-service') },
    ])
    expect(order).toEqual(['task-service', 'watchdog'])
    expect(result.failed).toEqual([])
  })

  it('handles a chain', () => {
    const order: string[] = []
    activateInOrder([
      { id: 'c', requires: ['b'], activate: () => order.push('c') },
      { id: 'b', requires: ['a'], activate: () => order.push('b') },
      { id: 'a', activate: () => order.push('a') },
    ])
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('does not start a subsystem whose dependency is absent', () => {
    const order: string[] = []
    const result = activateInOrder([
      {
        id: 'watchdog',
        requires: ['task-service'],
        consequence: '任务不会被巡检',
        activate: () => order.push('watchdog'),
      },
    ])
    expect(order).toEqual([])
    // Both are reported: the missing dependency, and the subsystem that cannot
    // run because of it.
    expect(result.failed.map((f) => f.id).sort()).toEqual(['task-service', 'watchdog'])
    const missing = result.failed.find((f) => f.id === 'task-service')
    expect(missing?.reason).toBe('unknown-dependency')
    expect(result.failed.find((f) => f.id === 'watchdog')?.reason).toBe('dependency-failed')
  })

  it('names the consequence when a dependency failed', () => {
    const result = activateInOrder([
      { id: 'a', activate: () => { throw new Error('boom') } },
      {
        id: 'b',
        requires: ['a'],
        consequence: '巡检不会运行',
        activate: () => { throw new Error('should not run') },
      },
    ])
    const b = result.failed.find((f) => f.id === 'b')
    expect(b?.reason).toBe('dependency-failed')
    expect(b?.detail).toContain('巡检不会运行')
  })

  it('reports a cycle instead of picking an order', () => {
    const result = activateInOrder([
      { id: 'a', requires: ['b'], activate: () => {} },
      { id: 'b', requires: ['a'], activate: () => {} },
    ])
    expect(result.failed.some((f) => f.reason === 'cycle')).toBe(true)
  })

  it('keeps activating independent subsystems when one fails', () => {
    const order: string[] = []
    const result = activateInOrder([
      { id: 'bad', activate: () => { throw new Error('x') } },
      { id: 'good', activate: () => order.push('good') },
    ])
    expect(order).toEqual(['good'])
    expect(result.failed.map((f) => f.id)).toEqual(['bad'])
  })
})

describe('transactional activation', () => {
  /**
   * The shape the host uses: activate a group, and if anything throws, whatever
   * already started is undone. A workspace with a task service but no watchdog
   * is worse than one that reports it cannot start.
   */
  function activateTransactionally(
    subsystems: Parameters<typeof activateInOrder>[0],
    onRollback: (started: string[]) => void,
  ) {
    try {
      const result = activateInOrder(subsystems)
      const fatal = result.failed.find((f) => f.detail.startsWith('启动失败'))
      if (fatal) {
        onRollback(result.activated)
        throw new Error(fatal.detail)
      }
      return result
    } catch (error) {
      throw error
    }
  }

  it('rolls back what was already started when a later step throws', () => {
    const started: string[] = []
    const rolledBack: string[] = []
    expect(() =>
      activateTransactionally(
        [
          { id: 'a', activate: () => started.push('a') },
          { id: 'b', requires: ['a'], activate: () => { throw new Error('boom') } },
        ],
        (done) => rolledBack.push(...done),
      ),
    ).toThrow()
    expect(started).toEqual(['a'])
    expect(rolledBack).toEqual(['a'])
  })

  it('does not roll back when everything activates', () => {
    const started: string[] = []
    const rolledBack: string[] = []
    activateTransactionally(
      [{ id: 'a', activate: () => started.push('a') }],
      (done) => rolledBack.push(...done),
    )
    expect(started).toEqual(['a'])
    expect(rolledBack).toEqual([])
  })
})
