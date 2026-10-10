import { describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'
import { AbortReason } from '../core/session-lifecycle.ts'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/craft-agent-test',
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/craft-agent-test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
  }
}

describe('PiAgent subprocess error handling', () => {
  it('maps raw HTML subprocess errors to typed proxy_error events', () => {
    const agent = new PiAgent(createConfig())

    const enqueued: any[] = []
    ;(agent as any).eventQueue.enqueue = (event: any) => {
      enqueued.push(event)
    }

    ;(agent as any).handleLine(JSON.stringify({
      type: 'error',
      message: '<html><head><title>400 Bad Request</title></head><body><center><h1>400 Bad Request</h1></center><hr><center>cloudflare</center></body></html>',
    }))

    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].type).toBe('typed_error')
    expect(enqueued[0].error.code).toBe('proxy_error')
    expect(enqueued[0].error.message.toLowerCase()).not.toContain('<html')

    agent.destroy()
  })

  it('does not enqueue chat errors for mini_completion_error messages', () => {
    const agent = new PiAgent(createConfig())

    const enqueued: any[] = []
    ;(agent as any).eventQueue.enqueue = (event: any) => {
      enqueued.push(event)
    }

    let rejectedMessage = ''
    ;(agent as any).pendingMiniCompletions.set('mini-1', {
      resolve: () => {},
      reject: (error: Error) => {
        rejectedMessage = error.message
      },
    })

    ;(agent as any).handleLine(JSON.stringify({
      type: 'error',
      code: 'mini_completion_error',
      message: '<html><head><title>400 Bad Request</title></head><body><center><h1>400 Bad Request</h1></center><hr><center>cloudflare</center></body></html>',
    }))

    expect(enqueued).toHaveLength(0)
    expect((agent as any).pendingMiniCompletions.size).toBe(0)
    expect(rejectedMessage).toContain('400 Bad Request')

    agent.destroy()
  })

  it('suppresses only identical consecutive subprocess errors', () => {
    const agent = new PiAgent(createConfig())

    const enqueued: any[] = []
    ;(agent as any).eventQueue.enqueue = (event: any) => {
      enqueued.push(event)
    }

    for (let i = 0; i < 4; i++) {
      ;(agent as any).handleLine(JSON.stringify({
        type: 'error',
        message: 'EFAULT: broken pipe',
      }))
    }

    expect(enqueued).toHaveLength(3)
    expect(enqueued.every((event) => event.type === 'error' || event.type === 'typed_error')).toBe(true)

    agent.destroy()
  })

  it('resets repeated subprocess error suppression after non-error traffic', () => {
    const agent = new PiAgent(createConfig())

    const enqueued: any[] = []
    ;(agent as any).eventQueue.enqueue = (event: any) => {
      enqueued.push(event)
    }

    for (let i = 0; i < 3; i++) {
      ;(agent as any).handleLine(JSON.stringify({
        type: 'error',
        message: 'EFAULT: broken pipe',
      }))
    }

    ;(agent as any).handleLine(JSON.stringify({
      type: 'event',
      event: { type: 'agent_message_delta', delta: 'ok' },
    }))

    ;(agent as any).handleLine(JSON.stringify({
      type: 'error',
      message: 'EFAULT: broken pipe',
    }))

    expect(enqueued.filter((event) => event.type === 'error' || event.type === 'typed_error')).toHaveLength(4)

    agent.destroy()
  })

  it('defaults the turn-idle watchdog to 300s when no env override is set', () => {
    const agent = new PiAgent(createConfig())
    const prev = process.env.CRAFT_PI_TURN_IDLE_TIMEOUT_MS
    delete process.env.CRAFT_PI_TURN_IDLE_TIMEOUT_MS
    try {
      // 2026-10-05: raised from 120s to 300s so a silent hang (no bytes, no
      // error) can ride the Pi subprocess's 120s http-idle timeout plus at
      // least one agent-retry backoff cycle before the watchdog fires.
      expect((agent as any).getTurnIdleTimeoutMs()).toBe(300_000)
    } finally {
      if (prev !== undefined) process.env.CRAFT_PI_TURN_IDLE_TIMEOUT_MS = prev
      agent.destroy()
    }
  })

  it('unblocks the chat queue when the Pi stream goes idle after a tool finishes', async () => {
    const previousTimeout = process.env.CRAFT_PI_TURN_IDLE_TIMEOUT_MS
    process.env.CRAFT_PI_TURN_IDLE_TIMEOUT_MS = '10'

    const agent = new PiAgent(createConfig())
    const queue = (agent as any).eventQueue
    const drained: any[] = []
    const drainPromise = (async () => {
      for await (const event of queue.drain()) {
        drained.push(event)
      }
    })()

    try {
      ;(agent as any)._isProcessing = true
      ;(agent as any).adapter.startTurn()

      ;(agent as any).handleSubprocessEvent({
        type: 'tool_execution_start',
        toolName: 'Grep',
        toolCallId: 'tool-1',
        args: {},
      })
      ;(agent as any).handleSubprocessEvent({
        type: 'tool_execution_end',
        toolName: 'Grep',
        toolCallId: 'tool-1',
        result: 'done',
        isError: false,
      })

      await Promise.race([
        drainPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('event queue did not unblock')), 200)),
      ])

      expect(drained.some(event => event.type === 'error' && event.message.includes('stream stalled'))).toBe(true)
      expect(drained.at(-1)?.type).toBe('complete')
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.CRAFT_PI_TURN_IDLE_TIMEOUT_MS
      } else {
        process.env.CRAFT_PI_TURN_IDLE_TIMEOUT_MS = previousTimeout
      }
      agent.destroy()
    }
  })

  it('hands a stall to the retry ladder when the subprocess is alive (no terminal complete)', async () => {
    const previousTimeout = process.env.CRAFT_PI_TURN_IDLE_TIMEOUT_MS
    const previousRungs = process.env.CRAFT_PI_RETRY_RUNGS_MS
    process.env.CRAFT_PI_TURN_IDLE_TIMEOUT_MS = '10'
    process.env.CRAFT_PI_RETRY_RUNGS_MS = '60000' // keep fireRetry from firing during the test

    // Isolate persisted retry-ladder state: a prior run (or a sibling test)
    // may have written one for this fixed session id, and the constructor
    // RESTORES it — a restored active ladder makes the stall watchdog
    // early-return without scheduling a timer, silently changing what this
    // test exercises.
    const cfg = createConfig()
    const ladderStatePath = join(cfg.workspace.rootPath, 'sessions', cfg.session!.id, 'data', 'retry-ladder-state.json')
    rmSync(ladderStatePath, { force: true })
    const agent = new PiAgent(cfg)
    const enqueued: any[] = []
    const queue = (agent as any).eventQueue
    queue.enqueue = (event: any) => { enqueued.push(event) }
    // Stub a live subprocess so tryBeginRetryLadder can take over.
    ;(agent as any).subprocess = { stdin: { writable: true, write() { /* no-op */ } }, kill() { /* no-op */ } }

    try {
      ;(agent as any)._isProcessing = true
      ;(agent as any).adapter.startTurn()

      ;(agent as any).handleSubprocessEvent({
        type: 'tool_execution_start',
        toolName: 'Grep',
        toolCallId: 'tool-1',
        args: {},
      })
      ;(agent as any).handleSubprocessEvent({
        type: 'tool_execution_end',
        toolName: 'Grep',
        toolCallId: 'tool-1',
        result: 'done',
        isError: false,
      })

      // Let the 10ms watchdog fire.
      await new Promise((resolve) => setTimeout(resolve, 60))

      // 2026-10-07: a stall is a transient fault class — the ladder owns the
      // turn (background retry) instead of surfacing a terminal error.
      expect(enqueued.some((e) => e.type === 'retry' && e.phase === 'backoff')).toBe(true)
      expect(enqueued.some((e) => e.type === 'error' && e.message.includes('stream stalled'))).toBe(false)
      expect(enqueued.some((e) => e.type === 'complete')).toBe(false)
      expect((agent as any).retryLadder.isActive).toBe(true)
      expect((agent as any).retryLadder.errorClass).toBe('transient')
    } finally {
      if (previousTimeout === undefined) delete process.env.CRAFT_PI_TURN_IDLE_TIMEOUT_MS
      else process.env.CRAFT_PI_TURN_IDLE_TIMEOUT_MS = previousTimeout
      if (previousRungs === undefined) delete process.env.CRAFT_PI_RETRY_RUNGS_MS
      else process.env.CRAFT_PI_RETRY_RUNGS_MS = previousRungs
      agent.destroy()
      rmSync(ladderStatePath, { force: true })
    }
  })

  it('completes the turn on spontaneous stream recovery during backoff (no redundant retry command)', async () => {
    const previousTimeout = process.env.CRAFT_PI_TURN_IDLE_TIMEOUT_MS
    const previousRungs = process.env.CRAFT_PI_RETRY_RUNGS_MS
    process.env.CRAFT_PI_TURN_IDLE_TIMEOUT_MS = '10'
    process.env.CRAFT_PI_RETRY_RUNGS_MS = '60000' // keep fireRetry from firing during the test

    const cfg = createConfig()
    const ladderStatePath = join(cfg.workspace.rootPath, 'sessions', cfg.session!.id, 'data', 'retry-ladder-state.json')
    rmSync(ladderStatePath, { force: true })
    const agent = new PiAgent(cfg)
    const enqueued: any[] = []
    let queueCompleted = false
    const queue = (agent as any).eventQueue
    queue.enqueue = (event: any) => { enqueued.push(event) }
    queue.complete = () => { queueCompleted = true }
    const sent: any[] = []
    ;(agent as any).subprocess = {
      stdin: {
        writable: true,
        write(line: string) { sent.push(JSON.parse(line)) },
      },
      kill() { /* no-op */ },
    }

    try {
      ;(agent as any)._isProcessing = true
      ;(agent as any).adapter.startTurn()

      // Stall → watchdog arms the ladder with a pending backoff timer.
      ;(agent as any).handleSubprocessEvent({ type: 'tool_execution_start', toolName: 'Grep', toolCallId: 't1', args: {} })
      ;(agent as any).handleSubprocessEvent({ type: 'tool_execution_end', toolName: 'Grep', toolCallId: 't1', result: 'done', isError: false })
      await new Promise((r) => setTimeout(r, 60))
      expect((agent as any).retryLadder.isActive).toBe(true)
      expect((agent as any).retryTimer != null).toBe(true)

      // The stream spontaneously recovers BEFORE any retry command was sent.
      ;(agent as any).handleSubprocessEvent({ type: 'message_start' })
      expect((agent as any).retryTimer).toBeNull() // pending retry canceled
      expect((agent as any).retryRunLive).toBe(true)

      // The recovered run ends naturally → the queue must complete now, not
      // wait for user input to trigger redirect/fireRetry.
      ;(agent as any).handleSubprocessEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } })
      ;(agent as any).handleSubprocessEvent({ type: 'agent_end', messages: [] })

      const retryEnd = enqueued.find((e) => e.type === 'retry' && e.phase === 'end')
      expect(retryEnd?.recovered).toBe(true)
      expect(queueCompleted).toBe(true)
      expect(sent.some((c) => c.type === 'retry')).toBe(false) // no redundant retry re-issued
    } finally {
      if (previousTimeout === undefined) delete process.env.CRAFT_PI_TURN_IDLE_TIMEOUT_MS
      else process.env.CRAFT_PI_TURN_IDLE_TIMEOUT_MS = previousTimeout
      if (previousRungs === undefined) delete process.env.CRAFT_PI_RETRY_RUNGS_MS
      else process.env.CRAFT_PI_RETRY_RUNGS_MS = previousRungs
      agent.destroy()
      rmSync(ladderStatePath, { force: true })
    }
  })
})

