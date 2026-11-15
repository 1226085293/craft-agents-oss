import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { TaskBoardPanel, type TaskDetailView, type TaskListItem } from '../TaskBoardPanel'
import { TaskDetailPanelView } from '../TaskDetailPanelView'

const runningTask: TaskListItem = {
  id: 'T-11',
  name: '刷新任务面板',
  status: 'running',
  priority: 2,
  updatedAt: Date.now() - 4 * 60_000,
  currentSessionId: 'session-coral',
  sessionCount: 2,
  lastHandoff: '列表布局已完成，正在补充交接时间线。',
}

const backlogTask: TaskListItem = {
  id: 'T-12',
  name: '梳理任务状态',
  status: 'backlog',
  priority: 0,
  updatedAt: Date.now() - 2 * 60 * 60_000,
  sessionCount: 0,
}

const pausedTask: TaskListItem = {
  id: 'T-13',
  name: '等待验收决定',
  status: 'paused',
  priority: 1,
  updatedAt: Date.now(),
  sessionCount: 1,
  pauseReason: 'needs_decision',
}

const detail: TaskDetailView = {
  id: 'T-13',
  name: '等待验收决定',
  instruction: '确认首页的验收方案，并补齐交接记录。',
  status: 'paused',
  pauseReason: 'needs_decision',
  sessionIds: ['session-coral', 'session-indigo'],
  currentSessionId: 'session-indigo',
  handoffs: [
    {
      at: Date.now() - 20 * 60_000,
      fromSessionId: 'session-coral',
      outcome: 'needs_decision',
      summary: '完成实现，等待用户确认视觉取舍。',
      keyFindings: ['保留了旧状态机', '补上回归测试'],
      nextAction: '由督导请求用户验收。',
      artifacts: [{ path: 'apps/electron/src/renderer/components/tasks/TaskBoardPanel.tsx', note: '任务面板' }],
      verify: { ran: ['bun test TaskBoardPanel.test.tsx'], passed: false, note: '待人工验收。' },
    },
  ],
  budget: { maxSessions: 8, maxRuns: 12, activeMinutes: 37, deadline: null },
  verify: { enabled: true, requirement: '列表和详情在三栏布局下都清楚可读', maxIterations: 3, lastVerdict: 'fail' },
  lifecycle: { errorCount: 2, consecutiveFailures: 1, lastError: '首次截图缺少时间线' },
  createdAt: Date.now() - 60 * 60_000,
  updatedAt: Date.now(),
}

function renderList(tasks: TaskListItem[], selectedId?: string): string {
  return renderToStaticMarkup(createElement(TaskBoardPanel, {
    tasks,
    selectedId,
    onSelect: () => {},
    onCloseDetail: () => {},
  }))
}

function renderDetail(
  task: TaskDetailView,
  agents?: ReadonlyArray<{ id: string; name: string }>,
  onUpdateTrigger?: (id: string, trigger: unknown) => void,
): string {
  return renderToStaticMarkup(createElement(TaskDetailPanelView, {
    detail: task,
    ...(agents ? { agents } : {}),
    onResume: () => {},
    onCancel: () => {},
    ...(onUpdateTrigger ? { onUpdateTrigger } : {}),
  }))
}

function renderNavigatorOverlay(task: TaskDetailView): string {
  return renderToStaticMarkup(createElement(TaskBoardPanel, {
    tasks: [{
      id: task.id,
      name: task.name,
      status: task.status,
      priority: 0,
      updatedAt: task.updatedAt,
      sessionCount: task.sessionIds.length,
      pauseReason: task.pauseReason,
    }],
    detail: task,
    selectedId: task.id,
    onSelect: () => {},
    onCloseDetail: () => {},
  }))
}

