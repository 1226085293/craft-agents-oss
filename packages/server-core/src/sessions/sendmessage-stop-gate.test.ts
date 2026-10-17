import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager, createManagedSession } from './SessionManager.ts'

/**
 * 2026-10-16 261016-deft-tide: the user sent a message and stopped ~1.2 s
 * later — while sendMessage was still in its preparation phase (MCP source
 * probing / OAuth refresh / agent creation). cancelProcessing latched
 * stopRequested, but sendMessage went on to call agent.chat() anyway. The
 * subprocess executed the turn and its tool blocks landed below the
 * "Response interrupted" marker.
 *
 * The gate in sendMessage must refuse to start the turn when a stop was
 * requested during preparation, and settle the session as interrupted.
 */

describe('sendMessage refuses to start a stopped turn', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-stop-gate-'))
    sm = new SessionManager()
  })

  afterEach(async () => {
    await sm.flushAllSessions()
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildSession(id: string) {
    const workspace = {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id, name: 'stop gate test' },
      workspace as never,
      { messagesLoaded: true },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  function makeAgent(prompts: string[], opts: { failChat?: boolean } = {}) {
    return {
      supportsBranching: true,
      isProcessing: () => false,
      updateRuntimeConfig: async () => true,
      setAllSources: () => undefined,
      setSourceServers: async () => undefined,
      getSummarizeCallback: () => undefined,
      getModel: () => 'test-model',
      getSessionId: () => 'sdk-stop-gate',
      chat: async function* (_message: string) {
        prompts.push('chat-called')
        if (opts.failChat) {
          yield { type: 'error', message: 'unexpected turn' }
        }
        yield { type: 'text_complete', text: 'reply', isIntermediate: false }
        yield { type: 'complete' }
      },
      redirect: () => false,
      forceAbort: () => undefined,
      dispose: () => undefined,
    }
  }

  function ack() {
    return () => { /* ack */ }
  }

  it('skips agent.chat() and settles as interrupted when stopRequested is latched', async () => {
    const sessionId = 'stopped-during-prep'
    const managed = buildSession(sessionId)
    const prompts: string[] = []
    managed.agent = makeAgent(prompts) as never

    // Simulate cancelProcessing having run during the preparation phase:
    // the user already saw "Response interrupted".
    managed.stopRequested = true

    await sm
      .sendMessage(sessionId, 'do the thing', undefined, undefined, undefined, undefined, undefined, ack())
      .catch(() => { /* post-ack failures ok */ })

    // The turn must never have started.
    expect(prompts).toHaveLength(0)
    // The gate settled the session through the interrupted cleanup path.
    expect(managed.stopRequested).toBe(false)
    expect(managed.isProcessing).toBe(false)
  })

  it('the next message after the skip runs normally (stopRequested is reset)', async () => {
    const sessionId = 'stopped-then-resumed'
    const managed = buildSession(sessionId)
    const prompts: string[] = []
    managed.agent = makeAgent(prompts) as never
    managed.stopRequested = true

    await sm
      .sendMessage(sessionId, 'cancelled', undefined, undefined, undefined, undefined, undefined, ack())
      .catch(() => { /* post-ack failures ok */ })
    expect(prompts).toHaveLength(0)

    await sm
      .sendMessage(sessionId, 'hello again', undefined, undefined, undefined, undefined, undefined, ack())
      .catch(() => { /* post-ack failures ok */ })

    expect(prompts).toHaveLength(1)
    expect(managed.isProcessing).toBe(false)
  })
})
