/**
 * Two lanes, two tool tables.
 *
 * 督导·用户 is the conversation the person reads and types into; it turns words into tasks and
 * answers questions. 督导·任务 runs the work. Both are `role: 'supervisor'`, so the role check
 * alone handed the user-facing lane the dispatcher — while its own prompt says 「不派活」. A model
 * holding a tool its instructions forbid either uses it or spends the turn not using it.
 */
import { describe, expect, it } from 'bun:test'

import {
  getSessionToolNames,
  isToolVisibleToLane,
  SUPERVISOR_TOOL_NAMES,
  USER_LANE_DENIED_TOOL_NAMES,
} from './tool-defs.ts'

const userLaneTools = () => getSessionToolNames({ role: 'supervisor', supervisorLane: 'user' })
const taskLaneTools = () => getSessionToolNames({ role: 'supervisor', supervisorLane: 'task' })

describe('supervisor lanes', () => {
  it('keeps the dispatcher on the working lane', () => {
    const tools = taskLaneTools()
    // The four that route or approve work, and nothing else: `task_verify` is not in this
    // table at all, so asserting on it here would only pin the test to a name that never ships.
    for (const name of ['dispatch', 'task_handoff', 'SubmitPlan', 'send_agent_message']) {
      expect(tools.has(name)).toBe(true)
    }
  })

  it('takes every routing tool off the user lane', () => {
    const tools = userLaneTools()
    for (const name of USER_LANE_DENIED_TOOL_NAMES) {
      expect(tools.has(name)).toBe(false)
    }
  })

  it('leaves the user lane able to do its own job', () => {
    const tools = userLaneTools()
    // Turning the person's words into a task, and asking/telling them things.
    for (const name of ['task_create', 'task_list', 'task_get', 'task_update', 'report_to_user', 'ask_user']) {
      expect(tools.has(name)).toBe(true)
    }
  })

  it('never widens the role table', () => {
    // A lane can only take tools away; anything visible to a lane is in the supervisor table.
    for (const name of [...userLaneTools(), ...taskLaneTools()]) {
      expect(SUPERVISOR_TOOL_NAMES.has(name)).toBe(true)
    }
  })

  it('treats a supervisor written before lanes as the working lane', () => {
    // Defaulting the other way would strip the dispatcher from every existing supervisor.
    expect(isToolVisibleToLane('dispatch', undefined)).toBe(true)
    expect(getSessionToolNames({ role: 'supervisor' }).has('dispatch')).toBe(true)
  })

  it('does not narrow a worker with a lane', () => {
    // A lane is a supervisor concept; a worker that happens to carry the field must not change.
    // (`read` / `bash` are SDK built-ins and live in `builtin-tool-policy`, not this table.)
    const plain = getSessionToolNames({ role: 'worker' })
    const withLane = getSessionToolNames({ role: 'worker', supervisorLane: 'user' })
    expect([...withLane]).toEqual([...plain])
    // Supervisor-only tools stay out regardless of lane.
    expect(withLane.has('dispatch')).toBe(false)
    expect(withLane.has('report_to_user')).toBe(false)
  })
})
