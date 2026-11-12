import { describe, it, expect } from 'bun:test'
import { getSupervisorSystemPrompt, SUPERVISOR_PROMPT_TOOLS, USER_LANE_PROMPT_TOOLS } from '../supervisor-prompt.ts'
import { SUPERVISOR_TOOL_NAMES, USER_LANE_DENIED_TOOL_NAMES, USER_LANE_ONLY_TOOL_NAMES, getSessionToolNames } from '../../../../session-tools-core/src/tool-defs.ts'

/**
 * These tests exist because of an observed failure, not for coverage.
 *
 * The supervisor ran with the ordinary 26k-char prompt, which documents browser
 * tools, MCP, Pages, previews and document converters — none of which its tool
 * table contains. It responded by trying to do work itself, could not, and spent
 * its turn discovering that. It also never created tasks: nothing in the prompt
 * suggested it should.
 *
 * The assertions below are the specific things that were missing or wrong.
 */

const prompt = () => getSupervisorSystemPrompt({ workspaceRootPath: '/tmp/ws' })

/**
 * The part of the prompt that describes capabilities, excluding the explicit
 * denial list.
 *
 * Naming a capability in order to deny it is the point — "you have no call_llm"
 * is what stops the model reaching for it. What must not happen is a capability
 * being *documented as usable*. So the behavioral checks below run on the text
 * outside the denial section.
 */
function outsideDenialSection(text: string): string {
  const start = text.indexOf('## 你没有的能力')
  if (start === -1) return text
  const next = text.indexOf('\n## ', start + 1)
  return (text.slice(0, start) + (next === -1 ? '' : text.slice(next))).trim()
}

/** Capabilities the supervisor's tool table does not have. */
const ABSENT_CAPABILITIES = [
  'Browser Tools',
  'External Sources',
  'MCP Tool Naming',
  'Pages',
  'HTML Preview',
  'PDF Preview',
  'Image Preview',
  'Document Tools',
  'markitdown',
  'call_llm',
  'Code Diffs',
  'Developer Feedback',
  'Structured Data',
]

describe('supervisor prompt', () => {
  it('never documents a capability the tool table lacks', () => {
    const text = outsideDenialSection(prompt())
    for (const absent of ABSENT_CAPABILITIES) {
      expect({ absent, present: text.includes(absent) }).toEqual({ absent, present: false })
    }
  })

  it('does deny the missing capabilities, so the model does not reach for them', () => {
    const text = prompt()
    expect(text).toContain('## 你没有的能力')
    expect(text).toContain('call_llm')
  })

  it('says outright that it has no shell or file tools', () => {
    // The failure mode: told about capabilities it lacks, it tries to use them.
    const text = prompt()
    expect(text).toContain('没有')
    expect(text).toContain('shell')
    expect(text).toContain('文件读写')
  })

  it('tells it to create a task before dispatching', () => {
    // It never created tasks; nothing had told it to. And the tool table no
    // longer offers a way to create a session without one, so the prompt must
    // describe the only path that exists.
    const text = prompt()
    expect(text).toContain('task_create')
    expect(text).toContain('先建任务，再派发')
    expect(text).toContain('验收')
  })

  it('never mentions spawn_session', () => {
    // The supervisor cannot call it any more; naming it would send the model
    // looking for a tool that is not in its table, which is exactly the failure
    // the pruned table is meant to prevent.
    expect(prompt()).not.toContain('spawn_session')
  })

  it('names the fields a task needs to be verifiable', () => {
    const text = prompt()
    for (const field of ['name', 'instruction', 'scope', 'deliverables', 'acceptance']) {
      expect({ field, present: text.includes(field) }).toEqual({ field, present: true })
    }
  })

  it('warns against dispatching work that has no task', () => {
    expect(prompt()).toContain('常见错误')
  })

  it('keeps the hand-off discipline that makes the turn cap survivable', () => {
    const text = prompt()
    // Dispatch and end; polling is what burned the whole turn.
    expect(text).toContain('派完就结束回合')
    expect(text).toContain('不要轮询')
  })

  it('carries the persona and events blocks when given', () => {
    const text = getSupervisorSystemPrompt({
      workspaceRootPath: '/tmp/ws',
      personaBlock: '<persona>Test Persona</persona>',
      eventsBlock: 'qqmail-idle: 新邮件',
    })
    expect(text).toContain('Test Persona')
    expect(text).toContain('qqmail-idle')
  })

  it('stays far smaller than the ordinary prompt', () => {
    // The ordinary base prompt is ~26k chars. This is the whole point of the
    // split: the supervisor should not read a manual for tools it cannot use.
    expect(prompt().length).toBeLessThan(6000)
  })

  it('only names tools the supervisor actually has', () => {
    // Every backticked identifier that looks like a tool must be in the table.
    const text = outsideDenialSection(prompt())
    const mentioned = [...text.matchAll(/`([a-z][a-z_]+)`/g)].map((m) => m[1]!)
    const unknown = mentioned.filter(
      (name) => name.includes('_') && !SUPERVISOR_TOOL_NAMES.has(name) && name !== 'tools_workspace' && name !== 'call_tool',
    )
    expect(unknown).toEqual([])
  })

  it('declares a tool list that matches the real supervisor table', () => {
    // Catches drift in either direction: this list is documentation, the table is
    // enforcement, and they must not disagree.
    for (const name of SUPERVISOR_PROMPT_TOOLS) {
      expect(SUPERVISOR_TOOL_NAMES.has(name)).toBe(true)
    }
    // Compare as numbers: a Set's .size widens to a literal here otherwise.
    // `create_task` is in the supervisor table but user-lane-only, so it is absent from the
    // working-lane list; the user-lane list is pinned against the real table below.
    expect(SUPERVISOR_PROMPT_TOOLS.length as number).toBe(
      (SUPERVISOR_TOOL_NAMES.size - USER_LANE_ONLY_TOOL_NAMES.size) as number
    )
  })
})