describe('task board navigator presentation', () => {
  it('separates active, queued, blocked, and completed lifecycle groups and shows counts', () => {
    const html = renderList([
      runningTask,
      backlogTask,
      pausedTask,
      { ...backlogTask, id: 'T-14', name: '完成项', status: 'completed' },
    ])

    expect(html).toContain('进行中')
    expect(html).toContain('待开始')
    /*
     * The row used to say 「等我拍板」 — wait for *me* to call it — which is the wrong person and
     * disagreed with the group heading drawn directly above it. A pause that asks now says what
     * the group says.
     */
    expect(html).toContain('等你拍板')
    expect(html).not.toContain('等我拍板')
    expect(html).toContain('已结束')
    expect(html).toContain('aria-label="进行中，1 项任务"')
    expect(html).toContain('aria-label="待开始，1 项任务"')
  })

  it('shows useful metadata while keeping selected task text readable', () => {
    const html = renderList([runningTask, backlogTask], runningTask.id)

    expect(html).toContain('T-11')
    expect(html).toContain('会话 2')
    expect(html).toContain('列表布局已完成，正在补充交接时间线。')
    expect(html).toContain('border-l-2')
    expect(html).toContain('bg-accent/10')
    expect(html).toContain('aria-pressed="true"')
  })
})

