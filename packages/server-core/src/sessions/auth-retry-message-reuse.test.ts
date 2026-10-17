import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionManager, createManagedSession } from './SessionManager.ts'
import type { ManagedSession } from './SessionManager.ts'
import type { Message } from '@craft-agent/core/types'

/**
 * 2026-10-14 (session 261014-copper-spruce): the auth-retry path
 * (attemptAuthRetry) used to SPLICE OUT the failed attempt's user message and
 * re-send with a brand-new record stamped at re-send time. The failed
 * turn's process block (retry status row / "Token expired, refreshing…"
 * info line) stayed in the transcript, so on reload it rendered ABOVE the
 * next user bubble — the process block "jumped up" above its own user
 * message ("第一个过程块本来应该在你好下面，但是跑上面去了").
 *
 * Post-fix contract: attemptAuthRetry RE-BORROWS the failed attempt's user
 * record via existingMessageId (original timestamp/position kept, no
 * duplicate). A hidden last-user record is re-borrowed ITSELF (its absence
 * from the visible transcript is unchanged) — an older visible bubble is
 * never re-stamped. No user record at all ⇒ fresh creation.
 */
describe('attemptAuthRetry user-message reuse (copper-spruce)', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-auth-retry-reuse-'))
    sm = new SessionManager()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildSession(id: string): ManagedSession {
    const workspace = {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id, name: 'auth-retry reuse test' },
      workspace as never,
      { messagesLoaded: true },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  function userMsg(id: string, content: string, ts: number, hidden?: boolean): Message {
    return {
      id,
      role: 'user',
      content,
      timestamp: ts,
      ...(hidden ? { hidden: true } : {}),
    } as unknown as Message
  }

  function statusMsg(id: string, ts: number): Message {
    return { id, role: 'status', content: '', timestamp: ts, statusType: 'retrying' } as unknown as Message
  }

  /** Stub the sendMessage entry point and capture its (sessionId, message, …, existingMessageId, _isAuthRetry) args. */
  function captureSendMessage(managed: ManagedSession, sessionId: string) {
    const calls: Array<{ existingMessageId: string | undefined; isAuthRetry: boolean; message: string }> = []
    ;(sm as unknown as { sendMessage: unknown }).sendMessage = async (
      sid: string,
      message: string,
      _attachments: unknown,
      _storedAttachments: unknown,
      _options: unknown,
      existingMessageId: string | undefined,
      isAuthRetry: boolean,
    ) => {
      calls.push({ existingMessageId, isAuthRetry, message })
      // Mirror the tail of attemptAuthRetry's flow: the retry completed.
      managed.authRetryInProgress = false
    }
    void sessionId
    return calls
  }

  /** attemptAuthRetry is private; reach it through a typed escape hatch (binds `this`). */
  function getAuthRetry() {
    return (
      (sm as unknown as {
        attemptAuthRetry(id: string, m: ManagedSession, ws: string, code?: string): boolean
      }).attemptAuthRetry as (id: string, m: ManagedSession, ws: string, code?: string) => boolean
    ).bind(sm as never) as (id: string, m: ManagedSession, ws: string, code?: string) => boolean
  }

  function fireAuthRetry(managed: ManagedSession, sessionId: string): Promise<boolean> {
    const ran = getAuthRetry()(sessionId, managed, 'ws_test', 'invalid_api_key')
    // attemptAuthRetry defers the resend via setImmediate; let it run.
    return new Promise<void>((resolve) => setTimeout(resolve, 25)).then(() => ran)
  }

  it('visible user record is re-borrowed (existingMessageId), not spliced', async () => {
    const managed = buildSession('auth-retry-visible')
    const u1 = userMsg('msg-u1', '你好', 1000)
    const s1 = statusMsg('msg-s1', 1050) // the failed turn's process block
    managed.messages.push(u1, s1)
    managed.lastSentMessage = '你好'
    managed.lastMessageRole = 'error' // terminal error card set it

    const calls = captureSendMessage(managed, 'auth-retry-visible')
    const ran = await fireAuthRetry(managed, 'auth-retry-visible')

    expect(ran).toBe(true)
    expect(calls).toHaveLength(1)
    // The original user record's id is passed so sendMessage re-borrows it
    // (original ts 1000 ⇒ bubble stays under its process block).
    expect(calls[0]!.existingMessageId).toBe('msg-u1')
    expect(calls[0]!.isAuthRetry).toBe(true)
    expect(calls[0]!.message).toBe('你好')
    // Neither the user record NOR the process block was removed.
    expect(managed.messages.map(m => m.id)).toEqual(['msg-u1', 'msg-s1'])
    expect(managed.messages.find(m => m.id === 'msg-u1')!.timestamp).toBe(1000)
    // Re-borrowing a visible record flips the preview role back to user.
    expect((managed as { lastMessageRole?: string }).lastMessageRole).toBe('user')
    // One retry per message — a second fire is refused.
    expect(getAuthRetry()('auth-retry-visible', managed, 'ws_test')).toBe(false)
  })

  it('hidden last-user record is re-borrowed itself, never an older visible bubble', async () => {
    const managed = buildSession('auth-retry-hidden')
    const u1 = userMsg('msg-u1', '你好', 1000)
    const nudge = userMsg('msg-nudge', '[SYSTEM nudge] keep going', 2000, true)
    managed.messages.push(u1, nudge)
    managed.lastSentMessage = '[SYSTEM nudge] keep going'
    managed.lastMessageRole = 'error'

    const calls = captureSendMessage(managed, 'auth-retry-hidden')
    await fireAuthRetry(managed, 'auth-retry-hidden')

    expect(calls).toHaveLength(1)
    // The hidden nudge record is re-borrowed ITSELF — the older visible
    // bubble (msg-u1) must not be re-stamped.
    expect(calls[0]!.existingMessageId).toBe('msg-nudge')
    // Nothing was spliced.
    expect(managed.messages.map(m => m.id)).toEqual(['msg-u1', 'msg-nudge'])
    // Hidden records never flip the preview role back to 'user'.
    expect((managed as { lastMessageRole?: string }).lastMessageRole).toBe('error')
  })

  it('no user records at all — falls back to fresh creation', async () => {
    const managed = buildSession('auth-retry-empty')
    managed.lastSentMessage = '你好'

    const calls = captureSendMessage(managed, 'auth-retry-empty')
    await fireAuthRetry(managed, 'auth-retry-empty')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.existingMessageId).toBeUndefined()
  })
})