describe('lane-specific rules', () => {
  const userLane = () => getSupervisorSystemPrompt({ workspaceRootPath: '/tmp/ws', lane: 'user' })
  const taskLane = () => getSupervisorSystemPrompt({ workspaceRootPath: '/tmp/ws', lane: 'task' })

  it('tells the user lane not to narrate progress or dispatch', () => {
    const text = userLane()
    expect(text).toContain('面向用户');
    expect(text).toContain('不推进任务');
    // The relay verbatim rule replaced the old 「不要把范围外的步骤写进计划」 line:
    // this lane no longer writes anything, so the rule is about not rewriting the person's words.
    expect(text).toContain('照抄原话放进');
  });

  it('tells the task lane that scope is a boundary', () => {
    const text = taskLane()
    expect(text).toContain('面向任务');
    expect(text).toContain('不要自己继续派活');
  });

  it('does not leak one lane rule into the other', () => {
    // Both blocks use 「面向…」 headings; the other one's must be absent entirely.
    expect(userLane()).not.toContain('## 这是「面向任务」的通道');
    expect(taskLane()).not.toContain('## 这是「面向用户」的通道');
  })

  it('defaults to the working lane when none is given', () => {
    expect(getSupervisorSystemPrompt({ workspaceRootPath: '/tmp/ws' })).toBe(taskLane());
  })
})

/**
 * A prompt that names a tool the session does not have is the same lie as one that denies a
 * tool it does have — and both were shipping: the user lane was told 「不派活」 while holding
 * `dispatch`, and the shared prompt then gave it a `dispatch(...)` tutorial.
 *
 * These pin the two lanes against their real tables, in both directions.
 */
