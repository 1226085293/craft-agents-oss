/**
 * `mergeSessionOptions` contract.
 *
 * The renderer no longer holds a default strategy group preference: the
 * resolved group is written on the session record by `createSession`
 * (agent → first enabled). What remains here is the plain merge semantics, plus
 * the guarantee that an explicit `strategy` on the session always wins.
 */

import { describe, expect, test } from 'bun:test'

import { defaultSessionOptions, mergeSessionOptions } from '../useSessionOptions'

describe('mergeSessionOptions', () => {
  test('fills in the defaults for an untouched session', () => {
    const merged = mergeSessionOptions(undefined, {})
    expect(merged.permissionMode).toBe(defaultSessionOptions.permissionMode)
    expect(merged.thinkingLevel).toBe(defaultSessionOptions.thinkingLevel)
  })

  test('keeps a strategy already resolved for the session', () => {
    expect(mergeSessionOptions({ ...defaultSessionOptions, strategy: 'auto' }, {}).strategy).toBe('auto')
  })

  test('lets an explicit update win over the session value', () => {
    expect(mergeSessionOptions({ ...defaultSessionOptions, strategy: 'auto' }, { strategy: 'manual' }).strategy).toBe('manual')
  })

  test('does not invent a strategy when the session has none', () => {
    // The server is the only place that resolves this; the renderer must not
    // resurrect the deleted localStorage default.
    expect(mergeSessionOptions(undefined, {}).strategy).toBeUndefined()
  })
})
