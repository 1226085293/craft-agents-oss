/**
 * Events route round-trips: events/list, events/inbox, events/outbox and
 * their detail levels. Regression guards: outbox records gained a compact
 * 3-segment detail form (events/outbox/<id>), and inbox event details stay
 * under the inbox section (events/inbox/event/<id>) instead of jumping back
 * to the log section.
 */

import { describe, test, expect } from 'bun:test'
import {
  parseRouteToNavigationState,
  buildRouteFromNavigationState,
} from '../route-parser'
import { routes } from '../routes'
import type { EventsNavigationState } from '../types'

function eventsState(route: string): EventsNavigationState {
  const state = parseRouteToNavigationState(route)
  if (!state || state.navigator !== 'events') {
    throw new Error(`expected an events navigation state for ${route}`)
  }
  return state
}

describe('events routes', () => {
  test('route builders emit the queue prefixes', () => {
    expect(routes.view.inbox()).toBe('events/inbox')
    expect(routes.view.inbox('e1')).toBe('events/inbox/event/e1')
    expect(routes.view.outbox()).toBe('events/outbox')
    expect(routes.view.outbox('ob1')).toBe('events/outbox/ob1')
  })

  test('an outbox detail round-trips through the navigation state', () => {
    const state = eventsState('events/outbox/ob1')
    expect(state.section).toBe('outbox')
    expect(state.details).toEqual({ type: 'outbox', outboxId: 'ob1' })
    expect(buildRouteFromNavigationState(state)).toBe('events/outbox/ob1')
  })

  test('the outbox list route carries no detail', () => {
    const state = eventsState('events/outbox')
    expect(state.section).toBe('outbox')
    expect(state.details).toBeNull()
    expect(buildRouteFromNavigationState(state)).toBe('events/outbox')
  })

  test('an inbox event detail stays under the inbox section', () => {
    const state = eventsState('events/inbox/event/e1')
    expect(state.section).toBe('inbox')
    expect(state.details).toEqual({ type: 'event', eventId: 'e1' })
    expect(buildRouteFromNavigationState(state)).toBe('events/inbox/event/e1')
  })

  test('an outbox detail is dropped when the section is re-entered', () => {
    const state = eventsState('events/outbox')
    expect(state.details).toBeNull()
    const withDetail = eventsState('events/outbox/ob7')
    expect(withDetail.details).toEqual({ type: 'outbox', outboxId: 'ob7' })
  })

  test('event log details keep the 4-segment form', () => {
    const state = eventsState('events/list/event/e9')
    expect(state.section).toBe('list')
    expect(state.details).toEqual({ type: 'event', eventId: 'e9' })
    expect(buildRouteFromNavigationState(state)).toBe('events/list/event/e9')
  })
})
