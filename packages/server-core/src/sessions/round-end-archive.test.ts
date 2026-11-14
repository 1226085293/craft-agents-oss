import { describe, expect, it } from 'bun:test'
import { canSpendParkedArchive, decideRoundEndArchive } from './round-end-archive.ts'

describe('round-end archive', () => {
  it('defers the usual case instead of dropping it', () => {
    // Every round ends mid-turn: `report_result` is a tool call, so the worker cannot be idle when the
    // round closes. Dropping the request here is what left one session per round on disk forever —
    // live, T-1 ran three rounds and kept broad-swan and lucid-beach alive.
    expect(decideRoundEndArchive({ isArchived: false, isProcessing: true })).toBe('defer')
  })

  it('archives straight away when the worker is already idle', () => {
    expect(decideRoundEndArchive({ isArchived: false, isProcessing: false })).toBe('archive')
  })

  it('does nothing for a session that is already archived or gone', () => {
    expect(decideRoundEndArchive({ isArchived: true, isProcessing: false })).toBe('skip')
    expect(decideRoundEndArchive({ isArchived: true, isProcessing: true })).toBe('skip')
    expect(decideRoundEndArchive(undefined)).toBe('skip')
    // Unset is the normal state: the field is only ever assigned `true`.
    expect(decideRoundEndArchive({ isProcessing: false })).toBe('archive')
  })

  it('spends a parked request only once the turn is over', () => {
    const busy = { isArchived: false, isProcessing: true }
    const idle = { isArchived: false, isProcessing: false }
    expect(canSpendParkedArchive(busy, true)).toBe(false)
    expect(canSpendParkedArchive(idle, true)).toBe(true)
  })

  it('never spends a request that was not parked', () => {
    // The set is spent by id; a lookup that misses must not archive an unrelated idle session.
    expect(canSpendParkedArchive({ isArchived: false, isProcessing: false }, false)).toBe(false)
  })

  it('does not archive a session that became archived in the meantime', () => {
    expect(canSpendParkedArchive({ isArchived: true, isProcessing: false }, true)).toBe(false)
    expect(canSpendParkedArchive(undefined, true)).toBe(false)
  })
})
