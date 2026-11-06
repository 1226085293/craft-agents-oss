import { describe, it, expect } from 'bun:test'
import { auditHooks, checkSessionHooks, DESKTOP_SESSION_HOOKS } from './hook-audit.ts'

/**
 * The value of this check is that a missing hook is *named*. A silent no-op is
 * the failure mode it exists to end, so every case here asserts on the message.
 */

describe('auditHooks', () => {
  it('says nothing when every hook is present', () => {
    const result = auditHooks([{ name: 'a', consequence: 'x', present: true }])
    expect(result.ok).toBe(true)
    expect(result.summary).toBe('')
  })

  it('names each missing hook with its consequence', () => {
    const result = auditHooks([
      { name: 'createEventDispatchTarget', consequence: '事件无法投递', present: false },
      { name: 'ok', consequence: '', present: true },
      { name: 'routeUnclaimedEvent', consequence: '督导收不到事件', present: false },
    ])
    expect(result.ok).toBe(false)
    expect(result.missing.map((m) => m.name)).toEqual([
      'createEventDispatchTarget',
      'routeUnclaimedEvent',
    ])
    expect(result.summary).toContain('2 个必需钩子')
    expect(result.summary).toContain('事件无法投递')
    expect(result.summary).toContain('督导收不到事件')
  })

  it('reports all missing hooks in one line instead of only the first', () => {
    // One line per boot, not one per defect: a fix should not need N restarts to
    // discover N problems.
    const result = auditHooks([
      { name: 'a', consequence: 'A', present: false },
      { name: 'b', consequence: 'B', present: false },
      { name: 'c', consequence: 'C', present: false },
    ])
    expect(result.summary.split('；')).toHaveLength(3)
  })
})

describe('checkSessionHooks', () => {
  it('treats a missing session manager as everything missing', () => {
    const result = checkSessionHooks(null)
    expect(result.ok).toBe(false)
    expect(result.missing).toHaveLength(DESKTOP_SESSION_HOOKS.length)
  })

  it('accepts a manager that provides them all', () => {
    const complete = Object.fromEntries(DESKTOP_SESSION_HOOKS.map((hook) => [hook.key, () => {}]))
    expect(checkSessionHooks(complete).ok).toBe(true)
  })

  it('rejects a manager that provides only some of them', () => {
    const partial = { createEventDispatchTarget: () => {}, routeUnclaimedEvent: () => {} }
    const result = checkSessionHooks(partial)
    expect(result.ok).toBe(false)
    expect(result.missing.map((m) => m.name)).toEqual(['createHostActions', 'disposeWorkspace'])
  })

  it('does not mistake a non-function property for a hook', () => {
    // `routeUnclaimedEvent: true` would pass a naive truthiness check and blow up
    // at call time, which is the same silent failure in a different disguise.
    const wrongType = Object.fromEntries(
      DESKTOP_SESSION_HOOKS.map((hook) => [hook.key, hook.key === 'createHostActions' ? true : () => {}]),
    )
    expect(checkSessionHooks(wrongType).missing.map((m) => m.name)).toEqual(['createHostActions'])
  })
})
