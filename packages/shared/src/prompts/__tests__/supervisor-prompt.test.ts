import { describe, it, expect } from 'bun:test'
import { getSupervisorSystemPrompt, SUPERVISOR_PROMPT_TOOLS, USER_LANE_PROMPT_TOOLS, WORKER_MISSING_TOOLS } from '../supervisor-prompt.ts'
import { SUPERVISOR_TOOL_NAMES, TASK_LANE_DENIED_TOOL_NAMES, USER_LANE_DENIED_TOOL_NAMES, USER_LANE_ONLY_TOOL_NAMES, getSessionToolNames } from '../../../../session-tools-core/src/tool-defs.ts'

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
  const start = text.indexOf('## What you cannot do')
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
    expect(text).toContain('## What you cannot do')
    expect(text).toContain('call_llm')
  })

  it('says outright that it has no shell or file tools', () => {
    // The failure mode: told about capabilities it lacks, it tries to use them.
    const text = prompt()
    expect(text).toContain('You have **no** shell')
    expect(text).toContain('shell')
    expect(text).toContain('file read/write')
  })

  it('says the record always arrives first, because this lane cannot create one', () => {
    // There is exactly one entrance now: the person's words become a task through the user lane
    // (`create_task`, the only door that carries `triggers`). The working lane fills that record in
    // and keeps it moving. It used to also have `task_create` for work it discovered on its own —
    // and a task born that way had no person behind it and no schedule, so it could only run once.
    const text = prompt()
    expect(text).toContain('The record always exists before you see it')
    expect(text).toContain('You have no `task_create`')
    expect(text).toContain('acceptance')
    // Work it discovers goes into the plan it is already pushing, not into a second task.
    expect(text).toContain("belongs to this task's plan")
    // The old unconditional 「create the task first, then dispatch」 is the bug; it must not return.
    expect(text).not.toContain('create the task first, then dispatch')
  })

  it('says a task starts by dispatching, not by setting status running', () => {
    // Observed: `task_update({status:'running'})` was refused, and the lane had been told by the
    // tool description that "advance a task (running / ...)" was a legal move.
    const text = prompt()
    expect(text).toContain('dispatch')
    expect(text).toMatch(/only for \*\*stopping\*\*/)
  })

  it('carries the renaming rule and the plan rules the lane now needs', () => {
    const text = prompt()
    // The record name is a truncation of the request; the lane that reads the words renames it.
    expect(text).toContain('first 40 characters')
    expect(text).toContain('`name`')
    // Plan rules that previously lived only in the worker brief (`tasks/brief.ts`), each one
    // learned the hard way from a validator rejection in a real run.
    expect(text).toContain('carries no `status`')
    expect(text).toContain('must hang under an existing outline item')
    expect(text).toMatch(/names an `agent`/)
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
    // The other half of the old warning — 「don't call task_create after receiving a relayed task」
    // — is gone with the tool itself: the working lane can no longer create a task at all.
    const text = prompt()
    expect(text).toContain('dispatching without a task record')
    expect(text).toContain('Work without a task is work nobody can tell ever happened')
  })

  it('keeps the hand-off discipline that makes the turn cap survivable', () => {
    const text = prompt()
    // Dispatch and end; polling is what burned the whole turn.
    expect(text).toContain('End the turn after dispatching')
    expect(text).toContain('do not poll')
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

  it('tells the model which language the person reads', () => {
    // The prompt is English because the system speaks English; the person does not. Without this
    // line the supervisor answers in the prompt's language — observed: a Chinese user received
    // every report and every ask_user card in English.
    expect(prompt()).toContain('Please reply in English.')
    expect(getSupervisorSystemPrompt({ workspaceRootPath: '/tmp/ws', replyLanguage: '简体中文' }))
      .toContain('Please reply in 简体中文.')
  })

  it('never hardcodes a language into the prompting rules', () => {
    // A second place that names a language is a place that can disagree with the setting.
    const text = prompt()
    const occurrences = text.split('Please reply in').length - 1
    expect(occurrences).toBe(1)
  })

  it('stays far smaller than the ordinary prompt', () => {
    // The ordinary base prompt is ~26k chars. This is the whole point of the
    // split: the supervisor should not read a manual for tools it cannot use.
    expect(prompt().length).toBeLessThan(16000)
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


  it('is written entirely in English, both lanes', () => {
    // The prompt is English because the system speaks English; the person's language is handled by
    // the `Please reply in …` line, not by translating the rules. One Chinese rule left behind makes
    // the document read as two documents — the reason the whole file was rewritten rather than
    // patched.
    for (const lane of ['task', 'user'] as const) {
      const text = getSupervisorSystemPrompt({ workspaceRootPath: '/tmp/ws', lane })
      const cjk = text.match(/[一-龥]/g) ?? []
      expect({ lane, cjk: cjk.length }).toEqual({ lane, cjk: 0 })
    }
  })


  it('says relaying means handing the work to another session, not doing it here', () => {
    // Live: the task lane answered 「你好+N」 out of its own turn. Its reasoning was that the greeting
    // could only be sent with ask_user, which the worker lacks — true, and it read that as 「so I do
    // it」. The fix is the sentence it was missing: the worker composes, you send.
    const text = getSupervisorSystemPrompt({ workspaceRootPath: '/tmp/ws', lane: 'task' })
    expect(text).toContain('making the work happen in a session that is not this one')
    expect(text).toContain('you may not sit at this desk and write the output yourself')
  })

  it('gives periodic messages a notice channel instead of a decision', () => {
    // Live: every round asked 「shall I stop?」 because the greeting had to travel as kind=decision —
    // the only kind that carries text without ending the task. Two greetings in one turn then
    // replaced each other, so 「你好+1」 was never sent and +2 was.
    const text = getSupervisorSystemPrompt({ workspaceRootPath: '/tmp/ws', lane: 'task' })
    expect(text).toContain('`notice`')
    expect(text).toContain('A periodic message is a `notice`, never a `decision`')
  })

  it('plans one round for a task that repeats, not the whole future', () => {
    // Live: 「每分钟发个你好，数字累加」 became ten steps (1.1 hello+0 … 1.10 hello+9). Ten rounds in one
    // plan means no round can ever be delivered, and the counter it was counting dies with the steps.
    const text = getSupervisorSystemPrompt({ workspaceRootPath: '/tmp/ws', lane: 'task' })
    expect(text).toContain('plans one round, not the whole future')
    /**
     * The rule is about **rounds, not outlines**.
     *
     * It used to read 「the plan must not repeat: it holds one round's work only … stop at `1`」, and
     * the code behind it refused a second outline on a recurring task. Both were too strong: a
     * round may need several outlines (`1` gather, `2` write, `3` clean up) exactly like a one-off
     * task. What must not happen is one outline *per round* — that is numbering history.
     */
    expect(text).toContain('Repeating is the trigger')
    expect(text.replace(/\s+/g, ' ')).toContain('a rule about **rounds, not outlines**')
    // The old unconditional prohibition must not come back: this lane may write outlines 1, 2, 3.
    expect(text).not.toContain('stop at \`1\`')
    expect(text).toContain('lastRound')
  })

  it('declares a tool list that matches the real supervisor table', () => {
    // Catches drift in either direction: this list is documentation, the table is
    // enforcement, and they must not disagree.
    for (const name of SUPERVISOR_PROMPT_TOOLS) {
      expect(SUPERVISOR_TOOL_NAMES.has(name)).toBe(true)
    }
    // Compare as numbers: a Set's .size widens to a literal here otherwise.
    // Two tools are in the supervisor table but not in the working-lane list: `create_task` is
    // user-lane-only, and `task_create` is denied to the working lane (the user lane owns creation).
    // The user-lane list is pinned against the real table below.
    expect(SUPERVISOR_PROMPT_TOOLS.length as number).toBe(
      (SUPERVISOR_TOOL_NAMES.size - USER_LANE_ONLY_TOOL_NAMES.size - TASK_LANE_DENIED_TOOL_NAMES.size) as number
    )
  })
})

describe('the message header rules', () => {
  const taskLane = () => getSupervisorSystemPrompt({ workspaceRootPath: '/tmp/ws', lane: 'task' })

  /**
   * The lane once displayed 「用户拍板放行」 with no answer anywhere in the record: it read a
   * progress report as the person's words. The header rules exist so the lane judges messages
   * by their 报头 (source/type/effect), not by their content.
   */
  it('teaches the lane to read the header, not the brackets', () => {
    const text = taskLane()
    expect(text).toContain('Read the header, not the brackets')
    expect(text).toContain('`source`')
    expect(text).toContain('`message type`')
    expect(text).toContain('authority')
  })

  it('says only messages from the person authorise, and system messages never do', () => {
    const text = taskLane()
    expect(text).toContain('Only `source: user` messages are the person') 
    expect(text).toContain('confer no authority')
  })

  it('tells the lane how to act on a 拍板答复: write the directive', () => {
    const text = taskLane()
    expect(text).toContain('message type: answer')
    expect(text).toContain('task_update')
  })
})

describe('lane-specific rules', () => {
  const userLane = () => getSupervisorSystemPrompt({ workspaceRootPath: '/tmp/ws', lane: 'user' })
  const taskLane = () => getSupervisorSystemPrompt({ workspaceRootPath: '/tmp/ws', lane: 'task' })

  it('tells the user lane not to narrate progress or dispatch', () => {
    const text = userLane()
    expect(text).toContain('This is the user-facing lane');
    expect(text).toContain('You do not push tasks forward');
    // The relay verbatim rule replaced the old 「不要把范围外的步骤写进计划」 line:
    // this lane no longer writes anything, so the rule is about not rewriting the person's words.
    expect(text).toContain('copy their exact words into');
  });

  it('tells the user lane to stop after creating a task instead of narrating the backlog', () => {
    // Live on T-1 (2026-11-13 06:03): the person asked for a task; nine seconds later the user
    // lane had read `backlog` (the working lane dispatches a moment later), concluded the system
    // was stuck, and sent two ask_user calls — a `decision` offering 「再等一会 / 取消重建」 and a
    // `blocked`. It also quoted words the person never said. None of that is a question a person
    // can act on, and all of it came from a rule that was never written down.
    const text = userLane()
    expect(text).toContain('Stop after registering');
    expect(text).toContain('Do not `task_get` again in the same turn');
    expect(text).toContain('Do not ask the person about the system');
    // The 「只用一次 ask_user」 line went with the tool: this lane has none, so the rule is
    // 「停在这里」 — the same intent, without naming a capability it does not have.
    expect(text).toContain('One sentence is enough');
  });

  it('tells the task lane to continue when the directive already covers the rest', () => {
    // The old rule was 「已交付过一轮、计划还有剩余 → 一律先问用户」, which asked once per
    // outline even when the person had said 「做 3 条大纲，全部做完」 and the directive said so.
    // The test is about the boundary now: continue when authorised, ask only when it stops short.
    const text = taskLane()
    expect(text).toContain('This is the task-facing lane');
    expect(text).toContain('already covers the remaining steps');
    expect(text).toContain('Do not confirm after every sub-step');
  });

  /**
   * A live run, 2026-11-13: the person wrote 「一分钟给我发一次你好」. The user lane checked its own
   * abilities (it has no timer), answered 「我做不到」, and asked the person to pick a fallback —
   * no task was ever created. Then it called `ask_user`, whose card landed in its own transcript,
   * because `resolveReaderLane` returns the session itself for this lane.
   *
   * Both rules are asserted as text because both were absent text: the lane was told where it
   * speaks, never that speaking IS the answer, and never that 「能不能做到」 is not its call.
   */
  it('tells the user lane that it is already talking to the person', () => {
    // The line used to explain that `ask_user` would address the lane itself. It no longer names
    // the tool at all: the table already withholds it, and a name in the prompt is half a
    // capability. What has to survive is the fact the lane kept forgetting — this IS the person's
    // conversation.
    const text = userLane()
    expect(text).toContain('You are already talking to the person');
    expect(text).toContain('They read this session directly');
  });

  it('does not let the user lane decide whether something is possible', () => {
    const text = userLane()
    expect(text).toContain('You do not judge feasibility');
    // The three shapes the task system actually has, named so the lane stops inventing a fourth.
    expect(text).toContain('one-off (manual)');
    expect(text).toContain('repeating on a schedule (cron)');
    expect(text).toContain('event-triggered');
    // Only as the sentence that forbids saying it — there is no 「I can't」 branch left.
    expect(text).toContain("do not answer \"I can't\"");
  });

  it('does not leak one lane rule into the other', () => {
    // Both blocks use 「面向…」 headings; the other one's must be absent entirely.
    expect(userLane()).not.toContain('## This is the task-facing lane');
    expect(taskLane()).not.toContain('## This is the user-facing lane');
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
  const DENIAL = /(没有|不要|不可以|禁止|不要尝试|不能|no|not|never|cannot|do not)\s*\**\s*$/i
  const mentionedTools = (text: string): string[] =>
    [...text.matchAll(/`([a-z][a-z_]+)`/g)]
      .filter((m) => {
        const before = text.slice(Math.max(0, m.index! - 30), m.index!).replace(/\*\*/g, '')
        return !DENIAL.test(before)
      })
      .map((m) => m[1]!)
      .filter((name) => SUPERVISOR_TOOL_NAMES.has(name) || USER_LANE_DENIED_TOOL_NAMES.has(name))

  it('never names a routing tool in the user lane', () => {
    // Naming a tool in order to deny it is the point — 「你手上没有这两个工具」 is what stops the
    // model reaching for it. What must not happen is a denied tool being *described as usable*,
    // so every mention has to sit in a clause that says no. Split on line breaks without a
    // backslash in the pattern: this file is written through tools that eat them.
    const NL = String.fromCharCode(10)
    const clauses = userLane()
      .split(NL)
      .flatMap((line) => line.split('。'))
    for (const denied of USER_LANE_DENIED_TOOL_NAMES) {
      for (const clause of clauses) {
        if (!clause.includes(denied)) continue
        const denies =
          /没有|不要|不是|别|禁止/.test(clause) ||
          /(?:^|[^a-z])(?:no|not|never|cannot|do not|does not)(?:[^a-z]|$)/i.test(clause)
        expect(denies).toBe(true)
      }
    }
  })

  it('names no tool the user lane lacks, anywhere in its prompt', () => {
    const laneTools = getSessionToolNames({ role: 'supervisor', supervisorLane: 'user' })
    for (const name of mentionedTools(userLane())) {
      // The only permitted mentions of a tool this lane does not have are the ones that say it
      // does not have it: 「你手上没有这两个工具」 is what stops the model reaching for them.
      if (USER_LANE_DENIED_TOOL_NAMES.has(name)) continue
      expect(laneTools.has(name)).toBe(true)
    }
  })

  it('keeps the dispatch tutorial out of the user lane, and in the working lane', () => {
    expect(userLane()).not.toContain('How to hand work out')
    expect(userLane()).not.toContain('dispatch({')
    expect(taskLane()).toContain('How to hand work out')
  })

  it('tells the working lane which tools its workers do not have', () => {
    // The failure this prevents: a worker without `ask_user` was told to send the person a
    // greeting. It wrote a file instead and reported `delivered`; the supervisor read 「已送达」
    // and closed the task. Nothing in its prompt said the gap existed or who had to fill it.
    const text = taskLane()
    expect(text).toContain('Tools your workers do not have')
    for (const name of WORKER_MISSING_TOOLS) {
      expect(text).toContain(`\`${name}\``)
    }
    expect(text).toContain('you relay it')
    expect(text).toContain('Never claim a relay you did not make')
  })

  it('keeps the worker tool gap out of the user lane', () => {
    // The user lane cannot dispatch and cannot relay, so a section about relaying would be the
    // same contradiction the dispatch tutorial was removed for.
    expect(userLane()).not.toContain('Tools your workers do not have')
  })

  it('declares exactly the tools a worker is missing', () => {
    // The list is a constant because `shared` cannot import `session-tools-core`; this assertion
    // is the link that keeps it honest. If a tool moves between roles, this fails instead of the
    // prompt quietly describing a table that no longer exists.
    const supervisorTaskLane = getSessionToolNames({ role: 'supervisor', supervisorLane: 'task' })
    const worker = getSessionToolNames({ role: 'worker' })
    const missing: string[] = [...supervisorTaskLane].filter((name) => !worker.has(name)).sort()
    expect([...WORKER_MISSING_TOOLS].map(String).sort()).toEqual(missing)
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
      expect(text).not.toContain('scope is the boundary')
    })
  }

  it('does not leave 「scope is the boundary」 anywhere in either lane', () => {
    for (const lane of ['user', 'task'] as const) {
      const text = getSupervisorSystemPrompt({ workspaceRootPath: '/tmp/ws', lane })
      expect(text.includes('scope is the boundary')).toBe(false)
    }
  })
})
