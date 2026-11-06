/**
 * Tasks route round-trips: route string ⇄ NavigationState ⇄ panel key.
 * Regression: `buildCompoundRoute` had no tasks branch, so a navigation to the
 * task board was re-serialized as `allSessions` (the sessions fallback) — the
 * sidebar entry appeared dead. Also guards the `tasks/<id>` detail form.
 */

import { describe, test, expect } from 'bun:test'
import {
  isCompoundRoute,
  parseCompoundRoute,
  buildCompoundRoute,
  parseRouteToNavigationState,
  buildRouteFromNavigationState,
} from '../route-parser'
import {
  getNavigationStateKey,
  parseNavigationStateKey,
  isTasksNavigation,
  type NavigationState,
} from '../types'
import { routes } from '../routes'

describe('tasks routes', () => {
  test('route builders emit the tasks prefix', () => {
    expect(routes.view.tasks()).toBe('tasks')
    expect(routes.view.tasks('t-123')).toBe('tasks/t-123')
  })

  test('tasks is a compound route prefix', () => {
    expect(isCompoundRoute('tasks')).toBe(true)
    expect(isCompoundRoute('tasks/t-123')).toBe(true)
  })

  test('parses bare tasks route (board, no selected task)', () => {
    expect(parseCompoundRoute('tasks')).toEqual({ navigator: 'tasks', selectedTaskId: null, details: null })
    const state = parseRouteToNavigationState('tasks')
    expect(state).toEqual({ navigator: 'tasks', selectedTaskId: null })
    expect(state && isTasksNavigation(state)).toBe(true)
  })

  test('parses task detail route', () => {
    expect(parseCompoundRoute('tasks/t-123')).toEqual({
      navigator: 'tasks',
      selectedTaskId: 't-123',
      details: { type: 'task', id: 't-123' },
    })
    expect(parseRouteToNavigationState('tasks/t-123')).toEqual({
      navigator: 'tasks',
      selectedTaskId: 't-123',
    })
  })

  test('rejects malformed tasks routes', () => {
    expect(parseCompoundRoute('tasks/a/b')).toBeNull()
  })

  test('round-trips route ⇄ navigation state', () => {
    for (const route of ['tasks', 'tasks/t-123'] as const) {
      const state = parseRouteToNavigationState(route)
      expect(state).not.toBeNull()
      expect(buildRouteFromNavigationState(state!)).toBe(route)
    }
  })

  test('buildCompoundRoute emits tasks routes (regression: no sessions fallback)', () => {
    expect(buildCompoundRoute({ navigator: 'tasks', selectedTaskId: null, details: null })).toBe('tasks')
    expect(buildCompoundRoute({ navigator: 'tasks', selectedTaskId: 't-123', details: null })).toBe('tasks/t-123')
  })

  test('round-trips navigation state ⇄ panel key', () => {
    const board: NavigationState = { navigator: 'tasks', selectedTaskId: null }
    const detail: NavigationState = { navigator: 'tasks', selectedTaskId: 't-123' }
    expect(getNavigationStateKey(board)).toBe('tasks')
    expect(getNavigationStateKey(detail)).toBe('tasks/t-123')
    expect(parseNavigationStateKey('tasks')).toEqual(board)
    expect(parseNavigationStateKey('tasks/t-123')).toEqual(detail)
  })

})