describe('task detail presentation', () => {
  it('surfaces task metrics, pause details, verification, and the complete handoff timeline', () => {
    const html = renderDetail(detail)

    for (const text of [
      'T-13',
      '确认首页的验收方案，并补齐交接记录。',
      '会话',
      '失败',
      '活跃时间',
      '验收判据',
      '列表和详情在三栏布局下都清楚可读',
      // Paused and waiting for the relay to ask; the card itself appears only then.
      '等问句',
      '督导正在整理要问你的内容',
      '首次截图缺少时间线',
      '完成实现，等待用户确认视觉取舍。',
      '由督导请求用户验收。',
      '保留了旧状态机',
      'bun test TaskBoardPanel.test.tsx',
      '待人工验收。',
      'apps/electron/src/renderer/components/tasks/TaskBoardPanel.tsx',
    ]) {
      expect(html).toContain(text)
    }
    expect(html).not.toContain('关闭')
    expect(html).not.toContain('关闭任务')
  })

  /**
   * The card used to answer every question with yes/no.
   *
   * A real decision offered three answers — 「仅放行 1.2」, 「放行 1.2 + 2」, 「到此为止」 — and the
   * card showed 「同意，继续跑」/「否，取消任务」, neither of which was one of them. What the
   * person meant then had to be inferred from which button they pressed.
   */
  it("renders the asker's own options as buttons, plus 其他 for the rest", () => {
    const html = renderDetail({
      ...detail,
      decision: {
        question: '仅放行 1.2，其余之后再定？',
        options: ['仅放行 1.2', '放行 1.2 + 2', '到此为止（结束任务）'],
      },
    })

    expect(html).toContain('仅放行 1.2')
    expect(html).toContain('放行 1.2 + 2')
    expect(html).toContain('到此为止（结束任务）')
    // Still reachable, and still not a choice: it only opens the box.
    expect(html).toContain('其他（自己输入）')
    // The generic pair must not appear next to real options: two vocabularies for the
    // same question is what made the answer ambiguous in the first place.
    expect(html).not.toContain('同意，继续跑')
  })

  it('offers no buttons before the relay has asked anything', () => {
    const html = renderDetail({ ...detail, decision: {} })

    // The task is paused, but no question exists yet — buttons here would be a card for a
    // decision the person has not been given, and they would disagree with the
    // conversation, which has nothing either.
    expect(html).toContain('督导正在整理要问你的内容')
    expect(html).toContain('暂时不用你操作')
    expect(html).not.toContain('同意，继续跑')
    expect(html).not.toContain('其他（自己输入）')
  })

  /**
   * The card said what the worker did instead of what it was asking.
   *
   * Observed side by side on one decision: the task card read 「完成 T-1 步骤 1.1：创建
   * docs/a.md……本轮仅执行 1.1，未做 1.2 读回确认与 2 收尾」 — a work report, taken from
   * `handoffs.at(-1).summary` — while the conversation asked 「计划中还剩 3 步未授权，是否
   * 继续？」. Only one of those is a question, so only one can be answered.
   */
  it('shows the pending question, not the last work report', () => {
    const html = renderDetail({
      ...detail,
      decision: {
        question: '计划中还剩 3 步未授权（1、1.2、2），是否继续？',
        options: ['放行', '到此为止'],
      },
    })

    // The question is the card body…
    expect(html).toContain('计划中还剩 3 步未授权')
    expect(html).toContain('放行')
    // …and the previous hand-off summary is not sitting where the question goes.
    // Scoped to the decision section: the same sentence may legitimately appear
    // elsewhere on the page (it is also the recorded last error here).
    const start = html.indexOf('task-decision-heading')
    const decisionSection = html.slice(start, html.indexOf('</section>', start))
    expect(decisionSection).not.toContain('首次截图缺少时间线')
  })

  /**
   * A card that was answered kept offering its buttons after a reload.
   *
   * The answer lived in React state only, so restarting the app restored the question
   * and invited the same reply twice. `decision.answer` is the durable record — this pins
   * that the card renders it instead of the buttons.
   */
  it('shows the recorded answer instead of the buttons', () => {
    const html = renderDetail({
      ...detail,
      decision: {
        reason: '计划中还剩 3 步未授权，是否继续？',
        question: '计划中还剩 3 步未授权，是否继续？',
        options: ['放行', '到此为止'],
        answer: { text: '放行，做完整', at: Date.now() },
      },
    })

    expect(html).toContain('已回复：放行，做完整')
    expect(html).not.toContain('其他（自己输入）')
  })

  /**
   * Every option button rendered disabled, while 「其他」 still opened its box.
   *
   * `onAnswer` stopped at the wrapper component and never reached the card, and the
   * buttons gate on `disabled={!onAnswer}` — so they looked present and were dead. The
   * one button without that guard still worked, which is exactly the asymmetry that made
   * it read as "the send button cannot be clicked" rather than "the wiring is missing".
   */
  it('wires the answer callback all the way to the option buttons', () => {
    const answered: string[] = []
    const html = renderToStaticMarkup(
      createElement(TaskDetailPanelView, {
        detail: { ...detail, decision: { question: '是否继续？', options: ['放行', '停止'] } },
        onResume: () => {},
        onCancel: () => {},
        onAnswer: (id, text) => {
          answered.push(`${id}:${text}`)
        },
      }),
    )

    const sendable = html.slice(html.indexOf('task-decision-heading'))
    // No `disabled` on the option buttons means the callback reached them.
    expect(sendable).not.toContain('disabled=""')
    expect(html).toContain('放行')
  })

  /**
   * The task card must mirror the conversation card: same words, same moment.
   *
   * It used to render its own text from the rule that detected the situation, so it showed
   * up at handoff time with a sentence nobody had been asked, and then changed underneath
   * the reader once the relay put the real question in the conversation.
   */
  it('shows no question until the relay has actually asked one', () => {
    const html = renderDetail({ ...detail, decision: { reason: '连续 3 次交接未过', askedAt: 1 } })

    // The task is paused, and that is a fact worth showing…
    expect(html).toContain('等问句')
    // …but there is no question yet, and no buttons for one.
    expect(html).not.toContain('同意，继续跑')
    expect(html).not.toContain('其他（自己输入）')
    expect(html).toContain('督导正在整理要问你的内容')
  })

  it('shows exactly the relayed question and its options once asked', () => {
    const html = renderDetail({
      ...detail,
      decision: { reason: '连续 3 次交接未过', question: '仅放行 1.2，其余之后再定？', options: ['放行', '到此为止'] },
    })

    expect(html).toContain('仅放行 1.2，其余之后再定？')

    // The same buttons the conversation card offers — not a generic approve/cancel pair.
    expect(html).toContain('放行')
    expect(html).not.toContain('同意，继续跑')
    // The rule's diagnosis stays visible beneath it; it explains why a person is asked.
    expect(html).toContain('连续 3 次交接未过')
  })

  it('keeps the generic pause banner for a non-decision pause', () => {
    const html = renderDetail({ ...detail, pauseReason: 'failures' })

    expect(html).toContain('暂停原因')
    expect(html).not.toContain('等你拍板')
  })

  it('shows a clear empty state when a task has no handoffs', () => {
    const html = renderDetail({ ...detail, handoffs: [] })

    expect(html).toContain('还没有交接记录')
    expect(html).toContain('工蜂提交进展后，会显示在这里。')
  })

  it('keeps the navigator overlay close control while the content detail has none', () => {
    expect(renderNavigatorOverlay(detail)).toContain('>关闭</button>')
    expect(renderDetail(detail)).not.toContain('>关闭</button>')
  })

  it('only renders resume and cancel actions for paused tasks', () => {
    const paused = renderDetail(detail)
    const running = renderDetail({ ...detail, status: 'running', pauseReason: null })

    expect(paused).toContain('继续')
    expect(paused).toContain('取消任务')
    expect(running).not.toContain('取消任务')
    expect(running).not.toContain('>继续<')
  })

  it('omits optional handoff sections when no optional data exists', () => {
    const minimal = renderDetail({
      ...detail,
      status: 'running',
      pauseReason: null,
      handoffs: [{
        at: Date.now(),
        fromSessionId: 'session-coral',
        outcome: 'handoff',
        summary: '继续处理其余内容。',
      }],
      verify: { enabled: false, maxIterations: 2 },
      lifecycle: { errorCount: 0, consecutiveFailures: 0 },
    })

    expect(minimal).toContain('继续处理其余内容。')
    expect(minimal).not.toContain('验收判据')
    expect(minimal).not.toContain('下一步')
    expect(minimal).not.toContain('关键发现')
    expect(minimal).not.toContain('产物')
    expect(minimal).not.toContain('验证命令')
    expect(minimal).not.toContain('暂停原因')
    expect(minimal).not.toContain('最近错误')
  })
})

  /**
   * Every sub-step says who does it — read off the record, never inferred.
   *
   * The screenshot that reported this showed 「执行计划」 with two bare titles and no owner. That
   * plan had no `agent` on any step, because `task_create` wrote it in one piece and skipped the
   * rule `applyPlanPatch` enforces. The rule is now enforced on every write path, so a name is
   * present whenever one was chosen — and when it is missing, the row says nothing on purpose: a
   * fallback to the task's assignee made a legacy plan look assigned and hid the fact that nobody
   * had decided who does what.
   */
  it('names the owner each step records, and shows nothing when none was recorded', () => {
    const owned = renderDetail(
      {
        ...detail,
        spec: {
          plan: [
            { id: '1', title: '创建 docs/a.md', status: 'doing' },
            { id: '1.1', title: '写入文件', status: 'done', agent: 'agent-qa' },
          ],
        },
      },
      [
        { id: 'builtin-default', name: '默认' },
        { id: 'agent-qa', name: '校验员' },
      ],
    )
    expect(owned).toContain('校验员')

    // A plan written before the rule: the gap stays visible instead of being filled with 「默认」.
    const legacy = renderDetail(
      {
        ...detail,
        spec: { plan: [{ id: '1', title: '创建 docs/a.md', status: 'doing' }, { id: '1.1', title: '写入文件', status: 'done' }] },
      },
      [
        { id: 'builtin-default', name: '默认' },
        { id: 'agent-qa', name: '校验员' },
      ],
    )
    expect(legacy).not.toContain('校验员')
    expect(legacy).not.toContain('— 默认')
  })

  /**
   * The question comes before the plan.
   *
   * When a task is waiting for an answer, that answer is the only thing on the page a person can
   * act on. It used to sit below the instruction, the plan, the contract and four metric cards —
   * everything already decided — so the reader had to scroll to find the one thing that needed
   * them.
   */
  it('puts the pending question above the plan', () => {
    const html = renderDetail({
      ...detail,
      pauseReason: 'needs_decision',
      decision: { reason: '计划还有 1 步没做完', question: '仅放行 1.2，其余之后再定？' },
      spec: {
        plan: [
          { id: '1', title: '写文件', status: 'doing' },
          { id: '1.1', title: '创建 docs/a.md', status: 'done', agent: 'agent-qa' },
        ],
      },
    })

    // The open card keeps its own heading now: the answered one moved below the plan and the two
    // no longer share an anchor.
    const question = html.indexOf('task-open-question-heading')
    const plan = html.indexOf('task-plan-heading')

    expect(question).toBeGreaterThan(-1)
    expect(plan).toBeGreaterThan(-1)
    expect(question).toBeLessThan(plan)
  })

  it('puts 「等问句」 above the plan too', () => {
    // Same place, because it is the same question in a different state — moving only the answered
    // card would make the page jump when the words arrive.
    const html = renderDetail({ ...detail, pauseReason: 'asking' })

    expect(html.indexOf('等问句')).toBeLessThan(html.indexOf('task-plan-heading'))
  })

