/**
 * 2026-10-22 queued-panel: the pending send queue renders above the composer.
 *
 * Behavior under test:
 *  1. cancelProcessing (user Stop) KEEPS the queue — the stop ends only the
 *     current message; onProcessingStopped drains the next queued message.
 *  2. editQueuedMessage removes the row from the queue + transcript and hands
 *     the payload back for composer rehydration.
 *  3. reorderQueuedMessages applies the dragged order.
 *  4. managedToSession exposes an ordered queuedMessages summary (user rows
 *     only — synthetic recovery rows without messageId stay internal).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SessionManager,
  createManagedSession,
} from './SessionManager.ts'

describe('queued-panel queue semantics', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-queued-panel-'))
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
      { id, name: 'queued panel test' },
      workspace as never,
      { messagesLoaded: true },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  function captureEvents() {
    const events: any[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))
    return events
  }

  it('stop keeps the queued messages and replays the next one after the current turn ends', async () => {
    const sessionId = 'stop-keeps-queue'
    const managed = buildSession(sessionId)
    managed.isProcessing = true
    managed.messages = [
      { id: 'user-1', role: 'user', content: 'first message', timestamp: Date.now() },
    ]
    managed.messageQueue.push(
      { message: 'queued A', messageId: 'queued-a', optimisticMessageId: 'opt-a' },
      { message: 'queued B', messageId: 'queued-b', optimisticMessageId: 'opt-b' },
    )
    managed.messages.push(
      { id: 'queued-a', role: 'user', content: 'queued A', timestamp: Date.now(), isQueued: true },
      { id: 'queued-b', role: 'user', content: 'queued B', timestamp: Date.now(), isQueued: true },
    )

    const events = captureEvents()
    ;(sm as unknown as { persistSession: () => void }).persistSession = () => {}

    // User presses Stop mid-turn.
    await sm.cancelProcessing(sessionId, false)

    // Queue is intact — the stop did NOT wipe it.
    expect(managed.messageQueue.map(q => q.messageId)).toEqual(['queued-a', 'queued-b'])
    // The queued rows stay in the persisted transcript (flagged, grouper skips).
    expect(managed.messages.find(m => m.id === 'queued-a')).toBeTruthy()
    expect(managed.messages.find(m => m.id === 'queued-b')).toBeTruthy()
    // interrupted event carries no queuedMessages payload anymore
    const interrupted = events.filter(e => e.type === 'interrupted')
    expect(interrupted).toHaveLength(1)
    expect(interrupted[0].queuedMessages).toBeUndefined()

    // Turn settles → the queue drains in order.
    const sendMessage = mock(async (_id: string, _message: string) => {})
    ;(sm as unknown as { sendMessage: typeof sendMessage }).sendMessage = sendMessage
    await (sm as unknown as { onProcessingStopped: (id: string, reason: string) => Promise<void> })
      .onProcessingStopped(sessionId, 'interrupted')
    await new Promise<void>(resolve => setImmediate(resolve))

    expect(sendMessage).toHaveBeenCalledTimes(1)
    const replayCall = sendMessage.mock.calls[0]!
    expect(replayCall[1]).toBe('queued A')
    expect(managed.messageQueue.map(q => q.messageId)).toEqual(['queued-b'])
    const drained = events.filter(e => e.type === 'queued_messages_changed')
    expect(drained).toHaveLength(1)
    expect(drained[0].queuedMessages.map((q: any) => q.id)).toEqual(['queued-b'])
  })

  it('editQueuedMessage removes the row and returns its payload', async () => {
    const sessionId = 'edit-queued'
    const managed = buildSession(sessionId)
    managed.messages = [
      { id: 'user-1', role: 'user', content: 'first', timestamp: Date.now() },
      {
        id: 'queued-a',
        role: 'user',
        content: 'queued A',
        timestamp: Date.now(),
        isQueued: true,
        attachments: [{
          id: 'att-1',
          type: 'text',
          name: 'notes.txt',
          mimeType: 'text/plain',
          size: 12,
          storedPath: join(tmpRoot, 'notes.txt'),
        }],
      },
    ]
    managed.messageQueue.push({
      message: 'queued A',
      messageId: 'queued-a',
      optimisticMessageId: 'opt-a',
      storedAttachments: managed.messages[1]!.attachments,
    })

    captureEvents()
    ;(sm as unknown as { persistSession: () => void }).persistSession = () => {}

    const result = await sm.editQueuedMessage(sessionId, 'queued-a')

    expect(result).not.toBeNull()
    expect(result!.text).toBe('queued A')
    expect(result!.attachments).toHaveLength(1)
    expect(result!.attachments![0]!.name).toBe('notes.txt')
    // gone from queue AND transcript
    expect(managed.messageQueue).toHaveLength(0)
    expect(managed.messages.find(m => m.id === 'queued-a')).toBeUndefined()

    // Editing a drained/unknown row is a null result.
    expect(await sm.editQueuedMessage(sessionId, 'queued-a')).toBeNull()
  })

  it('reorderQueuedMessages applies the dragged order', async () => {
    const sessionId = 'reorder-queued'
    const managed = buildSession(sessionId)
    managed.messageQueue.push(
      { message: 'A', messageId: 'a' },
      { message: 'B', messageId: 'b' },
      { message: 'C', messageId: 'c' },
    )

    captureEvents()
    ;(sm as unknown as { persistSession: () => void }).persistSession = () => {}

    await sm.reorderQueuedMessages(sessionId, ['c', 'a', 'b'])

    expect(managed.messageQueue.map(q => q.messageId)).toEqual(['c', 'a', 'b'])
  })

  it('reorder keeps unlisted (synthetic recovery) rows after the listed ones', async () => {
    const sessionId = 'reorder-with-synthetic'
    const managed = buildSession(sessionId)
    managed.messageQueue.push(
      { message: 'A', messageId: 'a' },
      {
        message: 'The previous turn was interrupted by a restart…',
        resumeToolMessageId: 'tool-1',
        resumeToolName: 'Bash',
      },
      { message: 'B', messageId: 'b' },
    )

    captureEvents()
    ;(sm as unknown as { persistSession: () => void }).persistSession = () => {}

    await sm.reorderQueuedMessages(sessionId, ['b', 'a'])

    // The synthetic row has no messageId — it must keep its slot at the end.
    expect(managed.messageQueue.map(q => q.messageId ?? null)).toEqual(['b', 'a', null])
  })

  it('session snapshot exposes user rows only, in queue order', async () => {
    const sessionId = 'snapshot-queued'
    const managed = buildSession(sessionId)
    const ts = Date.now()
    managed.messages = [
      { id: 'user-1', role: 'user', content: 'first', timestamp: ts },
      {
        id: 'queued-a',
        role: 'user',
        content: 'queued A',
        timestamp: ts + 1,
        isQueued: true,
        attachments: [{
          id: 'att-1',
          type: 'image',
          name: 'shot.png',
          mimeType: 'image/png',
          size: 1000,
          storedPath: join(tmpRoot, 'shot.png'),
          thumbnailBase64: 'thumb',
        }],
      },
    ]
    managed.messageQueue.push(
      {
        message: 'The previous turn was interrupted by a restart…',
        resumeToolMessageId: 'tool-1',
        resumeToolName: 'Bash',
      },
      { message: 'queued A', messageId: 'queued-a', optimisticMessageId: 'opt-a' },
    )

    const snapshot = await sm.getSession(sessionId)
    expect(snapshot?.queuedMessages).toHaveLength(1)
    const row = snapshot!.queuedMessages![0]!
    expect(row.id).toBe('queued-a')
    expect(row.message).toBe('queued A')
    expect(row.attachments?.[0]?.name).toBe('shot.png')
  })

  it('keeps the queued flag on the persisted message (reload must not duplicate the panel row)', async () => {
    // 2026-10-22: the turn grouper skips isQueued rows, so the flag is what
    // keeps a queued message out of the transcript after a reload or in a
    // second window. Without it, the message would render twice: once as a
    // plain bubble and once in the composer panel.
    const sessionId = 'persisted-flag'
    const managed = buildSession(sessionId)
    const ts = Date.now()
    managed.messages = [
      { id: 'user-1', role: 'user', content: 'first', timestamp: ts },
    ]

    captureEvents()
    ;(sm as unknown as { persistSession: () => void }).persistSession = () => {}

    // Shape produced by the mid-stream send path: queue row + flagged message.
    managed.messageQueue.push({ message: 'queued A', messageId: 'queued-a' })
    managed.messages.push({
      id: 'queued-a',
      role: 'user',
      content: 'queued A',
      timestamp: ts + 1,
      isQueued: true,
    })

    const snapshot = await sm.getSession(sessionId)
    expect(snapshot!.messages.find(m => m.id === 'queued-a')?.isQueued).toBe(true)
  })
})