describe('lane prompts match their tool tables', () => {
  const userLane = () => getSupervisorSystemPrompt({ workspaceRootPath: '/tmp/ws', lane: 'user' })
  const taskLane = () => getSupervisorSystemPrompt({ workspaceRootPath: '/tmp/ws', lane: 'task' })

  /**
   * Backticked lowercase identifiers that look like tool names, in prose the model will act on.
   *
   * `「本通道没有 dispatch」` is allowed — naming a tool to forbid it is the point of that sentence.
   * What must not appear is a mention the model could read as 「you have this」, i.e. one that is
   * not preceded by a denial in the same sentence fragment.
   */
  const DENIAL = /(没有|不要|不可以|禁止|不要尝试|不能)\s*$/
  const mentionedTools = (text: string): string[] =>
    [...text.matchAll(/`([a-z][a-z_]+)`/g)]
      .filter((m) => {
        const before = text.slice(Math.max(0, m.index! - 30), m.index!).replace(/\*\*/g, '')
        return !DENIAL.test(before)
      })
      .map((m) => m[1]!)
      .filter((name) => SUPERVISOR_TOOL_NAMES.has(name) || USER_LANE_DENIED_TOOL_NAMES.has(name))

  it('never names a routing tool in the user lane', () => {
    const named = new Set(mentionedTools(userLane()))
    for (const denied of USER_LANE_DENIED_TOOL_NAMES) {
      expect(named.has(denied)).toBe(false)
    }
  })

  it('names no tool the user lane lacks, anywhere in its prompt', () => {
    const laneTools = getSessionToolNames({ role: 'supervisor', supervisorLane: 'user' })
    for (const name of mentionedTools(userLane())) {
      expect(laneTools.has(name)).toBe(true)
    }
  })

  it('keeps the dispatch tutorial out of the user lane, and in the working lane', () => {
    expect(userLane()).not.toContain('怎么把活派出去')
    expect(userLane()).not.toContain('dispatch({')
    expect(taskLane()).toContain('怎么把活派出去')
  })

  it('declares a user-lane tool list that matches the real user-lane table', () => {
    const laneTools = getSessionToolNames({ role: 'supervisor', supervisorLane: 'user' })
    for (const name of USER_LANE_PROMPT_TOOLS) {
      // Every name here must be a real supervisor tool; this list must stay truthful.
      expect(SUPERVISOR_TOOL_NAMES.has(name)).toBe(true)
      expect(laneTools.has(name)).toBe(true)
    }
    expect(USER_LANE_PROMPT_TOOLS.length as number).toBe(laneTools.size as number)
  })

  it('gives the user lane a smaller table than the working lane', () => {
    const user = getSessionToolNames({ role: 'supervisor', supervisorLane: 'user' })
    const task = getSessionToolNames({ role: 'supervisor', supervisorLane: 'task' })
    expect(user.size as number).toBeLessThan(task.size as number)
    // Everything the user lane has, the working lane has too — with one deliberate exception:
    // `create_task` is the user lane's own door (the task lane has `task_create`), so it is the
    // only name a lane may carry that the other does not. Everything else still only narrows.
    for (const name of user) {
      if (USER_LANE_ONLY_TOOL_NAMES.has(name)) continue
      expect(task.has(name)).toBe(true)
    }
  })
})

/**
 * The boundary the prompt names has to be the one the code reads.
 *
 * `sliceDeliveredButPlanOpen` pauses a delivery only when `spec.directive` exists. The prompt
 * said 「scope 就是边界」 for months, so a supervisor did what it was told — wrote the scope,
 * wrote no directive — and the task ran past the user's 「做完 1.1 就停」 into 1.2 in a fresh
 * session. A prompt that names the wrong field is worse than one that stays silent: it is a
 * confident instruction to do the ineffective thing.
 */
describe('the authorisation boundary is named the way the code reads it', () => {
  for (const lane of ['user', 'task'] as const) {
    it(`tells the ${lane} lane about directive, not scope, as the boundary`, () => {
      const text = getSupervisorSystemPrompt({ workspaceRootPath: '/tmp/ws', lane })
      expect(text).toContain('directive')
      // The exact claim that was wrong.
      expect(text).not.toContain('scope` 就是边界')
    })
  }

  it('does not leave 「scope is the boundary」 anywhere in either lane', () => {
    for (const lane of ['user', 'task'] as const) {
      const text = getSupervisorSystemPrompt({ workspaceRootPath: '/tmp/ws', lane })
      expect(text.includes('scope 就是边界')).toBe(false)
    }
  })
})
