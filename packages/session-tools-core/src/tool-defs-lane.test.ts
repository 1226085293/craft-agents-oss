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
  getToolDefsAsJsonSchema,
  isToolVisibleToLane,
  SUPERVISOR_TOOL_NAMES,
  USER_LANE_DENIED_TOOL_NAMES,
} from './tool-defs.ts'

const userLaneTools = () => getSessionToolNames({ role: 'supervisor', supervisorLane: 'user' })
const taskLaneTools = () => getSessionToolNames({ role: 'supervisor', supervisorLane: 'task' })

describe('supervisor lanes', () => {
  it('keeps the dispatcher on the working lane', () => {
    const tools = taskLaneTools()
    // The four that route or approve work, and nothing else.
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
    // Read the board, answer the person, and hand the person's words to the working lane.
    for (const name of ['task_list', 'task_get', 'create_task']) {
      expect(tools.has(name)).toBe(true)
    }
    // …and without a tool for asking the person: `ask_user` targets 「the user lane」, which from
    // inside this lane is itself (`resolveReaderLane` returns the session). Its reply reaches the
    // person directly, so a card would only be a round trip through itself.
    for (const name of ['ask_user', 'list_questions']) {
      expect(tools.has(name)).toBe(false)
    }
  })

  it('gives the working lane task_create, not the relay-only create_task', () => {
    const tools = taskLaneTools()
    expect(tools.has('task_create')).toBe(true)
    expect(tools.has('create_task')).toBe(false)
  })

  it('narrows the JSON-schema path the Pi proxy defs use', () => {
    // The layered registry is built from getToolDefsAsJsonSchema output; a lane
    // dropped here hands the user-facing supervisor dispatch through call_tool.
    const names = new Set(
      getToolDefsAsJsonSchema({ prefix: 'mcp__session__', role: 'supervisor', supervisorLane: 'user' })
        .map((def) => def.name.replace('mcp__session__', '')),
    )
    for (const name of USER_LANE_DENIED_TOOL_NAMES) {
      expect(names.has(name)).toBe(false)
    }
    for (const name of ['task_list', 'task_get', 'create_task']) {
      expect(names.has(name)).toBe(true)
    }
    // Same narrowing on the schema path the proxy defs are built from.
    for (const name of ['ask_user', 'list_questions']) {
      expect(names.has(name)).toBe(false)
    }
  })

  /**
   * One lane writes a task, and it is not this one.
   *
   * `task_create` / `task_update` were allowed here on the argument that 「这个任务不做了」 is a
   * scope change the lane must be able to record. A real run showed the price: this lane created
   * T-1, dispatched it, later wrote a directive releasing the rest — and had no way to make any of
   * it happen, because it cannot dispatch. The task sat `paused` with a fully done plan and the
   * worker's `delivered` was refused as `paused → completed`.
   */
  it('owns no task write, because it cannot dispatch', () => {
    const tools = userLaneTools()
    for (const name of ['task_create', 'task_update', 'task_handoff', 'SubmitPlan', 'dispatch']) {
      expect(tools.has(name)).toBe(false)
    }
  })

  it('keeps the read tools, so answering 「进度如何」 costs no relay', () => {
    const tools = userLaneTools()
    for (const name of ['task_list', 'task_get']) {
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
