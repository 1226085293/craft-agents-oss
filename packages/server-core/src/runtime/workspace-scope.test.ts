import { describe, it, expect } from 'bun:test'
import { WorkspaceScope, WorkspaceScopes } from './workspace-scope.ts'

/**
 * The point of this class is narrow: anything started must be stoppable, and
 * stopping must be one call. These cases pin the properties the host relies on.
 */

describe('WorkspaceScope', () => {
  it('disposes everything it started', () => {
    const stopped: string[] = []
    const scope = new WorkspaceScope('ws')
    scope.effect(() => () => stopped.push('watchdog'))
    scope.effect(() => () => stopped.push('scheduler'))

    scope.dispose()
    expect(stopped.sort()).toEqual(['scheduler', 'watchdog'])
    expect(scope.disposed).toBe(true)
  })

  it('disposes in reverse order of registration', () => {
    const order: string[] = []
    const scope = new WorkspaceScope('ws')
    // A scheduler started after its service must stop before it, otherwise it
    // ticks against something already gone.
    scope.effect(() => () => order.push('service'))
    scope.effect(() => () => order.push('scheduler'))

    scope.dispose()
    expect(order).toEqual(['scheduler', 'service'])
  })

  it('keeps going when one disposer throws', () => {
    const stopped: string[] = []
    const errors: unknown[] = []
    const scope = new WorkspaceScope('ws')
    scope.effect(() => () => stopped.push('first'))
    scope.effect(() => () => {
      throw new Error('boom')
    })
    scope.effect(() => () => stopped.push('third'))

    scope.dispose((error) => errors.push(error))
    // Reverse order: `third` runs first, the throwing one is skipped past.
    expect(stopped).toEqual(['third', 'first'])
    expect(errors).toHaveLength(1)
  })

  it('is idempotent', () => {
    let count = 0
    const scope = new WorkspaceScope('ws')
    scope.effect(() => () => {
      count += 1
    })
    scope.dispose()
    scope.dispose()
    expect(count).toBe(1)
  })

  it('refuses to start work after disposal', () => {
    const scope = new WorkspaceScope('ws')
    scope.dispose()
    // A timer created here would run for a workspace nobody is watching.
    expect(() => scope.effect(() => () => {})).toThrow(/already disposed/)
  })

  it('accepts a start that returns nothing', () => {
    const scope = new WorkspaceScope('ws')
    scope.effect(() => {})
    expect(() => scope.dispose()).not.toThrow()
  })
})

describe('WorkspaceScopes', () => {
  it('reuses a live scope and replaces a disposed one', () => {
    const scopes = new WorkspaceScopes()
    const first = scopes.open('ws')
    expect(scopes.open('ws')).toBe(first)

    scopes.dispose('ws')
    const second = scopes.open('ws')
    expect(second).not.toBe(first)
    expect(second.disposed).toBe(false)
  })

  it('disposes every workspace at once', () => {
    const stopped: string[] = []
    const scopes = new WorkspaceScopes()
    scopes.open('a').effect(() => () => stopped.push('a'))
    scopes.open('b').effect(() => () => stopped.push('b'))

    scopes.disposeAll()
    expect(stopped.sort()).toEqual(['a', 'b'])
    expect(scopes.activeIds()).toEqual([])
  })
})
