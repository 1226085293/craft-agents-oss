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

function renderDetail(task: TaskDetailView): string {
  return renderToStaticMarkup(createElement(TaskDetailPanelView, {
    detail: task,
    onResume: () => {},
    onCancel: () => {},
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
    expect(html).toContain('等我拍板')
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
      '暂停原因',
      '等待督导把问题转达给你',
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
    expect(html).toContain('等待督导把问题转达给你')
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
    expect(html).toContain('暂停原因')
    // …but there is no question yet, and no buttons for one.
    expect(html).not.toContain('同意，继续跑')
    expect(html).not.toContain('其他（自己输入）')
    expect(html).toContain('等待督导把问题转达给你')
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
