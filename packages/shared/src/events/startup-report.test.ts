import { describe, it, expect } from 'bun:test'
import { buildStartupReport } from './startup-report.ts'

/**
 * The wording has one job: let a user tell "waiting for me" from "broken" from
 * "I turned it off" without opening a detail page.
 */

const base = { enabled: true, ready: true }

describe('buildStartupReport', () => {
  it('counts a running plugin and says nothing about it', () => {
    const report = buildStartupReport([{ ...base, id: 'tg', status: { state: 'running' } }])
    expect(report.running).toBe(1)
    expect(report.reasons).toEqual([])
    expect(report.summary).toBe('1 个运行中')
  })

  it('marks a plugin waiting on configuration, naming the keys', () => {
    const report = buildStartupReport([
      { id: 'tg', name: 'Telegram', ...base, missingConfig: ['token'] },
    ])
    expect(report.waiting).toBe(1)
    expect(report.reasons[0]).toEqual({ id: 'tg', label: 'Telegram', reason: '等待配置：token' })
  })

  it('marks unsatisfied dependencies separately from configuration', () => {
    const report = buildStartupReport([
      {
        id: 'wa',
        name: 'WhatsApp',
        ...base,
        dependencies: [{ label: 'Node 20+', state: 'missing' }],
      },
    ])
    expect(report.reasons[0]!.reason).toBe('依赖未满足：Node 20+')
  })

  it('reports a failed start with its reason, and does not hide it as waiting', () => {
    const report = buildStartupReport([
      { id: 'qq', name: 'QQ', ...base, status: { state: 'failed', lastError: 'token invalid' } },
    ])
    expect(report.failed).toBe(1)
    expect(report.waiting).toBe(0)
    expect(report.reasons[0]!.reason).toBe('启动失败：token invalid')
  })

  it('stays silent about a plugin the user switched off', () => {
    const report = buildStartupReport([
      { id: 'lark', name: 'Lark', enabled: false, ready: true, missingConfig: ['appId'] },
    ])
    expect(report.reasons).toEqual([])
    expect(report.summary).toBe('没有启用的插件')
  })

  it('says a ready-but-idle plugin is not started yet, without calling it broken', () => {
    const report = buildStartupReport([{ id: 'x', ...base }])
    expect(report.failed).toBe(0)
    expect(report.reasons[0]!.reason).toBe('尚未启动')
  })

  it('summarises the whole set in one sentence', () => {
    const report = buildStartupReport([
      { id: 'a', name: 'A', ...base, status: { state: 'running' } },
      { id: 'b', name: 'B', ...base, missingConfig: ['token'] },
      { id: 'c', name: 'C', ...base, status: { state: 'failed', lastError: 'boom' } },
    ])
    expect(report.summary).toBe(
      '1 个运行中，1 个等待中，1 个启动失败｜B：等待配置：token；C：启动失败：boom',
    )
  })
})
