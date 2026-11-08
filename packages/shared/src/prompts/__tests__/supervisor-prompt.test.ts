import { describe, it, expect } from 'bun:test'
import { getSupervisorSystemPrompt, SUPERVISOR_PROMPT_TOOLS } from '../supervisor-prompt.ts'
import { SUPERVISOR_TOOL_NAMES } from '../../../../session-tools-core/src/tool-defs.ts'

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
    expect(SUPERVISOR_PROMPT_TOOLS.length as number).toBe(SUPERVISOR_TOOL_NAMES.size as number)
  })
})

describe('lane-specific rules', () => {
  const userLane = () => getSupervisorSystemPrompt({ workspaceRootPath: '/tmp/ws', lane: 'user' })
  const taskLane = () => getSupervisorSystemPrompt({ workspaceRootPath: '/tmp/ws', lane: 'task' })

  it('tells the user lane not to narrate progress or dispatch', () => {
    const text = userLane()
    expect(text).toContain('面向用户');
    expect(text).toContain('不推进任务');
    expect(text).toContain('不要把范围外的步骤写进计划');
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
