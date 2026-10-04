import { afterEach, describe, expect, it } from 'bun:test'
import { MemoryConsolidationScheduler } from '../scheduler'

describe('MemoryConsolidationScheduler', () => {
  let scheduler: MemoryConsolidationScheduler | undefined
  afterEach(() => scheduler?.stop())

  it('runs at the configured minute and never overlaps an active pass', async () => {
    let release: (() => void) | undefined
    let calls = 0
    scheduler = new MemoryConsolidationScheduler({ enabled: true, cron: '* * * * *' }, async () => {
      calls++
      await new Promise<void>(resolve => { release = resolve })
    })
    const firstRun = scheduler.tick(new Date('2026-10-04T00:10:00.000Z'))
    await Promise.resolve()
    await scheduler.tick(new Date('2026-10-04T00:10:30.000Z'))
    expect(calls).toBe(1)
    release?.()
    await expect(firstRun).resolves.toBe(true)
  })
})
