import { describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'
import { AbortReason } from '../core/session-lifecycle.ts'

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
