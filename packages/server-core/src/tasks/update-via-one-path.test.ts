import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The task board's update and the `task_update` tool must be one implementation.
 *
 * They were two. The tool learned `scope`, then `authorizedUpTo` / `authorizedSteps`; the RPC
 * handler kept calling `service.setStatus` and dropped those options. Verified in a running
 * instance: `tasksUpdate(..., { authorizedUpTo: '2' })` returned a task whose `authorizedUpTo`
 * was still `1.1` — the button reported success and the record did not move.
 *
 * This is a source-level assertion on purpose. The bug is the existence of a second code path,
 * and no behavioural test of either path alone can see it: both behave correctly in isolation,
 * and only their divergence is wrong.
 */
const root = join(import.meta.dir, '..', '..', '..', '..')

describe('the task board update', () => {
  const source = readFileSync(
    join(root, 'packages/server-core/src/handlers/rpc/tasks.ts'),
    'utf8',
  )

  it('delegates to the shared updater instead of calling setStatus itself', () => {
    const at = source.indexOf('RPC_CHANNELS.taskboard.UPDATE,', source.indexOf('registerTasksHandlers'))
    const body = source.slice(at, source.indexOf('RPC_CHANNELS.taskboard.UPDATE_TRIGGER,', at))
    expect(body).toContain('manager.updateTask')
    expect(body).not.toContain('service.setStatus')
  })

  it('forwards every field the tool accepts', () => {
    // The failure this guards: the tool learned `scope` and then `authorizedUpTo` /
    // `authorizedSteps`, the RPC kept calling `setStatus`, and a button that widened the
    // boundary answered success while the record never changed. Whatever the tool can write,
    // the board must be able to write; the boundary is now a single `directive` sentence,
    // because ids the worker invents cannot bound its own work.
    const at = source.indexOf('RPC_CHANNELS.taskboard.UPDATE,', source.indexOf('registerTasksHandlers'))
    const body = source.slice(at, source.indexOf('RPC_CHANNELS.taskboard.UPDATE_TRIGGER,', at))
    expect(body).toContain('directive')
    expect(body).toContain('scope')
    // `name` was added to the tool so the lane that reads the person's words can replace the
    // 40-character truncation the record was created with; the board has to keep pace.
    expect(body).toContain('name')
  })

  it('reports the refusal reason the gate produced', () => {
    const at = source.indexOf('RPC_CHANNELS.taskboard.RUN,', source.indexOf('registerTasksHandlers'))
    const body = source.slice(at, source.indexOf('RPC_CHANNELS.taskboard.ANSWER,', at))
    expect(body).toContain('result.reason')
    // The sentence may survive in a comment explaining what it replaced; it must not survive
    // as the value being returned.
    expect(body).not.toContain("reason: 'task is already running, blocked, or out of budget'")
  })
})
