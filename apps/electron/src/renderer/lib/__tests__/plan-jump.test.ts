import { describe, expect, it } from 'bun:test'

import { resolvePlanJumps, type JournalLine } from '../plan-jump'

const journal: JournalLine[] = [
  { at: 1000, type: 'run_started', data: { sessionId: 'sess-A' } },
  { at: 1100, type: 'plan_updated', data: { step: '1', status: 'doing' } },
  { at: 1200, type: 'plan_updated', data: { step: '1.1', status: 'doing' } },
  { at: 1300, type: 'plan_updated', data: { step: '1.1', status: 'done', note: 'bun test' } },
  { at: 1400, type: 'plan_updated', data: { step: '1', status: 'done' } },
  { at: 2000, type: 'run_started', data: { sessionId: 'sess-B' } },
  { at: 2100, type: 'plan_updated', data: { step: '2', status: 'doing' } },
  { at: 2200, type: 'plan_updated', data: { step: '2.1', status: 'doing' } },
]

/**
 * An outline and a sub-step answer different questions: where did this section
 * begin, versus where was this unit of work finished. Landing on the wrong one
 * puts the user in front of a process block that does not contain what they
 * clicked.
 */
describe('plan jumps', () => {
  it('sends an outline to where the section started', () => {
    const jumps = resolvePlanJumps(
      [{ id: '1', status: 'done' }, { id: '1.1', status: 'done' }],
      journal,
    )
    expect(jumps.get('1')).toMatchObject({ at: 1100, sessionId: 'sess-A' })
  })

  it('sends a sub-step to where it finished', () => {
    const jumps = resolvePlanJumps(
      [{ id: '1', status: 'done' }, { id: '1.1', status: 'done' }],
      journal,
    )
    expect(jumps.get('1.1')).toMatchObject({ at: 1300, sessionId: 'sess-A' })
  })

  it('picks the session that was running at that moment, not the latest one', () => {
    const jumps = resolvePlanJumps(
      [{ id: '1', status: 'done' }, { id: '2', status: 'doing' }],
      journal,
    )
    expect(jumps.get('1')?.sessionId).toBe('sess-A')
    expect(jumps.get('2')?.sessionId).toBe('sess-B')
  })

  it('leaves a step with no recorded moment inert', () => {
    const jumps = resolvePlanJumps([{ id: '9', status: 'todo' }], journal)
    expect(jumps.has('9')).toBe(false)
  })

  it('falls back to the task session when the journal names none', () => {
    const jumps = resolvePlanJumps([{ id: '1', status: 'done' }], [
      { at: 1100, type: 'plan_updated', data: { step: '1', status: 'doing' } },
    ], 'sess-fallback')
    expect(jumps.get('1')?.sessionId).toBe('sess-fallback')
  })

  it('uses the most recent entry into the wanted state after a resume', () => {
    const reentered: JournalLine[] = [
      { at: 1000, type: 'plan_updated', data: { step: '1', status: 'doing' } },
      { at: 1500, type: 'plan_updated', data: { step: '1', status: 'doing' } },
    ]
    const jumps = resolvePlanJumps([{ id: '1', status: 'doing' }], reentered)
    // Resuming should land on the latest attempt, not the first one.
    expect(jumps.get('1')?.at).toBe(1500)
  })
})