describe('PiAgent verification delivery lifecycle', () => {
  function startVerificationHold(agent: PiAgent, enqueued: any[]) {
    ;(agent as any).eventQueue.enqueue = (event: any) => { enqueued.push(event) }
    ;(agent as any).eventQueue.complete = () => { enqueued.push({ type: 'queue_complete' }) }
    ;(agent as any).adapter.startTurn()
    ;(agent as any).handleSubprocessEvent({ type: 'turn_start' })
    ;(agent as any).handleSubprocessEvent({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'stop', content: 'Candidate reply' },
    })
    ;(agent as any).handleSubprocessEvent({ type: 'agent_end', defenseVerificationPending: true })
  }

  it('re-emits the verified reply as text_complete on the held draft turn', () => {
    const agent = new PiAgent(createConfig())
    const enqueued: any[] = []
    startVerificationHold(agent, enqueued)
    const draftTurnId = enqueued[0].turnId

    ;(agent as any).handleLine(JSON.stringify({
      type: 'verification_result',
      passed: true,
      finalText: 'Candidate reply',
    }))
    ;(agent as any).handleSubprocessEvent({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'stop', content: 'Candidate reply' },
    })

    const finalText = enqueued.find(event => event.type === 'text_complete' && event.text === 'Candidate reply' && event !== enqueued[0])
    expect(finalText?.turnId).toBe(draftTurnId)
    expect(finalText?.isIntermediate).not.toBe(true)
    agent.destroy()
  })

  it('ends the verification card before returning to the follow-up conversation on failure', () => {
    const agent = new PiAgent(createConfig())
    const enqueued: any[] = []
    startVerificationHold(agent, enqueued)

    ;(agent as any).handleLine(JSON.stringify({
      type: 'verification_result',
      passed: false,
      failReason: 'candidate did not answer the user',
    }))

    expect(enqueued.map(event => event.statusType ?? event.type)).toEqual([
      'text_complete',
      'text_demote',
      'verification',
      'verification_failed',
    ])
    expect(enqueued[3].message).toContain('Verification failed')
    expect(enqueued).not.toContainEqual({ type: 'queue_complete' })
    agent.destroy()
  })

  it('finishes verification before delivering the verified reply and completing the turn', () => {
    const agent = new PiAgent(createConfig())
    const enqueued: any[] = []
    startVerificationHold(agent, enqueued)

    ;(agent as any).handleLine(JSON.stringify({
      type: 'verification_result',
      passed: true,
      finalText: 'Verified answer',
    }))

    expect(enqueued.map(event => event.statusType ?? event.type)).toEqual([
      'text_complete',
      'text_demote',
      'verification',
      'verification_passed',
      'text_complete',
      'complete',
      'queue_complete',
    ])
    expect(enqueued[4]).toMatchObject({ type: 'text_complete', text: 'Verified answer' })
    expect(enqueued[4].turnId).toBe(enqueued[0].turnId)
    agent.destroy()
  })

  it('skipped (judge unavailable) fails open: delivers the captured reply and completes the turn', () => {
    const agent = new PiAgent(createConfig())
    const enqueued: any[] = []
    startVerificationHold(agent, enqueued)

    ;(agent as any).handleLine(JSON.stringify({
      type: 'verification_result',
      passed: true,
      finalText: 'Captured reply',
      skipped: true,
      skipReason: 'judge-unavailable',
    }))

    // Same lifecycle as a pass (replay + complete) — only the info wording differs.
    expect(enqueued.map(event => event.statusType ?? event.type)).toEqual([
      'text_complete',
      'text_demote',
      'verification',
      'verification_passed',
      'text_complete',
      'complete',
      'queue_complete',
    ])
    expect(enqueued[3].message).toContain('Verification skipped')
    expect(enqueued[4]).toMatchObject({ type: 'text_complete', text: 'Captured reply' })
    expect(enqueued[4].turnId).toBe(enqueued[0].turnId)
    agent.destroy()
  })
})

