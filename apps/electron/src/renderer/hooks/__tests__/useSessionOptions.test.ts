/**
 * The default strategy group is a localStorage preference, not a field on the
 * session record. It used to be frozen into `defaultSessionOptions` at module
 * load, so setting a default in Settings did nothing for sessions created in
 * the same window — the composer kept saying 未选择策略组.
 *
 * These tests pin the "resolve at call time" contract, including the escape
 * hatch (an explicit empty string means "no default").
 */

import { afterEach, describe, expect, test } from 'bun:test'

import {
  DEFAULT_STRATEGY_STORAGE_KEY,
  defaultSessionOptions,
  mergeSessionOptions,
  readDefaultStrategy,
} from '../useSessionOptions'

/** Minimal localStorage stand-in; Bun's test runtime has none. */
function stubStorage(initial: Record<string, string> = {}): void {
  const store = new Map(Object.entries(initial))
  ;(globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size
    },
  } as Storage
}

afterEach(() => {
  delete (globalThis as unknown as { localStorage?: Storage }).localStorage
})

describe('readDefaultStrategy', () => {
  test('returns the stored default', () => {
    stubStorage({ [DEFAULT_STRATEGY_STORAGE_KEY]: 'auto' })
    expect(readDefaultStrategy()).toBe('auto')
  })

  test('is empty when nothing is stored or localStorage is unavailable', () => {
    expect(readDefaultStrategy()).toBe('')
    stubStorage()
    expect(readDefaultStrategy()).toBe('')
  })
})

describe('mergeSessionOptions — strategy default', () => {
  test('a brand-new session picks up the default at call time', () => {
    stubStorage({ [DEFAULT_STRATEGY_STORAGE_KEY]: 'auto' })
    expect(mergeSessionOptions(undefined, {}).strategy).toBe('auto')
  })

  test('picks up a default set after the module was loaded', () => {
    // The constant is created at import time; the merge must not reuse a value
    // captured then.
    expect(defaultSessionOptions.strategy).toBeUndefined()
    stubStorage({ [DEFAULT_STRATEGY_STORAGE_KEY]: 'group-2' })
    expect(mergeSessionOptions({ ...defaultSessionOptions }, {}).strategy).toBe('group-2')
  })

  test('an explicit empty string means "no default" and is preserved', () => {
    stubStorage({ [DEFAULT_STRATEGY_STORAGE_KEY]: 'auto' })
    expect(mergeSessionOptions({ ...defaultSessionOptions, strategy: '' }, {}).strategy).toBe('')
  })

  test('an update wins over the default', () => {
    stubStorage({ [DEFAULT_STRATEGY_STORAGE_KEY]: 'auto' })
    expect(mergeSessionOptions(undefined, { strategy: 'manual' }).strategy).toBe('manual')
  })

  test('a session with its own strategy keeps it', () => {
    stubStorage({ [DEFAULT_STRATEGY_STORAGE_KEY]: 'auto' })
    expect(mergeSessionOptions({ ...defaultSessionOptions, strategy: 'pinned' }, {}).strategy).toBe('pinned')
  })
})
