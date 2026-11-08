import { describe, expect, it } from 'bun:test'
import { formatFrontierLine } from '../brief.ts'
import type { Task } from '../types.ts'

function task(plan: Array<{ id: string; title: string; status: 'todo' | 'doing' | 'done' }>): Task {
  return {
    id: 'T-1',
    name: '状态图标验证',
    instruction: '建立任务',
    status: 'running',
    supervisorSessionId: 's1',
    sessionIds: ['s2'],
    handoffs: [],
    lifecycle: { errorCount: 0, consecutiveFailures: 0 },
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    spec: { scope: 'x', cwd: '/tmp', plan: plan as never },
  } as unknown as Task
}

describe('the brief says what the plan implies', () => {
  it('names the step when there is one to do', () => {
    const line = formatFrontierLine(task([
      { id: '2', title: '收尾', status: 'doing' },
      { id: '2.1', title: '确认文件', status: 'todo' },
    ]))
    expect(line).toContain('2.1')
    expect(line).toContain('确认文件')
  })

  /**
   * The line the worker used to get was a conditional — 「如果计划里没有可执行的小节，先按大纲
   * 展开下一条」 — evaluated against a plan it may not have printed. It skipped the check and
   * started whatever was written.
   */
  it('says a section still needs expanding, and what to decide', () => {
    const line = formatFrontierLine(task([
      { id: '1', title: '写文件', status: 'done' },
      { id: '1.1', title: '创建', status: 'done' },
      { id: '2', title: '收尾', status: 'todo' },
    ]))
    expect(line).toContain('2')
    expect(line).toContain('还没有小节')
    // The three outcomes of the check, all present: the worker has nothing to interpret.
    expect(line).toContain('成立、但小节缺')
    expect(line).toContain('restructure')
    expect(line).toContain('直接开始第一个小节')
  })

  it('does not pretend an unexpanded plan is finished', () => {
    const line = formatFrontierLine(task([
      { id: '1', title: '写文件', status: 'done' },
      { id: '2', title: '收尾', status: 'todo' },
    ]))
    expect(line).not.toContain('全部完成')
  })

  it('says delivered only when the plan really is finished', () => {
    const line = formatFrontierLine(task([
      { id: '1', title: '写文件', status: 'done' },
      { id: '1.1', title: '创建', status: 'done' },
    ]))
    expect(line).toContain('delivered')
  })
})
