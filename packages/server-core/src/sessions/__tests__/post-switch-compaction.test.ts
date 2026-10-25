import { describe, expect, it } from 'bun:test'

import {
  schedulePostSwitchCompaction,
  type PostSwitchCompactEvent,
  type PostSwitchCompactSession,
} from '../post-switch-compaction'

function makeSession(overrides: Partial<PostSwitchCompactSession> = {}): PostSwitchCompactSession {
  return {
    workspace: { id: 'ws-1' },
    agent: {
      isProcessing: () => false,
      compact: async () => ({
        tokensBefore: 1000,
        tokensAfter: 200,
        stats: { before: 1000, retained: 200, compacted: 800, checkpoint: 0, viaRelief: true },
      }),
    },
    ...overrides,
  }
}

function makeDeps(session: PostSwitchCompactSession | undefined) {
  const events: Array<{ event: PostSwitchCompactEvent; workspaceId: string }> = []
  const logs: string[] = []
  return {
    events,
    logs,
    deps: {
      getSession: () => session,
      sendEvent: (event: PostSwitchCompactEvent, workspaceId: string) => events.push({ event, workspaceId }),
      log: (message: string) => logs.push(message),
    },
  }
}

describe('schedulePostSwitchCompaction', () => {
  it('calls the existing compact path once and reports both rows', async () => {
    let compactCalls = 0
    const session = makeSession({
      agent: {
        isProcessing: () => false,
        compact: async () => {
          compactCalls += 1
          return { tokensBefore: 1000, tokensAfter: 200 }
        },
      },
    })
    const { deps, events } = makeDeps(session)
    const running = new Map<string, Promise<void>>()

    schedulePostSwitchCompaction(deps, 's1', 'key', running)
    await running.get('s1')

    expect(compactCalls).toBe(1)
    expect(events.map((e) => e.event.statusType)).toEqual([
      'compaction_complete',
      'compaction_summary',
    ])
    expect(events.every((e) => e.workspaceId === 'ws-1')).toBe(true)
    expect(events[1]!.event.statusParams).toMatchObject({ before: 1000, after: 200, compacted: 800 })
  })

  it('coalesces repeat notifications for the same session', async () => {
    let compactCalls = 0
    const session = makeSession({
      agent: {
        isProcessing: () => false,
        compact: async () => {
          compactCalls += 1
          return { tokensBefore: 10, tokensAfter: 5 }
        },
      },
    })
    const { deps } = makeDeps(session)
    const running = new Map<string, Promise<void>>()

    schedulePostSwitchCompaction(deps, 's1', 'key', running)
    schedulePostSwitchCompaction(deps, 's1', 'model', running)
    await running.get('s1')

    expect(compactCalls).toBe(1)
  })

  it('does nothing when the backend has no compact entry point', async () => {
    const session = makeSession({ agent: { isProcessing: () => false } })
    const { deps, events } = makeDeps(session)
    const running = new Map<string, Promise<void>>()

    schedulePostSwitchCompaction(deps, 's1', 'model', running)
    await running.get('s1')

    expect(events).toHaveLength(0)
  })

  it('logs a failed compaction without throwing', async () => {
    const session = makeSession({
      agent: {
        isProcessing: () => false,
        compact: async () => {
          throw new Error('relief failed')
        },
      },
    })
    const { deps, events, logs } = makeDeps(session)
    const running = new Map<string, Promise<void>>()

    schedulePostSwitchCompaction(deps, 's1', 'both', running)
    await running.get('s1')

    expect(events).toHaveLength(0)
    expect(logs.join('\n')).toContain('relief failed')
  })
})
