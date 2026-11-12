/**
 * The one-creator guard, and the deterministic half of 「用户督导建记录，任务督导走流程」.
 *
 * A registration relay wakes the working lane with 「新任务 T-x 已登记」 — and the record
 * already exists. Yet a lane that misread the message as 「建一个任务」 called `task_create`
 * and produced a second record for the same request (the T-1/T-2 live incident): the scope,
 * plan and dispatch written on the duplicate were invisible to the original, and the person
 * was left with two tasks for one request.
 *
 * The user lane therefore marks the registered task as *unclaimed* on the working lane when
 * it relays the words; `task_create` is refused while the mark stands, and the refusal names
 * the registered id, so the only way forward is to claim it via `task_update` / `dispatch` /
 * `task_plan` — which clears the mark. This holds even if the model skips reading the relay
 * message entirely.
 *
 * Stale after `RELAY_CLAIM_TTL_MS`: a lane that never claimed the task must not be locked out
 * of `task_create` forever (child tasks, decomposition) by a relay it ignored.
 */

export const RELAY_CLAIM_TTL_MS = 60 * 60 * 1000

export interface RelayClaimMark {
  unclaimedRelayedTaskId?: string
  unclaimedRelayedTaskAt?: number
}

/**
 * The refusal to give the model when it calls `task_create` while a registered task is
 * unclaimed — or `null` when creating is allowed. The message names the registered id and
 * the exact claim path, so the error itself is the correction.
 */
export function unclaimedRelayedTaskRefusal(
  lane: RelayClaimMark,
  now: number,
): string | null {
  const id = lane.unclaimedRelayedTaskId
  if (!id) return null
  if ((lane.unclaimedRelayedTaskAt ?? 0) <= now - RELAY_CLAIM_TTL_MS) return null
  return (
    `任务 ${id} 已登记、正在等你认领：不要 task_create 新建任务（那会产生第二条重复任务）。` +
    `先用 task_update 把 scope/directive 写到 ${id} 上，再 task_plan 写计划，然后 dispatch 派活。`
  )
}
