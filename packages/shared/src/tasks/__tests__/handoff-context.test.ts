import { describe, expect, it } from 'bun:test'

import { formatHandoffContext, formatResumeBrief } from '../brief.ts'
import type { Task } from '../types.ts'

function task(overrides: Partial<Task> = {}): Task {
  return {
    version: 2,
    id: 'T-1',
    name: '接口改造',
    instruction: '把接口改完',
    status: 'paused',
    priority: 1,
    origin: { supervisorSessionId: 'sup', toolCallId: 'tc' },
    sessionIds: [],
    handoffs: [],
    budget: { maxSessions: 8, maxRuns: 20, activeMinutes: 120 },
    verify: { enabled: false, maxIterations: 3 },
    lifecycle: { errorCount: 0, consecutiveFailures: 0 },
    spec: { plan: [] },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as Task
}

describe('hand-off context', () => {
  it('renders what the next session actually needs', () => {
    const t = task({
      handoffs: [
        {
          at: 10,
          fromSessionId: 'w1',
          outcome: 'handoff',
          summary: '接口改完，handler 已接上',
          keyFindings: ['缓存层未动'],
          nextAction: '补回归用例',
          artifacts: [{ path: 'src/api/handler.ts' }],
        },
      ] as Task['handoffs'],
    })
    const block = formatHandoffContext(t)!
    expect(block).toContain('Previous round')
    expect(block).toContain('缓存层未动')
    expect(block).toContain('Next step: 补回归用例')
    expect(block).toContain('src/api/handler.ts')
  })

  it('says nothing when there is no hand-off to report', () => {
    expect(formatHandoffContext(task())).toBeUndefined()
  })

  it('skips an open question, which is not a result to build on', () => {
    const t = task({
      handoffs: [
        { at: 10, fromSessionId: 'w1', outcome: 'needs_decision', summary: '要你拍板' },
      ] as Task['handoffs'],
    })
    expect(formatHandoffContext(t)).toBeUndefined()
  })

  it('carries the hand-off into a resume, so a compacted thread still knows', () => {
    const t = task({
      handoffs: [
        {
          at: 10,
          fromSessionId: 'w1',
          outcome: 'handoff',
          summary: '接口改完',
          nextAction: '补回归用例',
        },
      ] as Task['handoffs'],
    })
    const brief = formatResumeBrief(t, 'manual')
    expect(brief).toContain('resumed')
    expect(brief).toContain('Previous round')
    expect(brief).toContain('Next step: 补回归用例')
  })
})
