import { describe, expect, it } from 'bun:test';

import { formatAgentRosterSection, formatDispatchTaskContext, formatExecutionRuleBlock, formatPlanRuleBlock, formatTaskBrief, formatUnreportedBrief } from '../brief.ts';
import type { Task } from '../types.ts';

const NOW = 1_800_000_000_000;

const task = (overrides: Partial<Task> = {}): Task => ({
  id: 'T-1',
  name: '状态图标验证',
  instruction: '创建 docs/a.md',
  status: 'running',
  pauseReason: null,
  supervisorSessionId: 'sup',
  sessionIds: ['s1'],
  currentSessionId: 's1',
  dependsOn: [],
  priority: 1,
  budget: { maxSessions: 8, maxRuns: 12, activeMinutes: 120, deadline: null },
  handoffs: [],
  verify: { enabled: false, maxIterations: 2 },
  lifecycle: { errorCount: 0, consecutiveFailures: 0 },
  origin: { supervisorSessionId: 'sup', toolCallId: 'c1' },
  heartbeatIntervalMin: 10,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe('the brief always states the current plan', () => {
  /**
   * "No plan field" and "an empty plan" read identically unless the empty case is said
   * out loud. A worker that cannot tell whether anything has been agreed writes its own
   * outlines — which is how a second 「读回确认」 appeared beside the one already in 1.2.
   */
  it('says the plan is empty when nothing has been written', () => {
    const text = formatTaskBrief(task());
    expect(text).toContain('## Current plan');
    expect(text).toContain('no steps yet');
  })

  it('lists the steps when a plan exists', () => {
    const text = formatTaskBrief(
      task({
        spec: {
          plan: [
            { id: '1', title: '写文件', status: 'done' },
            { id: '2', title: '收尾', status: 'todo' },
          ],
        },
      }),
    )
    expect(text).toContain('## Current plan');
    expect(text).toContain('写文件');
    expect(text).not.toContain('no steps yet')
  })

  it('tells the worker not to plan the same thing twice', () => {
    // The rule needs a criterion, not an adjective: one action, one id.
    const text = formatTaskBrief(task())
    expect(text).toContain('one thing, one id')
  })
})

describe('the plan is a record, not a draft', () => {
  /**
   * Rule 1 used to say 「先用一次 task_plan 写下大纲：3–7 条」 unconditionally — so a worker
   * whose task already had an agreed plan was told to write a new one anyway. One worker
   * resolved that conflict by writing outline `2 读回确认` and then `1.2 读回确认` in the
   * same turn. Steps change because the plan was wrong or something is missing, never
   * because work is starting.
   */
  it('tells a worker with no plan to write one', () => {
    const text = formatPlanRuleBlock({ planExists: false });
    expect(text).toContain('There is no plan yet');
    expect(text).toContain('3-7 items');
  })

  it('tells a worker with a plan not to rewrite it', () => {
    const text = formatPlanRuleBlock({ planExists: true });
    expect(text).toContain('do not rewrite it');
    expect(text).toContain('do not rewrite it');
    // The criterion, not an adjective: two reasons to change a step.
    expect(text).toContain('do not rewrite it');
    expect(text).toContain('one thing, one id');
  })

  it('ships the plan with the rules when dispatching', () => {
    const text = formatDispatchTaskContext({
      spec: { plan: [{ id: '1', title: '写文件', status: 'todo' }] } as never,
    });
    // Rules that say 「不要重写计划」 are useless without the plan to not rewrite.
    expect(text).toContain('Current plan');
    expect(text).toContain('写文件');
    expect(text).toContain('do not rewrite it');
  })

  it('still gives the rules when the task has no plan yet', () => {
    const text = formatDispatchTaskContext({ spec: undefined });
    expect(text).not.toContain('Current plan');
    expect(text).toContain('There is no plan yet');
  })
})

describe('the nudge for a worker that stopped without filing', () => {
  /**
   * The nudge used to assume a finished plan. A worker that had finished its assigned
   * slice but not the whole plan was unreachable by it — and that is the common case,
   * since legs are usually one step. It needs to say which situation it is.
   */
  it('asks for a handoff when the plan still has open steps', () => {
    const text = formatUnreportedBrief(
      task({
        spec: {
          plan: [
            { id: '1', title: '写文件', status: 'doing' },
            { id: '2', title: '收尾', status: 'todo' },
          ],
        },
      }),
    );
    expect(text).toContain('handoff');
    expect(text).toContain('2 收尾');
    // Explicit, because this is the misconception that cost a whole round.
    expect(text).toContain('A summary written in the conversation is not a hand-off');
  })

  it('asks for delivery when the plan is finished', () => {
    const text = formatUnreportedBrief(
      task({ spec: { plan: [{ id: '1', title: '写文件', status: 'done' }] } }),
    );
    expect(text).toContain('has its whole plan finished');
    expect(text).toContain('delivered');
  })
})

/**
 * 「做不到」 must not be filed as `delivered`.
 *
 * Observed live: a worker that had no `ask_user` was asked to send the person a greeting. It could
 * not, wrote a file instead, and reported `delivered`. The supervisor read 「已送达」 and closed the
 * task — the person never got the message and the plan said the work was done. The rule below is
 * the one line that makes that impossible: a blocked step is a `handoff`, and `delivered` means the
 * step really is finished.
 */
describe('a step that cannot be done is not a delivery', () => {
  const rules = () => formatExecutionRuleBlock()

  it('sends a blocked step to handoff, with what is missing named', () => {
    expect(rules()).toContain('Cannot do it as instructed')
    expect(rules()).toContain('missing tool')
    expect(rules()).toContain('who has to do it')
  })

  it('forbids delivered for that case, and says why', () => {
    expect(rules()).toContain('Do not use `delivered`')
    expect(rules()).toContain('supervisor reads it as')
  })

  it('keeps the real delivery rule next to it, so the two read as a contrast', () => {
    // Removing the neighbour would turn the new rule into 「never deliver」.
    expect(rules()).toContain('The whole plan is finished')
    expect(rules()).toContain('this version ends here')
  })
})

/**
 * The brief has to say where the owner comes from, before the step is written.
 *
 * Rule 6 said 「每一条小节都要写负责人」, which is a statement about the finished row. What was
 * missing is the step before it: read the roster, then choose. Plans kept arriving with owners
 * missing because the rule read like a formatting note, and the only place the roster appeared was
 * further down the brief.
 */
describe('writing a sub-step', () => {
  it('tells the worker to read the roster first and name an owner', () => {
    const rules = formatPlanRuleBlock({ planExists: true });

    expect(rules).toContain('Available owners');
    expect(rules).toContain('agent');
    // Reading the roster is the instruction; stamping a default afterwards is not.
    expect(rules).toContain('agent');
    expect(rules).toContain('refused');
  })

  it('carries the roster with the ids to choose from', () => {
    const brief = formatTaskBrief(task(), {
      roster: [
        { id: 'builtin-default', dispatchHint: '通用执行' },
        { id: 'agent-qa', dispatchHint: '验收与复现' },
      ],
    });

    expect(brief).toContain('agent-qa');
    expect(brief).toContain('do not invent names');
  })
})

/**
 * The roster line has to carry what the profile is for, not just its id.
 *
 * `readAgentRoster` returns `{ id, name, gist, isDefault }`, and this section used to read
 * `dispatchHint`/`persona` — fields those entries do not have. Every line printed as a bare id, so
 * the rule above it (「按这一小节实际要做的事选人」) pointed at a list with nothing to compare the
 * work against. Verified against the real workspace: 「默认」 and 「UI 工」 printed with no
 * description at all.
 */
describe('the roster section', () => {
  it('prints what each profile takes on', () => {
    const text = formatAgentRosterSection([
      { id: 'builtin-default', name: '默认', gist: '兜底的万能手。接临时脚本。', isDefault: true },
      { id: 'agent-ui', name: 'UI 工', gist: '接界面视觉与交互。' },
    ] as never)

    expect(text).toContain('Available owners')
    expect(text).toContain('builtin-default');
    // An id is a storage key; the reader is looking for a role.
    expect(text).toContain('default');
    expect(text).toContain('`builtin-default`')
    // Which one catches the work nobody claimed is part of the division of labour.
    expect(text).toContain('unassigned work defaults here')
  })

  it('still prints an id-only entry rather than dropping it', () => {
    // A profile with no persona and no hint is still a candidate; hiding it would make the list
    // look complete when it is not.
    const text = formatAgentRosterSection([{ id: 'agent-x' }] as never)

    expect(text).toContain('`agent-x`')
  })
})

describe('the worker brief is written in English', () => {
  it('has no Chinese left in the rules it hands to a worker', () => {
    const cjk = formatExecutionRuleBlock().match(/[一-龥]/g) ?? []
    expect(cjk.length).toBe(0)
  })
})