/**
 * A schedule the page shows and cannot change is a schedule edited in files.
 *
 * `updateTaskTrigger` existed with zero callers: 「定时 · 0 9 * * *」 rendered as plain text, so the
 * only way to move a task's schedule was to edit its JSON. The entry point is what this pins — the
 * editor's own fields are covered by rendering, which is all a static-markup test can see.
 */
describe('the trigger is editable from the page', () => {
  const scheduled: TaskDetailView = {
    ...detail,
    trigger: { kind: 'cron', expr: '0 9 * * *', timezone: 'Asia/Shanghai', enabled: true },
  }

  it('renders the trigger as an interactive entry when a handler is provided', () => {
    const html = renderDetail(scheduled, undefined, () => {})
    expect(html).toContain('触发方式')
    expect(html).toContain('aria-expanded')
  })

  it('names the pause a hand-off leaves behind', () => {
    // A paused task with work left and no owner must not fall through to the raw enum.
    const html = renderDetail({ ...detail, status: 'paused', pauseReason: 'awaiting_dispatch' })
    expect(html).toContain('等待派活')
    expect(html).not.toContain('awaiting_dispatch')
  })


  it('says which round the timeline is about', () => {
    // The array holds the round in progress, so the panel can name it. Before this the timeline of a
    // per-minute task was every round at once and 「这一轮做到哪」 had no answer.
    const html = renderDetail({
      ...detail,
      handoffs: [{ ...detail.handoffs[0]!, round: 7 }],
    })
    expect(html).toContain('第 7 轮')
  })

  it('says nothing about rounds when the record has none', () => {
    // A one-off task never repeats; labelling it 「第 1 轮」 would invent a concept it does not have.
    const html = renderDetail(detail)
    expect(html).not.toContain('第 1 轮')
  })

  it('does not print a bare expression next to the words that already say it', () => {
    // Live: the meta line read 「每分钟（`* * * * *`）」 — backticks, because this label is a plain-text
    // `<span>` and never goes through Markdown. Dropping the backticks only traded one artefact for
    // another (「每分钟（* * * * *）」), so a recognised schedule now prints as words alone.
    const html = renderDetail({ ...detail, trigger: { kind: 'cron', expr: '* * * * *', timezone: 'Asia/Shanghai', enabled: true } })
    expect(html).toContain('每分钟')
    expect(html).not.toContain('* * * * *')
    expect(html).not.toContain('`')
  })

  it('says the cadence in words before the expression', () => {
    // `* * * * *` is complete but reads like a value nobody filled in, so the label says what it means
    // and the expression follows for anyone who wants it exactly. A near-miss cadence keeps its own
    // words out of it — `describeCron` returns the expression when it does not recognise the shape.
    const everyMinute = renderDetail({ ...detail, trigger: { kind: 'cron', expr: '* * * * *', timezone: 'Asia/Shanghai', enabled: true } })
    expect(everyMinute).toContain('每分钟')

    // A shape the describer does not know keeps its expression: the words are missing, so the
    // expression is the only thing that can tell one schedule from another.
    const weekdays = renderDetail({ ...detail, trigger: { kind: 'cron', expr: '0 9 * * 1-5', timezone: 'Asia/Shanghai', enabled: true } })
    expect(weekdays).toContain('0 9 * * 1-5')
    expect(weekdays).not.toContain('每分钟')
  })

  it('says so when the schedule is switched off', () => {
    // A stopped timer must not look like a running one: 「定时 · 0 9 * * *」 with no marker reads as
    // "this will fire at nine", and the task would sit waiting for a run that never comes.
    const html = renderDetail(
      { ...scheduled, trigger: { ...scheduled.trigger!, enabled: false } },
      undefined,
      () => {},
    )
    expect(html).toContain('已停用')
  })

  it('renders it as plain text when nobody can save a change', () => {
    // No handler means no affordance: a button that cannot write is worse than a label.
    const html = renderDetail(scheduled)
    expect(html).toContain('触发方式')
    expect(html).not.toContain('aria-expanded')
  })
})

