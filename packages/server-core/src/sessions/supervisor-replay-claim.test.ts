/**
 * B3 启动互斥 — turn-end notice replay keeps its source-startup claim.
 *
 * T-2 incident (2026-11-12 20:14:11): a worker report and a watchdog patrol hit the
 * supervisor session 2ms apart, right after the previous turn ended. Both started a
 * chat; the pi subprocess aborted the first run, its `complete` closed the turn on the
 * parent, and the surviving run's output was lost (session.jsonl stayed empty).
 *
 * Root cause: onProcessingStopped called setProcessing(false) — whose supervisor branch
 * synchronously replays any held notice via sendMessage (which claims
 * `sourceTurnStarting` in its sync prefix) — and THEN reset `sourceTurnStarting = false`,
 * stomping the replay's claim. The next system message in that window saw the flag clear,
 * claimed ownership too, and both passed the busy check: two chats.
 *
 * Fix: the reset now happens INSIDE setProcessing's `was && !processing` branch, BEFORE
 * the held-notice replay can claim. The claim survives, and every concurrent message
 * takes the queue branch (emitting a `queued` user_message event) instead of starting a
 * second chat.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager, createManagedSession } from './SessionManager.ts'

describe('turn-end notice replay keeps its source-startup claim (B3)', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-b3-claim-'))
    sm = new SessionManager()
  })

  afterEach(async () => {
    await sm.flushAllSessions()
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildSession(id: string) {
    const workspace = {
      id: 'ws-b3',
      name: 'B3 Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id, name: 'b3 claim test' },
      workspace as never,
      { messagesLoaded: true },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  function makeAgent(prompts: string[]) {
    return {
      supportsBranching: true,
      isProcessing: () => false,
      updateRuntimeConfig: async () => true,
      setAllSources: () => undefined,
      setSourceServers: async () => undefined,
      getSummarizeCallback: () => undefined,
      getModel: () => 'test-model-b3',
      getSessionId: () => 'sdk-b3',
      async *chat(message: string) {
        prompts.push(message)
        yield { type: 'complete' }
      },
      redirect: () => false,
      forceAbort: () => undefined,
      dispose: () => undefined,
    }
  }

  it('a system message in the turn-end window queues behind the notice replay instead of double-starting', async () => {
    const sessionId = 'b3-replay-claim'
    const managed = buildSession(sessionId)
    managed.role = 'supervisor'
    managed.isProcessing = true

    const events: any[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))

    const prompts: string[] = []
    managed.agent = makeAgent(prompts) as never

    // A notice arrived while the previous turn was still running.
    ;(sm as unknown as {
      supervisorNotices: { hold: (id: string, key: string, text: string) => void }
    }).supervisorNotices.hold(sessionId, 'T-1:failures', 'worker report')

    // Turn ends → setProcessing(false) replays the held notice synchronously.
    // A second system message arrives in the same window (T-2: worker report + watchdog patrol, 2ms apart).
    const done = (
      sm as unknown as { onProcessingStopped: (id: string, reason: string) => Promise<void> }
    ).onProcessingStopped(sessionId, 'complete').catch(() => {})
    const second = sm.sendMessage(sessionId, 'watchdog patrol').catch(() => {})
    await Promise.all([done, second])

    // Let the replay chain settle: notice chats → turn ends → queue drains → queued message chats.
    const deadline = Date.now() + 3000
    while (prompts.length < 2 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    // The second message went through the QUEUE branch — it never started a concurrent chat.
    const patrolEvents = events.filter(
      e => e.type === 'user_message' && e.message?.content === 'watchdog patrol',
    )
    expect(patrolEvents.length).toBeGreaterThan(0)
    // Queue branch emits `queued`; the later replay emits `processing`. A double-start
    // would emit `accepted` instead — that is the regression this test exists for.
    expect(patrolEvents.some(e => e.status === 'queued')).toBe(true)
    expect(patrolEvents.every(e => e.status === 'queued' || e.status === 'processing')).toBe(true)

    // Both messages eventually chatted, sequentially, in arrival order.
    expect(prompts).toEqual(['worker report', 'watchdog patrol'])
  })
})
