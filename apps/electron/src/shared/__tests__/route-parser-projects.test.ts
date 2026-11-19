/**
 * Projects route round-trips: route string ⇄ NavigationState ⇄ panel key.
 * Guards the six touchpoints a navigator must thread through
 * (prefix list, parse, build, convert, key serialization, type guard).
 *
 * History: the parse branch for 'projects' was missing entirely — every
 * projects route parsed to null, handleNavigation dropped it silently, and
 * project detail views were unreachable (11-19 活体: 建了项目但点击「没用」).
 */

import { describe, test, expect } from 'bun:test'
import {
  isCompoundRoute,
  parseCompoundRoute,
  parseRouteToNavigationState,
  buildRouteFromNavigationState,
} from '../route-parser'
import {
  getNavigationStateKey,
  parseNavigationStateKey,
  isProjectsNavigation,
  type NavigationState,
} from '../types'
import { routes } from '../routes'

describe('projects routes', () => {
  test('route builders emit the projects prefix', () => {
    expect(routes.view.projects()).toBe('projects')
    expect(routes.view.projects('my-proj')).toBe('projects/project/my-proj')
  })

  test('projects is a compound route prefix', () => {
    expect(isCompoundRoute('projects')).toBe(true)
    expect(isCompoundRoute('projects/project/my-proj')).toBe(true)
  })

  test('parses bare projects route (list, no auto-selected detail)', () => {
    expect(parseCompoundRoute('projects')).toEqual({ navigator: 'projects', details: null })
    const state = parseRouteToNavigationState('projects')
    expect(state).toEqual({ navigator: 'projects', details: null })
    expect(state && isProjectsNavigation(state)).toBe(true)
  })

  test('parses project detail route', () => {
    expect(parseCompoundRoute('projects/project/my-proj')).toEqual({
      navigator: 'projects',
      details: { type: 'project', id: 'my-proj' },
    })
    const state = parseRouteToNavigationState('projects/project/my-proj')
    expect(state).toEqual({
      navigator: 'projects',
      details: { type: 'project', projectSlug: 'my-proj' },
    })
    expect(state && isProjectsNavigation(state)).toBe(true)
  })

  test('rejects malformed projects routes', () => {
    expect(parseCompoundRoute('projects/unknown')).toBeNull()
    expect(parseCompoundRoute('projects/project')).toBeNull()
  })

  test('round-trips route ⇄ navigation state', () => {
    for (const route of ['projects', 'projects/project/my-proj'] as const) {
      const state = parseRouteToNavigationState(route)
      expect(state).not.toBeNull()
      expect(buildRouteFromNavigationState(state!)).toBe(route)
    }
  })

  test('state key serialization', () => {
    const state: NavigationState = parseRouteToNavigationState('projects/project/my-proj')!
    const key = getNavigationStateKey(state)
    const restored = parseNavigationStateKey(key)!
    expect(restored).toEqual(state)
  })
})
