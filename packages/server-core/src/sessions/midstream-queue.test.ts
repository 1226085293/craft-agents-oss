import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SessionManager,
  createManagedSession,
  resolveMidStreamDeliveryOutcome,
} from './SessionManager.ts'

describe('mid-stream queue runtime invariants', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-midstream-'))
    sm = new SessionManager()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildSession(id: string) {
    const workspace = {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id, name: 'mid-stream test' },
      workspace as never,
      { messagesLoaded: true },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  it('distinguishes non-interrupting queue mode from a failed steer', () => {
    expect(resolveMidStreamDeliveryOutcome('queue', false)).toEqual({
      shouldQueue: true,
      wasInterrupted: false,
    })
    expect(resolveMidStreamDeliveryOutcome('steer', false)).toEqual({
      shouldQueue: true,
      wasInterrupted: true,
    })
    expect(resolveMidStreamDeliveryOutcome('steer', true)).toEqual({
      shouldQueue: false,
      wasInterrupted: false,
    })
  })

  it('re-stamps replay after the prior final response and emits that timestamp', async () => {
    const sessionId = 'queue-ordering'
    const managed = buildSession(sessionId)
    const priorFinalTimestamp = Date.now()
    managed.messages = [
      {
        id: 'initial-user',
        role: 'user',
        content: 'question',
        timestamp: priorFinalTimestamp - 200,
      },
      {
        id: 'queued-user',
        role: 'user',
        content: 'follow up',
        timestamp: priorFinalTimestamp - 100,
        isQueued: true,
      },
      {
        id: 'prior-answer',
        role: 'assistant',
        content: 'complete answer',
        timestamp: priorFinalTimestamp,
      },
    ]
    managed.messageQueue.push({
      message: 'follow up',
      messageId: 'queued-user',
      optimisticMessageId: 'optimistic-user',
    })

    const events: any[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))
    ;(sm as unknown as { lastTimestamp: number }).lastTimestamp = priorFinalTimestamp
    ;(sm as unknown as { persistSession: () => void }).persistSession = () => {}
    const sendMessage = mock(async () => {})
    ;(sm as unknown as { sendMessage: typeof sendMessage }).sendMessage = sendMessage

    ;(sm as unknown as { processNextQueuedMessage: (id: string) => void })
      .processNextQueuedMessage(sessionId)
    await new Promise<void>(resolve => setImmediate(resolve))

    const replayed = managed.messages.find(message => message.id === 'queued-user')
    expect(replayed?.isQueued).toBe(false)
    expect(replayed?.timestamp).toBeGreaterThan(priorFinalTimestamp)

    const processingEvent = events.find(event => event.type === 'user_message')
    expect(processingEvent?.status).toBe('processing')
    expect(processingEvent?.message.timestamp).toBe(replayed?.timestamp)
    expect(processingEvent?.optimisticMessageId).toBe('optimistic-user')
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it('restart-recovery replay keeps the original timestamp (2026-09-08 incident)', async () => {
    // Incident: the user spoke mid-turn; the defense resume continued past
    // their message, then the app died. recoverPendingUserTurns re-queued the
    // user message with internalMessage set. Re-stamping its timestamp to the
    // replay time (after the interrupted turn's replayed messages) made
    // groupMessagesByTurn render the pre-restart thinking card ABOVE the
    // user's message — even though the user really spoke first.
    const sessionId = 'recovery-ordering'
    const managed = buildSession(sessionId)
    const originalUserTs = Date.now() - 60_000
    const interruptedTurnTs = originalUserTs + 1_000
    managed.messages = [
      {
        id: 'error-bubble',
        role: 'error',
        content: 'AI Service Unreachable',
        timestamp: originalUserTs - 1_000,
      },
      {
        id: 'recovered-user',
        role: 'user',
        content: '.',
        timestamp: originalUserTs,
        isQueued: true,
      },
      {
        // Replay of the interrupted turn, original timestamps preserved.
        id: 'interrupted-thinking',
        role: 'assistant',
        content: 'thinking card content',
        isIntermediate: true,
        timestamp: interruptedTurnTs,
      },
    ]
    managed.messageQueue.push({
      message: '.',
      internalMessage: 'Continue the previous user request that was interrupted...',
      messageId: 'recovered-user',
      optimisticMessageId: 'optimistic-user',
    })

    const events: any[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))
    ;(sm as unknown as { persistSession: () => void }).persistSession = () => {}
    const sendMessage = mock(async () => {})
    ;(sm as unknown as { sendMessage: typeof sendMessage }).sendMessage = sendMessage

    ;(sm as unknown as { processNextQueuedMessage: (id: string) => void })
      .processNextQueuedMessage(sessionId)
    await new Promise<void>(resolve => setImmediate(resolve))

    const replayed = managed.messages.find(message => message.id === 'recovered-user')
    expect(replayed?.isQueued).toBe(false)
    // Original timestamp preserved → the user message still sorts BEFORE the
    // interrupted turn's replayed messages (thinking card renders below it).
    expect(replayed?.timestamp).toBe(originalUserTs)
    expect(replayed!.timestamp).toBeLessThan(interruptedTurnTs)
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })
})
