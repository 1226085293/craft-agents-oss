import { describe, expect, it } from 'bun:test'
import { buildRouteFromNavigationState, parseRouteToNavigationState } from '../route-parser'
import { getNavigationStateKey, parseNavigationStateKey } from '../types'
import { routes } from '../routes'

describe('memory manager route', () => {
  it('round-trips under the sources navigator without becoming a source slug', () => {
    expect(routes.view.memories()).toBe('sources/memories')
    const state = parseRouteToNavigationState('sources/memories')
    expect(state).toEqual({ navigator: 'sources', details: { type: 'memory', id: 'global' } })
    expect(buildRouteFromNavigationState(state!)).toBe('sources/memories')
    expect(getNavigationStateKey(state!)).toBe('sources/memories')
    expect(parseNavigationStateKey('sources/memories')).toEqual(state)
  })
})
