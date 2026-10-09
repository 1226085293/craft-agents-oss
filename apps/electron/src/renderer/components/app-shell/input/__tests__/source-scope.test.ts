/**
 * Truth table for source-scope selection helpers. These helpers encode the
 * picker semantics behind the source dropdown's Auto / Only these / Exclude
 * these modes and the @mention <-> picker sync in FreeFormInput. Each row of
 * the matrix is pinned here because the behavior has user-visible traps:
 * stale checkmarks surviving an auto switch, and a stale selection leaking
 * into an only-mode narrowing.
 */

import { describe, test, expect } from 'bun:test'
import {
  resolveSlugsOnScopeChange,
  resolveSlugsOnSourceMention,
  resolveSlugsOnMentionRemoved,
  type SourceScope,
} from '../source-scope'

// ---------------------------------------------------------------------------
// resolveSlugsOnScopeChange
// ---------------------------------------------------------------------------

describe('resolveSlugsOnScopeChange', () => {
  const AUTH = ['a', 'b', 'c', 'd', 'e']

  test('only→exclude inverts the selection (user case: 1-5 源勾选 1-3 → 反向后勾选 4-5)', () => {
    expect(resolveSlugsOnScopeChange('only', 'exclude', ['a', 'b', 'c'], AUTH)).toEqual(['d', 'e'])
  })

  test('exclude→only inverts the exclusion list back to the allow list', () => {
    expect(resolveSlugsOnScopeChange('exclude', 'only', ['d', 'e'], AUTH)).toEqual(['a', 'b', 'c'])
  })

  test('reverse rule does NOT fire on an empty selection (没选任何源 → 不反向)', () => {
    const empty: string[] = []
    expect(resolveSlugsOnScopeChange('only', 'exclude', empty, AUTH)).toBe(empty)
    expect(resolveSlugsOnScopeChange('exclude', 'only', empty, AUTH)).toBe(empty)
  })

  test('inversion drops stale slugs not in the authorized set', () => {
    expect(resolveSlugsOnScopeChange('only', 'exclude', ['a', 'gone'], AUTH)).toEqual(['b', 'c', 'd', 'e'])
  })

  test('switching to auto clears the selection (no stale checkmarks)', () => {
    expect(resolveSlugsOnScopeChange('only', 'auto', ['a', 'b'], AUTH)).toEqual([])
    expect(resolveSlugsOnScopeChange('exclude', 'auto', ['a'], AUTH)).toEqual([])
  })

  test('auto→only: @-mentioned authorized sources become checked by default', () => {
    expect(resolveSlugsOnScopeChange('auto', 'only', [], AUTH, ['a', 'c'])).toEqual(['a', 'c'])
    // 未授权（不在 authorized）的提及不勾选
    expect(resolveSlugsOnScopeChange('auto', 'only', [], AUTH, ['a', 'gone'])).toEqual(['a'])
  })

  test('auto→only with no mentions stays empty', () => {
    expect(resolveSlugsOnScopeChange('auto', 'only', [], AUTH)).toEqual([])
  })

  test('auto→exclude: @-mentioned sources become checked by default (同 only 模式，用户指定“同理”)', () => {
    expect(resolveSlugsOnScopeChange('auto', 'exclude', [], AUTH, ['c'])).toEqual(['c'])
  })

  test('same-mode “switch” is a no-op (same reference)', () => {
    const current = ['a']
    expect(resolveSlugsOnScopeChange('only', 'only', current, AUTH)).toBe(current)
    expect(resolveSlugsOnScopeChange('exclude', 'exclude', current, AUTH)).toBe(current)
  })
})

// ---------------------------------------------------------------------------
// resolveSlugsOnSourceMention
// ---------------------------------------------------------------------------

describe('resolveSlugsOnSourceMention', () => {
  test('auto: @mention does not change the selection at all', () => {
    const current = ['alpha']
    expect(resolveSlugsOnSourceMention('auto', current, 'beta')).toBe(current)
    expect(resolveSlugsOnSourceMention('auto', current, 'alpha')).toBe(current)
    expect(resolveSlugsOnSourceMention('auto', [], 'beta')).toEqual([])
  })

  test('only: @mention of an unselected source selects it', () => {
    expect(resolveSlugsOnSourceMention('only', ['alpha'], 'beta')).toEqual(['alpha', 'beta'])
    expect(resolveSlugsOnSourceMention('only', [], 'alpha')).toEqual(['alpha'])
  })

  test('only: @mention of an already-selected source is a no-op (same reference)', () => {
    const current = ['alpha', 'beta']
    expect(resolveSlugsOnSourceMention('only', current, 'alpha')).toBe(current)
  })

  test('exclude: @mention of an excluded (checked) source un-excludes it', () => {
    expect(resolveSlugsOnSourceMention('exclude', ['alpha', 'beta'], 'alpha')).toEqual(['beta'])
    expect(resolveSlugsOnSourceMention('exclude', ['alpha'], 'alpha')).toEqual([])
  })

  test('exclude: @mention of a non-excluded source is a no-op (same reference)', () => {
    const current = ['alpha']
    expect(resolveSlugsOnSourceMention('exclude', current, 'beta')).toBe(current)
  })

  test('exclude: @mention on an empty exclusion list is a no-op', () => {
    const current: string[] = []
    expect(resolveSlugsOnSourceMention('exclude', current, 'alpha')).toBe(current)
  })
})

// ---------------------------------------------------------------------------
// resolveSlugsOnMentionRemoved
// ---------------------------------------------------------------------------

describe('resolveSlugsOnMentionRemoved', () => {
  test('only: removing a mention text un-checks that source', () => {
    expect(resolveSlugsOnMentionRemoved('only', ['alpha', 'beta'], ['alpha'])).toEqual(['beta'])
    expect(resolveSlugsOnMentionRemoved('only', ['alpha'], ['alpha'])).toEqual([])
  })

  test('only: removal of a source that is not selected is a no-op (same reference)', () => {
    const current = ['beta']
    expect(resolveSlugsOnMentionRemoved('only', current, ['alpha'])).toBe(current)
  })

  test('auto: removing a mention text never mutates the selection', () => {
    const current = ['alpha']
    expect(resolveSlugsOnMentionRemoved('auto', current, ['alpha'])).toBe(current)
    expect(resolveSlugsOnMentionRemoved('auto', [], ['alpha'])).toEqual([])
  })

  test('exclude: removing a mention text never mutates the exclusion list', () => {
    const current = ['alpha']
    expect(resolveSlugsOnMentionRemoved('exclude', current, ['alpha'])).toBe(current)
  })

  test('empty removed list is a no-op in every mode', () => {
    for (const scope of ['auto', 'only', 'exclude'] as SourceScope[]) {
      const current = ['alpha']
      expect(resolveSlugsOnMentionRemoved(scope, current, [])).toBe(current)
    }
  })
})