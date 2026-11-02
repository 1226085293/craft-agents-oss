import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSession, getPendingPlanExecution, setPendingPlanExecution } from '@craft-agent/shared/sessions'
import { SessionManager, createManagedSession } from './SessionManager.ts'

/**
 * `/stop` is one executor for every entry point. These tests pin the two things
 * that used to break: a no-op must not report success, and a real stop must
 * leave the same markers the desktop Stop button leaves.
 */
describe('executeSessionCommand /stop', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-stop-command-'))
    sm = new SessionManager()
  })

  afterEach(async () => {
    await sm.flushAllSessions()
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildSession(id: string, messagesLoaded = true) {
    const workspace = {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id, name: 'stop command test' },
      workspace as never,
      { messagesLoaded },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  const stop = { name: 'stop', raw: '/stop' } as const

  it('reports an idle session as not stopped and leaves no interrupted marker', async () => {
    const sessionId = 'idle-stop'
    const managed = buildSession(sessionId)

    const result = await sm.executeSessionCommand(sessionId, stop)

    expect(result).toEqual({ name: 'stop', stopped: false, queueLength: 0 })
    expect(managed.messages.some(m => m.content === 'Response interrupted')).toBe(false)
    expect(managed.stopRequested).toBeFalsy()
  })

  it('cancels a running turn and marks it interrupted', async () => {
    const sessionId = 'busy-stop'
    const managed = buildSession(sessionId)
    managed.isProcessing = true
    managed.messages.push({ id: 'assistant-1', role: 'assistant', content: 'partial answer', timestamp: 1 } as never)
    managed.agent = { forceAbort: () => undefined } as never

    const result = await sm.executeSessionCommand(sessionId, stop)

    expect(result.stopped).toBe(true)
    expect(managed.stopRequested).toBe(true)
    expect(managed.messages.find(m => m.id === 'assistant-1')?.aborted).toBe(true)
    expect(managed.messages.some(m => m.content === 'Response interrupted')).toBe(true)
  })

  it('reports how many queued messages survive the stop', async () => {
    const sessionId = 'queued-stop'
    const managed = buildSession(sessionId)
    managed.isProcessing = true
    managed.agent = { forceAbort: () => undefined } as never
    managed.messageQueue.push({ message: 'next task' } as never)

    const result = await sm.executeSessionCommand(sessionId, stop)

    expect(result.stopped).toBe(true)
    // The queue is deliberately NOT cleared: an explicit stop ends the current
    // turn only, and the receipt must say so instead of implying a full halt.
    expect(result.queueLength).toBe(1)
  })

  it('clears a pending Accept & Compact plan so it cannot auto-execute after a stop', async () => {
    const stored = await createSession(tmpRoot, { name: 'pending plan' })
    await setPendingPlanExecution(tmpRoot, stored.id, '/plans/pending.md')
    buildSession(stored.id)

    await sm.executeSessionCommand(stored.id, stop)

    expect(getPendingPlanExecution(tmpRoot, stored.id)).toBeNull()
  })

  it('loads messages before writing the abort marker', async () => {
    // Writing on a partially loaded array would truncate history on persist.
    const sessionId = 'unloaded-stop'
    const managed = buildSession(sessionId, false)
    managed.isProcessing = true
    managed.agent = { forceAbort: () => undefined } as never

    await sm.executeSessionCommand(sessionId, stop)

    expect(managed.messagesLoaded).toBe(true)
  })
})
