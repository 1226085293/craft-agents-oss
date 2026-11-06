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
      '验收要求',
      '列表和详情在三栏布局下都清楚可读',
      '等你拍板',
      '同意，继续跑',
      '否，取消任务',
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
    expect(minimal).not.toContain('验收要求')
    expect(minimal).not.toContain('下一步')
    expect(minimal).not.toContain('关键发现')
    expect(minimal).not.toContain('产物')
    expect(minimal).not.toContain('验证命令')
    expect(minimal).not.toContain('暂停原因')
    expect(minimal).not.toContain('最近错误')
  })
})
