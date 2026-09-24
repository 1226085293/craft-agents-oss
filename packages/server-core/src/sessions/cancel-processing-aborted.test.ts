/**
 * `cancelProcessing` records the abort on the in-flight assistant message.
 *
 * A silent mid-stream redirect writes no "Response interrupted" info message,
 * so the `aborted` flag on the message is the only durable signal that the turn
 * was abandoned. Without it the turn grouper's "promote the last intermediate
 * text to a response" rescue fires and hands the user unfinished commentary as
 * the answer. The flag has to reach disk, because turn grouping is recomputed
 * from the message list on every render — including after a reload.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getSessionFilePath } from '@craft-agent/shared/sessions/storage'
import { loadSession } from '@craft-agent/shared/sessions'
import { storedToMessage } from '@craft-agent/core'
import { SessionManager, createManagedSession } from './SessionManager.ts'

describe('cancelProcessing marks the aborted message', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-cancel-abort-'))
    sm = new SessionManager()
  })

  afterEach(async () => {
    await sm.flushAllSessions()
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildSession(id: string, messages: any[] = []) {
    const workspace = { id: 'ws_test', name: 'Test', rootPath: tmpRoot, createdAt: Date.now() }
    const managed = createManagedSession(
      { id, name: 'cancel test' },
      workspace as never,
      { messagesLoaded: true },
    )
    managed.isProcessing = true
    managed.agent = { forceAbort: () => undefined } as never
    managed.messages = messages
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  function readPersisted(sessionId: string): Array<Record<string, any>> {
    const path = getSessionFilePath(tmpRoot, sessionId)
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf-8').trim().split('\n').slice(1).map(l => JSON.parse(l))
  }

  it('flags the in-flight intermediate message', async () => {
    const sessionId = 'cancel-inflight'
    const managed = buildSession(sessionId, [
      { id: 'u1', role: 'user', content: 'do the thing', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'let me look', isIntermediate: true, timestamp: 2 },
    ])

    await sm.cancelProcessing(sessionId, /* silent */ true)

    const flagged = managed.messages.filter(m => m.aborted)
    expect(flagged.map(m => m.id)).toEqual(['a1'])
  })

  it('persists the flag so a reload keeps the decision', async () => {
    const sessionId = 'cancel-persisted'
    buildSession(sessionId, [
      { id: 'u1', role: 'user', content: 'do the thing', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'let me look', isIntermediate: true, timestamp: 2 },
    ])

    await sm.cancelProcessing(sessionId, /* silent */ true)
    await sm.flushAllSessions()

    const persisted = readPersisted(sessionId)
    expect(persisted.find(m => m.id === 'a1')?.aborted).toBe(true)
  })

  it('flags on an explicit Stop too, not just silent redirects', async () => {
    const sessionId = 'cancel-explicit-stop'
    const managed = buildSession(sessionId, [
      { id: 'u1', role: 'user', content: 'do the thing', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'let me look', isIntermediate: true, timestamp: 2 },
    ])

    await sm.cancelProcessing(sessionId, /* silent */ false)

    expect(managed.messages.find(m => m.id === 'a1')?.aborted).toBe(true)
  })

  it('leaves a delivered final response unmarked', async () => {
    const sessionId = 'cancel-final-already-landed'
    const managed = buildSession(sessionId, [
      { id: 'u1', role: 'user', content: 'do the thing', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'here is the answer', isIntermediate: false, timestamp: 2 },
    ])

    await sm.cancelProcessing(sessionId, /* silent */ true)

    // A final is a real result. Marking it would misreport a delivered answer.
    expect(managed.messages.find(m => m.id === 'a1')?.aborted).toBeUndefined()
  })

  it('flags a pending streaming message', async () => {
    const sessionId = 'cancel-pending'
    const managed = buildSession(sessionId, [
      { id: 'u1', role: 'user', content: 'do the thing', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'partial', isPending: true, timestamp: 2 },
    ])

    await sm.cancelProcessing(sessionId, /* silent */ true)

    expect(managed.messages.find(m => m.id === 'a1')?.aborted).toBe(true)
  })

  it('survives a reload — the flag round-trips through persistence', async () => {
    // Turn grouping is a pure function of the message list, recomputed on every
    // render. If the flag were dropped on load, a reloaded session would start
    // promoting the aborted turn's commentary again — a bug that only shows up
    // after restarting the app.
    const sessionId = 'cancel-reload'
    buildSession(sessionId, [
      { id: 'u1', role: 'user', content: 'do the thing', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'let me look', isIntermediate: true, timestamp: 2 },
    ])

    await sm.cancelProcessing(sessionId, /* silent */ true)
    await sm.flushAllSessions()

    const reloaded = loadSession(tmpRoot, sessionId)!
    const assistant = reloaded.messages
      .map(storedToMessage)
      .find(m => m.id === 'a1')
    expect(assistant?.aborted).toBe(true)
  })

  it('flags only the last assistant message', async () => {
    const sessionId = 'cancel-only-last'
    const managed = buildSession(sessionId, [
      { id: 'u1', role: 'user', content: 'first', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'earlier commentary', isIntermediate: true, timestamp: 2 },
      { id: 'u2', role: 'user', content: 'second', timestamp: 3 },
      { id: 'a2', role: 'assistant', content: 'latest commentary', isIntermediate: true, timestamp: 4 },
    ])

    await sm.cancelProcessing(sessionId, /* silent */ true)

    expect(managed.messages.find(m => m.id === 'a1')?.aborted).toBeUndefined()
    expect(managed.messages.find(m => m.id === 'a2')?.aborted).toBe(true)
  })
})