describe('acceptance verdict follows the plan (C2′)', () => {
  const planTask = (
    plan: Array<{ id: string; title: string; status: 'todo' | 'doing' | 'done' | 'blocked'; agent?: string; note?: string }>,
    lastVerdict?: 'pass' | 'fail',
  ): TaskDetailView => ({
    ...detail,
    spec: { plan },
    verify: { ...detail.verify, lastVerdict },
  })

  it('shows 待终态判定 while the plan has open steps, whatever an old verdict said', () => {
    const html = renderDetail(planTask([
      { id: '1', title: '写草稿', status: 'done' },
      { id: '2', title: '定稿', status: 'todo' },
    ], 'pass'))

    expect(html).toContain('待终态判定')
    expect(html).toContain('任务完成后统一验收')
    // 切片级命令验证仍会显示「验证未通过」（交接时间线），但验收 label 本身不出现通过/未通过。
    expect(html).not.toContain('>通过</')
    expect(html).not.toContain('>未通过</')
  })

  it('shows 通过 once the plan is complete and the verdict passed', () => {
    const html = renderDetail(planTask([
      { id: '1', title: '写草稿', status: 'done' },
      { id: '2', title: '定稿', status: 'done' },
    ], 'pass'))

    expect(html).toContain('>通过</')
    expect(html).toContain('迭代上限 3')
    expect(html).not.toContain('待终态判定')
  })

  it('shows 未通过 once the plan is complete and the verdict failed', () => {
    const html = renderDetail(planTask([
      { id: '1', title: '写草稿', status: 'done' },
      { id: '2', title: '定稿', status: 'done' },
    ], 'fail'))

    expect(html).toContain('>未通过</')
    expect(html).not.toContain('待终态判定')
  })

  it('keeps the plain labels for a task without a plan', () => {
    const html = renderDetail({ ...detail, verify: { ...detail.verify, lastVerdict: 'fail' } })

    expect(html).toContain('>未通过</')
    expect(html).not.toContain('待终态判定')
  })
})

