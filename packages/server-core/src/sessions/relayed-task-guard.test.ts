import { describe, expect, it } from 'bun:test'

import { SessionManager } from './SessionManager.ts'
import {
  RELAY_CLAIM_TTL_MS,
  unclaimedRelayedTaskRefusal,
  type RelayClaimMark,
} from './relayed-task-guard.ts'

/**
 * One request, one record — enforced, not prompted.
 *
 * The live incident: the user lane registered T-1 and woke the working lane, which misread the
 * relay as 「建一个任务」 and called `task_create` for the same words — T-2. The person then had
 * two tasks for one request, and the scope/plan/dispatch written on T-2 never reached T-1.
 *
 * The guard is deterministic: while a registered task is unclaimed on the lane, `task_create`
 * must refuse, and the refusal must name the id and the claim path, so the error is itself the
 * correction. The mark is set when the relay is sent and cleared the moment the lane touches
 * the task — then `task_create` is the lane's own call again.
 */
describe('the one-creator guard for registration relays', () => {
  const now = Date.now()
  const mark = (taskId?: string, at?: number): RelayClaimMark => ({
    unclaimedRelayedTaskId: taskId,
    unclaimedRelayedTaskAt: at,
  })

  it('refuses task_create while a registered task is unclaimed', () => {
    const refusal = unclaimedRelayedTaskRefusal(mark('T-1', now), now)
    expect(refusal).toBeTruthy()
    expect(refusal).toContain('T-1')
    expect(refusal).toContain('task_create')
    expect(refusal).toContain('task_update')
  })

  it('allows task_create once the task is claimed (mark cleared)', () => {
    expect(unclaimedRelayedTaskRefusal(mark(undefined, now), now)).toBeNull()
  })

  it('allows task_create when the relay has gone stale', () => {
    const stale = now - RELAY_CLAIM_TTL_MS - 1
    expect(unclaimedRelayedTaskRefusal(mark('T-1', stale), now)).toBeNull()
  })

  it('at exactly the TTL boundary the mark is stale; one millisecond fresher it still refuses', () => {
    expect(unclaimedRelayedTaskRefusal(mark('T-1', now - RELAY_CLAIM_TTL_MS), now)).toBeNull()
    expect(
      unclaimedRelayedTaskRefusal(mark('T-1', now - RELAY_CLAIM_TTL_MS + 1), now),
    ).toBeTruthy()
  })

  it('allows task_create when the mark has no timestamp (defensive)', () => {
    expect(unclaimedRelayedTaskRefusal(mark('T-1', undefined), now)).toBeNull()
  })

  it('allows task_create when nothing was ever relayed', () => {
    expect(unclaimedRelayedTaskRefusal({}, now)).toBeNull()
  })

  it('sets the mark on the working lane when the relay goes out, and clears it when claimed', () => {
    const sm = new SessionManager()
    const sessions = new Map()
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions = sessions
    sessions.set('lane_task', {})
    const lane = () => sessions.get('lane_task') as RelayClaimMark

    // TS `private` is compile-time only; the wiring test reaches around it.
    ;(sm as unknown as { markRelayedTaskUnclaimed: (a: string, b: string) => void }).markRelayedTaskUnclaimed(
      'lane_task',
      'T-1',
    )
    expect(lane().unclaimedRelayedTaskId).toBe('T-1')
    expect(typeof lane().unclaimedRelayedTaskAt).toBe('number')

    // Touching a different task does not clear the mark; claiming does.
    ;(sm as unknown as { clearRelayedTaskClaim: (a: string, b: string) => void }).clearRelayedTaskClaim(
      'lane_task',
      'T-9',
    )
    expect(lane().unclaimedRelayedTaskId).toBe('T-1')
    ;(sm as unknown as { clearRelayedTaskClaim: (a: string, b: string) => void }).clearRelayedTaskClaim(
      'lane_task',
      'T-1',
    )
    expect(lane().unclaimedRelayedTaskId).toBeUndefined()
    expect(lane().unclaimedRelayedTaskAt).toBeUndefined()
  })

  it('a newer relay replaces the older mark (the newest registration is the one that blocks)', () => {
    const sm = new SessionManager()
    const sessions = new Map()
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions = sessions
    sessions.set('lane_task', {})
    const setMark = (
      sm as unknown as { markRelayedTaskUnclaimed: (a: string, b: string) => void }
    ).markRelayedTaskUnclaimed.bind(sm)
    setMark('lane_task', 'T-1')
    setMark('lane_task', 'T-2')
    expect((sessions.get('lane_task') as RelayClaimMark).unclaimedRelayedTaskId).toBe('T-2')
  })
})
