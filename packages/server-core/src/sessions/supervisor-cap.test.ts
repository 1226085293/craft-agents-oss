import { describe, it, expect } from 'bun:test'

/**
 * The cap used to close the turn and immediately re-drain the backlog, so work
 * that genuinely needed longer than the cap produced:
 *
 *     start → killed at 300s → re-queue → start the same reasoning → killed …
 *
 * with the reasoning thrown away each round. Two behaviours replace it:
 * convert the turn into a task, and back off before re-waking.
 *
 * The conversion itself needs a live SessionManager, so what is pinned here is
 * the decision logic that decides whether to bother — the part that can silently
 * regress into "no task, no message, no clue".
 */

/** Mirrors `convertTimedOutTurnToTask`'s guards. */
function canConvert(turn: {
  lastUserText?: string
  taskService: boolean
}): boolean {
  if (!turn.taskService) return false
  if (!turn.lastUserText?.trim()) return false
  return true
}

/** Mirrors the backoff ladder in the stop handler. */
function backoffMs(hits: number): number {
  return hits >= 2 ? Math.min(5 * 60_000, 15_000 * (hits - 1)) : 0
}

describe('cap hit conversion', () => {
  it('converts when there is an instruction to hand over', () => {
    expect(canConvert({ lastUserText: '把这批文档整理进 wiki', taskService: true })).toBe(true)
  })

  it('does not invent a task from nothing', () => {
    // A supervisor woken by an event nudge may have no user message at all. A
    // task named after an empty brief would be noise, and worse, it would look
    // like work is being tracked when nothing is.
    expect(canConvert({ lastUserText: '', taskService: true })).toBe(false)
    expect(canConvert({ lastUserText: '   ', taskService: true })).toBe(false)
    expect(canConvert({ taskService: true })).toBe(false)
  })

  it('does not convert when the workspace has no task service', () => {
    expect(canConvert({ lastUserText: 'do it', taskService: false })).toBe(false)
  })
})

describe('cap backoff', () => {
  it('re-wakes immediately on the first hit', () => {
    // One slow turn is bad luck with a slow channel, not a structural problem.
    // Delaying here would make a single slow response look like a hang.
    expect(backoffMs(0)).toBe(0)
    expect(backoffMs(1)).toBe(0)
  })

  it('starts backing off on the second consecutive hit', () => {
    expect(backoffMs(2)).toBe(15_000)
    expect(backoffMs(3)).toBe(30_000)
    expect(backoffMs(4)).toBe(45_000)
  })

  it('is capped so a long streak does not park the supervisor for hours', () => {
    expect(backoffMs(50)).toBe(5 * 60_000)
  })

  it('never goes backwards', () => {
    let previous = -1
    for (let hits = 0; hits <= 30; hits += 1) {
      const value = backoffMs(hits)
      expect(value).toBeGreaterThanOrEqual(previous)
      previous = value
    }
  })
})