describe('a pause is labelled by what stopped it', () => {
  /*
   * The badge read 「等我拍板」 for every pause, so a task fused after three failed rounds told the
   * reader to decide something while the panel three lines down said 「连续失败」. Only two reasons
   * actually ask a person anything.
   */
  const pausing = (pauseReason: string): TaskDetailView => ({ ...detail, pauseReason })

  it('says the asking wording only when something is actually being asked', () => {
    const deciding = renderDetail(pausing('needs_decision'))
    expect(deciding).toContain('等你拍板')

    const asking = renderDetail(pausing('asking'))
    expect(asking).toContain('等问句')
  })

  it('does not claim to be waiting on the reader when nothing is being asked', () => {
    for (const reason of ['failures', 'budget', 'process_lost', 'verify_exhausted', 'awaiting_dispatch', 'awaiting_release']) {
      const html = renderDetail(pausing(reason))
      expect(html).not.toContain('等我拍板')
      expect(html).not.toContain('等你拍板')
      expect(html).toContain('已暂停')
    }
  })

  it('names the real reason next to the badge instead of contradicting it', () => {
    const html = renderDetail(pausing('failures'))
    // Both statements come from the same pause and must agree: the badge is generic, the panel is specific.
    expect(html).toContain('已暂停')
    expect(html).toContain('连续失败')
    expect(html).not.toContain('等我拍板')
  })

  it('falls back to the plain word when a pause has no reason at all', () => {
    const html = renderDetail({ ...detail, pauseReason: undefined })
    expect(html).toContain('已暂停')
  })

  it('leaves the other statuses alone', () => {
    const running = renderDetail({ ...detail, status: 'running', pauseReason: undefined })
    expect(running).toContain('进行中')

    const completed = renderDetail({ ...detail, status: 'completed', pauseReason: undefined })
    expect(completed).toContain('已完成')
  })
})