describe('PiAgent recovery state on abort', () => {
  it('forceAbort clears a held auto-retry so the next turn starts clean', () => {
    const agent = new PiAgent(createConfig())
    const adapter = (agent as any).adapter

    // Transient error + agent_end { willRetry: true } → adapter holds the turn open.
    ;[...adapter.adaptEvent({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'error', errorMessage: 'fetch failed' },
    })]
    ;[...adapter.adaptEvent({ type: 'agent_end', messages: [], willRetry: true })]
    expect(adapter.isHoldingTurn).toBe(true)
    expect(adapter.shouldCompleteQueue(true)).toBe(false)

    // The SDK cancels the backoff on abort and emits no further agent_end, so
    // the hold must be dropped here or the next turn's queue never completes.
    agent.forceAbort(AbortReason.UserStop)

    expect(adapter.isHoldingTurn).toBe(false)
    expect(adapter.shouldCompleteQueue(true)).toBe(true)

    agent.destroy()
  })
})

describe('PiAgent retry-ladder settlement (2026-10-08)', () => {
  it('treats a delivered reply as recovery even without model-progress events (retryDeliveredReply)', () => {
    // Regression: providers that emit consolidated `message`/text events (not
    // message_start/update) never set retryRunLive. A succeeded retry was
    // settled as `failed` because finishRetryLadder only checked retryRunLive
    // while its caller already accepted retryDeliveredReply as recovery.
    const agent = new PiAgent(createConfig())
    const enqueued: any[] = []
    ;(agent as any).eventQueue.enqueue = (event: any) => void enqueued.push(event)
    ;(agent as any).eventQueue.complete = () => {}
    // Real ladder API: one failure recorded (first retry failed), ladder active.
    const ladder = (agent as any).retryLadder
    ladder.begin('transient', { message: 'model request failed', parsedError: null })
    ladder.onFailure({ message: 'model request failed', parsedError: null })
    ;(agent as any).retryRunLive = false         // no message_start/update/tool_start seen
    ;(agent as any).retryDeliveredReply = true   // but a real text_complete landed
    ;(agent as any).retryRunHadError = false
    ;(agent as any).retryErrorSurfaced = false

    ;(agent as any).finishRetryLadder()

    const end = enqueued.find((e: any) => e.type === 'retry' && e.phase === 'end')
    expect(end).toBeDefined()
    expect(end.recovered).toBe(true)
    expect(end.attempt).toBe(2) // recovered count includes the successful retry
    expect(enqueued.some((e: any) => e.type === 'error' || e.type === 'typed_error')).toBe(false)
    agent.destroy()
  })

  it('settles as failed when neither recovery signal fired (stale completed ladder)', () => {
    const agent = new PiAgent(createConfig())
    const enqueued: any[] = []
    ;(agent as any).eventQueue.enqueue = (event: any) => void enqueued.push(event)
    ;(agent as any).eventQueue.complete = () => {}
    // Real ladder API: one failed retry recorded, ladder active.
    const ladder = (agent as any).retryLadder
    ladder.begin('transient', { message: 'model request failed', parsedError: null })
    ladder.onFailure({ message: 'model request failed', parsedError: null })
    ;(agent as any).retryRunLive = false
    ;(agent as any).retryDeliveredReply = false
    ;(agent as any).retryRunHadError = false
    ;(agent as any).retryErrorSurfaced = false

    ;(agent as any).finishRetryLadder()

    const end = enqueued.find((e: any) => e.type === 'retry' && e.phase === 'end')
    expect(end).toBeDefined()
    expect(end.recovered).toBe(false)
    expect(end.attempt).toBe(1)
    // Staged error is surfaced terminally when it was never shown before.
    expect(enqueued.some((e: any) => e.type === 'error' || e.type === 'typed_error')).toBe(true)
    agent.destroy()
  })
})

