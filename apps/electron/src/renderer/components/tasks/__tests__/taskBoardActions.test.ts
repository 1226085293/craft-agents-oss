import { describe, expect, it } from 'bun:test'

import { actionsFor, sharedActionsFor } from '../TaskBoardPanel'

/**
 * What a right-click offers is decided by status alone, so it can be checked
 * without rendering. These are the rules the menu depends on.
 */
describe('task board context actions', () => {
  it('offers pause and cancel to work that is still live', () => {
    expect(actionsFor('running')).toEqual(['pause', 'cancel'])
    expect(actionsFor('backlog')).toEqual(['pause', 'cancel'])
  })

  it('offers resume rather than pause once a task is already stopped', () => {
    expect(actionsFor('paused')).toEqual(['resume', 'cancel'])
  })

  it('offers only delete to a finished task', () => {
    for (const status of ['completed', 'failed', 'canceled'] as const) {
      expect(actionsFor(status)).toEqual(['delete'])
    }
  })

  it('shows only what every selected task can do', () => {
    // Two running tasks share pause/cancel.
    expect(sharedActionsFor(['running', 'backlog'])).toEqual(['pause', 'cancel'])
    // A running task and a finished one share nothing.
    expect(sharedActionsFor(['running', 'completed'])).toEqual([])
    // Same status still intersects.
    expect(sharedActionsFor(['completed', 'canceled'])).toEqual(['delete'])
  })

  it('opens no menu when nothing is selected', () => {
    // An empty list is the signal the caller uses to suppress the menu
    // entirely; a menu with no items would be worse than no menu.
    expect(sharedActionsFor([])).toEqual([])
  })
})