describe('the task page lists the conversations it opened', () => {
  /*
   * 「本轮会话 3 / 8」 says how many without saying which. Finding one meant leaving the page and
   * searching a flat list where every row starts with the same task id.
   */
  const withSessions = (sessions: TaskDetailView['sessions']): TaskDetailView => ({ ...detail, sessions })

  it('labels each row by what the conversation did', () => {
    const html = renderDetail(withSessions([
      { id: 's-work', name: 'T-1 摸底', purpose: 'execute', archived: false },
      { id: 's-verify', name: 'T-1 验收', purpose: 'verify', archived: false },
      { id: 's-pick', name: 'T-1 2 分工', purpose: 'section', archived: true },
    ]))

    expect(html).toContain('worker')
    expect(html).toContain('验收')
    expect(html).toContain('分工')
    expect(html).toContain('T-1 摸底')
    expect(html).toContain('T-1 验收')
  })

  it('shows a retired conversation as archived rather than hiding it', () => {
    const html = renderDetail(withSessions([
      { id: 's-old', name: 'T-1 旧会话', purpose: 'execute', archived: true },
    ]))

    // Still listed — it happened, and the transcript is still readable — but marked.
    expect(html).toContain('T-1 旧会话')
    expect(html).toContain('已归档')
  })

  it('has no section at all when the task never opened a session', () => {
    const html = renderDetail({ ...detail, sessions: [] })

    expect(html).not.toContain('task-sessions-heading')
  })
})

describe('a question carries the moment it was asked', () => {
  /*
   * A task can sit paused for hours behind a fuse or a spent budget, and 「这个问句是什么时候的」 is
   * what tells the reader whether the situation it describes is still the current one.
   */
  const asked = (askedAt: number): TaskDetailView => ({
    ...detail,
    pauseReason: 'needs_decision',
    decisions: [{ id: 'd-1', askedAt, question: '这件事还要继续吗？', label: '需要你决定', category: 'direction' }],
  })

  it('shows the clock for a question asked today', () => {
    const today = new Date()
    today.setHours(14, 20, 0, 0)
    const html = renderDetail(asked(today.getTime()))

    // Same-day questions show the time alone — the date is noise for this afternoon.
    expect(html).toContain('14:20')
  })

  it('shows the date too once the question is older than today', () => {
    const older = new Date()
    older.setDate(older.getDate() - 2)
    older.setHours(9, 5, 0, 0)
    const html = renderDetail(asked(older.getTime()))

    // 「09:05」 on its own would read as today to someone looking at a task paused since Tuesday.
    const month = String(older.getMonth() + 1).padStart(2, '0')
    const day = String(older.getDate()).padStart(2, '0')
    expect(html).toContain(`${month}/${day}`)
    expect(html).toContain('09:05')
  })

  it('puts the full moment in the tooltip', () => {
    const at = new Date()
    at.setHours(11, 30, 0, 0)
    const html = renderDetail(asked(at.getTime()))

    expect(html).toContain(String(at.getFullYear()))
  })
})