describe('PiAgent retried-run stall governance (2026-10-09)', () => {
  it('advances the ladder when a retried run goes silent past the stall cap', () => {
    const agent = new PiAgent(createConfig())
    const enqueued: any[] = []
    ;(agent as any).eventQueue.enqueue = (event: any) => void enqueued.push(event)
    ;(agent as any).eventQueue.complete = () => {}
    const ladder = (agent as any).retryLadder
    ladder.begin('transient', { message: 'first failure', parsedError: null })
    ;(agent as any).retryResendAt = Date.now() - 700_000 // older than DEFAULT_RETRY_RUN_STALL_MS (600s)

    ;(agent as any).failStalledRetryRun()

    // The attempt was recorded and the ladder advanced: a backoff for the NEXT
    // retry was scheduled (the UI row updates instead of freezing "重试中").
    expect(ladder.attemptCount).toBeGreaterThanOrEqual(1)
    const backoff = enqueued.find((e: any) => e.type === 'retry' && e.phase === 'backoff')
    expect(backoff).toBeDefined()
    expect(backoff.attempt).toBe(ladder.attemptCount + 1)
    expect(backoff.nextRetryInMs).toBeGreaterThan(0)
    agent.destroy()
  })

  it('subprocess exit settles an active ladder with a terminal failed end (row + reason card)', () => {
    const agent = new PiAgent(createConfig())
    const enqueued: any[] = []
    ;(agent as any).eventQueue.enqueue = (event: any) => void enqueued.push(event)
    ;(agent as any).eventQueue.complete = () => {}
    ;(agent as any)._isProcessing = true
    const ladder = (agent as any).retryLadder
    ladder.begin('deterministic', { message: 'model request failed', parsedError: null })
    ladder.onFailure({ message: 'attempt 1 failed', parsedError: null })

    ;(agent as any).handleSubprocessExit(1, null)

    const end = enqueued.find((e: any) => e.type === 'retry' && e.phase === 'end')
    expect(end).toBeDefined()
    expect(end.recovered).toBe(false)
    expect(end.attempt).toBe(1)
    expect(typeof end.startedAt).toBe('number')
    expect(end.elapsedMs).toBeGreaterThanOrEqual(0)
    // The crash reason follows as the error card.
    expect(enqueued.some((e: any) => e.type === 'error')).toBe(true)
    agent.destroy()
  })
})
