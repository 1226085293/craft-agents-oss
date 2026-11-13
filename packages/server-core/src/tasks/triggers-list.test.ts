import { describe, expect, it } from 'bun:test'
import { normalizeTriggers, primaryTrigger } from '@craft-agent/shared/tasks'

/**
 * A task can be due for more than one reason.
 *
 * The single `trigger` slot made 「every morning at nine」 and 「when a github issue arrives」
 * mutually exclusive, which the domain never said. The list replaces it; `trigger` stays as the
 * derived mirror every existing reader uses, so the change is invisible downstream.
 */
describe('triggers as a list', () => {
  const cron = { kind: 'cron' as const, expr: '0 9 * * *', enabled: true }
  const event = { kind: 'event' as const, source: 'github', enabled: true }

  it('keeps both a schedule and an event rule on one task', () => {
    expect(normalizeTriggers([cron, event])).toHaveLength(2)
  })

  it('reads the old single-slot shape', () => {
    expect(normalizeTriggers({ kind: 'cron', expr: '0 9 * * *', enabled: true })).toHaveLength(1)
  })

  it('drops manual entries, because "no rule" is the absence of a trigger', () => {
    // Otherwise an idle task carries one trigger forever and the board renders it as scheduled.
    expect(normalizeTriggers([{ kind: 'manual' }, cron])).toEqual([cron])
    expect(normalizeTriggers([{ kind: 'manual' }])).toEqual([])
  })

  it('drops an exact duplicate, which would fire the task twice in one pass', () => {
    expect(normalizeTriggers([cron, cron])).toHaveLength(1)
  })

  it('mirrors the first real rule into `trigger`, or manual when there is none', () => {
    expect(primaryTrigger([event, cron]).kind).toBe('event')
    expect(primaryTrigger([])).toEqual({ kind: 'manual' })
  })

  it('refuses a rule it cannot run, rather than pretending it is scheduled', () => {
    // A cron without an expression, and an event without a source, are both unusable.
    expect(normalizeTriggers([{ kind: 'cron' } as never])).toEqual([])
    expect(normalizeTriggers([{ kind: 'event' } as never])).toEqual([])
  })
})