describe('answered questions fold away, open ones never do', () => {
  /*
   * A task that asked six questions pushed its plan and verdicts off the screen to show answers
   * there was nothing left to act on. Folding is only right when nothing is owed — a card asking for
   * a decision must never be collapsed away from the person who has to make it.
   */
  const answered: TaskDetailView = {
    ...detail,
    pauseReason: null,
    decisions: [
      { id: 'd-1', askedAt: Date.now() - 60_000, question: '第一问回答什么？', resolvedAt: Date.now() - 30_000, answer: { text: '就这样', at: Date.now() - 30_000 } },
    ],
  }

  const stillAsking: TaskDetailView = {
    ...detail,
    pauseReason: 'needs_decision',
    decisions: [
      { id: 'd-2', askedAt: Date.now(), question: '还没答的问题？' },
      ...(answered.decisions ?? []),
    ],
  }

  it('starts folded once everything has been answered', () => {
    const html = renderDetail(answered)

    expect(html).toContain('已答复')
    // The body is present but hidden — the record stays on the page, just out of the way.
    expect(html).toMatch(/id="task-answered-body" hidden/)
    expect(html).toMatch(/aria-expanded="false"/)
  })

  it('shows the open question even though the answered card is folded', () => {
    /**
     * The two are separate sections now, so a fold in one cannot hide the other. The open card is
     * what the reader has to act on; the answered card being closed is the normal state, not a
     * signal that nothing is owed.
     */
    const html = renderDetail(stillAsking)

    expect(html).toContain('等你拍板')
    expect(html).toContain('还没答的问题？')
    // The answered card is present and folded; the open one is not folded.
    expect(html).toMatch(/id="task-answered-body" hidden/)
    expect(html).toMatch(/id="task-open-question-body"(?! hidden)/)
  })

  it('offers the fold as a button with a chevron, not a separate control', () => {
    const html = renderDetail(answered)

    // The heading is the control: a 「展开」 button beside a heading that already names the thing
    // would be two controls for one action.
    expect(html).toContain('aria-controls="task-answered-body"')
  })
})

describe('the two question cards read in the order a person can act', () => {
  /*
   * What is still being asked sits above the plan; what was decided sits below it. The page is
   * ordered by what the reader can do: the question needs them, the plan says what is happening, the
   * answered cards are the record of how it got here.
   */
  const both: TaskDetailView = {
    ...detail,
    pauseReason: 'needs_decision',
    spec: { plan: [{ id: '1', title: '写文件', status: 'doing' }] },
    decisions: [
      { id: 'd-open', askedAt: Date.now(), question: '还没答的问题？' },
      { id: 'd-closed', askedAt: Date.now() - 60_000, question: '已经答过的问题？', resolvedAt: Date.now() - 30_000, answer: { text: '好', at: Date.now() - 30_000 } },
    ],
  }

  it('puts the open card above the plan and the answered card below it', () => {
    const html = renderDetail(both)
    const open = html.indexOf('task-open-question-heading')
    const plan = html.indexOf('task-plan-heading')
    const answered = html.indexOf('task-answered-heading')

    expect(open).toBeGreaterThan(-1)
    expect(plan).toBeGreaterThan(-1)
    expect(answered).toBeGreaterThan(-1)
    expect(open).toBeLessThan(plan)
    expect(plan).toBeLessThan(answered)
  })

  it('never shows the same question in both cards', () => {
    const html = renderDetail(both)

    // The open one belongs to the open card alone, the closed one to the answered card alone.
    expect(html.split('还没答的问题？').length - 1).toBe(1)
    expect(html.split('已经答过的问题？').length - 1).toBe(1)
  })

  it('opens the question card by default and folds the answered one', () => {
    const html = renderDetail(both)

    // The card asking for a decision must be visible without a click.
    expect(html).toMatch(/id="task-open-question-body"(?! hidden)/)
    expect(html).toMatch(/id="task-answered-body" hidden/)
  })
})
