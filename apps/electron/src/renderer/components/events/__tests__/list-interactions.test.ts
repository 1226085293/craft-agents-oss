/**
 * Explorer-selection math for the 收件箱 / 发件箱 lists. The hook is the
 * thin React wrapper; the grammar itself lives in `nextSelection`, which is
 * tested here without rendering anything (same approach as the session
 * list's selection tests).
 */

import { describe, test, expect } from 'bun:test'
import { nextSelection } from '../list-interactions'

const ROWS = ['a', 'b', 'c', 'd', 'e']

describe('nextSelection', () => {
  test('a plain click selects the single row and anchors it', () => {
    const next = nextSelection(ROWS, { selected: new Set(['c']), anchor: 'c' }, 'd', 'click')
    expect(next.selected).toEqual(new Set(['d']))
    expect(next.anchor).toBe('d')
  })

  test('ctrl toggles membership and moves the anchor', () => {
    let state = { selected: new Set(['a']), anchor: 'a' as string | null }
    state = nextSelection(ROWS, state, 'c', 'ctrl')
    expect(state.selected).toEqual(new Set(['a', 'c']))
    expect(state.anchor).toBe('c')
    state = nextSelection(ROWS, state, 'a', 'ctrl')
    expect(state.selected).toEqual(new Set(['c']))
    expect(state.anchor).toBe('a')
  })

  test('shift ranges from the anchor, in either direction', () => {
    const state = { selected: new Set(['b']), anchor: 'b' as string | null }
    const forward = nextSelection(ROWS, state, 'e', 'shift')
    expect(forward.selected).toEqual(new Set(['b', 'c', 'd', 'e']))
    // The anchor stays at the range start, so a further shift extends from b.
    expect(forward.anchor).toBe('b')
    const back = nextSelection(ROWS, forward, 'a', 'shift')
    expect(back.selected).toEqual(new Set(['a', 'b']))
  })

  test('shift without an anchor just activates the row', () => {
    const state = { selected: new Set<string>(), anchor: null as string | null }
    const next = nextSelection(ROWS, state, 'c', 'shift')
    expect(next.selected).toEqual(new Set(['c']))
    expect(next.anchor).toBe('c')
  })

  test('an anchor that scrolled out of view falls back to single selection', () => {
    const state = { selected: new Set(['x']), anchor: 'x' as string | null }
    const next = nextSelection(ROWS, state, 'd', 'shift')
    expect(next.selected).toEqual(new Set(['d']))
    expect(next.anchor).toBe('d')
  })
})
