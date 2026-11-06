import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  deriveThreadKey,
  bindThread,
  findThreadOwner,
  loadThreadBindings,
  unbindThread,
  staleThreadBindings,
  THREAD_BINDING_TTL_MS,
} from './thread-bindings.ts'

/**
 * Why these exist: subscriptions match a class of event ("anything from qq"), so
 * every follow-up message in the same conversation used to re-enter the
 * supervisor. Each one cost a model turn, and supervisor turns are capped, which
 * is how a busy channel turned into "start, get killed, re-queue".
 *
 * A thread binding is the record that stops that. These cases pin its identity
 * rules, because getting the key wrong means either no dedupe (every message
 * re-triages) or over-dedupe (unrelated conversations share an owner).
 */

describe('deriveThreadKey', () => {
  it('drops the message id and keeps the conversation', () => {
    expect(deriveThreadKey([{ url: 'message://qq/group:123/msg-1' }])).toBe('message://qq/group:123')
    expect(deriveThreadKey([{ url: 'message://qq/group:123/msg-2' }])).toBe('message://qq/group:123')
  })

  it('treats two messages in one channel as the same thread', () => {
    const a = deriveThreadKey([{ url: 'message://telegram/user:9/aaa' }])
    const b = deriveThreadKey([{ url: 'message://telegram/user:9/bbb' }])
    expect(a).toBe(b)
  })

  it('keeps different channels apart', () => {
    const group = deriveThreadKey([{ url: 'message://qq/group:1/x' }])
    const user = deriveThreadKey([{ url: 'message://qq/user:1/x' }])
    expect(group).not.toBe(user)
  })

  it('keeps different platforms apart', () => {
    const qq = deriveThreadKey([{ url: 'message://qq/group:1/x' }])
    const tg = deriveThreadKey([{ url: 'message://telegram/group:1/x' }])
    expect(qq).not.toBe(tg)
  })

  it('handles a link with no message id', () => {
    expect(deriveThreadKey([{ url: 'message://qq/group:1' }])).toBe('message://qq/group:1')
  })

  it('ignores non-message links', () => {
    // A webhook has no conversation. Inventing one would bind unrelated events
    // to whichever session happened to be last.
    expect(deriveThreadKey([{ url: 'https://example.com/issue/1' }])).toBeUndefined()
    expect(deriveThreadKey([])).toBeUndefined()
    expect(deriveThreadKey(undefined)).toBeUndefined()
  })

  it('rejects a malformed link instead of inventing a key', () => {
    expect(deriveThreadKey([{ url: 'message://' }])).toBeUndefined()
    expect(deriveThreadKey([{ url: 'message://qq' }])).toBeUndefined()
    expect(deriveThreadKey([{ url: 'message://qq/' }])).toBeUndefined()
  })
})

describe('thread bindings store', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'thread-bindings-'))
    mkdirSync(join(root, 'config'), { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('returns nothing when no file exists', () => {
    expect(loadThreadBindings(root)).toEqual([])
    expect(findThreadOwner(root, 'message://qq/group:1')).toBeUndefined()
  })

  it('binds and finds an owner', () => {
    bindThread(root, { threadKey: 'message://qq/group:1', sessionId: 's1' })
    expect(findThreadOwner(root, 'message://qq/group:1')?.sessionId).toBe('s1')
  })

  it('replaces the owner rather than keeping two responders', () => {
    bindThread(root, { threadKey: 'message://qq/group:1', sessionId: 's1' })
    bindThread(root, { threadKey: 'message://qq/group:1', sessionId: 's2' })
    const all = loadThreadBindings(root)
    expect(all).toHaveLength(1)
    expect(all[0]!.sessionId).toBe('s2')
  })

  it('keeps a task id when given', () => {
    bindThread(root, { threadKey: 'message://qq/group:1', sessionId: 's1', taskId: 'T-1' })
    expect(findThreadOwner(root, 'message://qq/group:1')?.taskId).toBe('T-1')
  })

  it('expires a stale binding', () => {
    const longAgo = Date.now() - THREAD_BINDING_TTL_MS - 1000
    bindThread(root, { threadKey: 'message://qq/group:1', sessionId: 's1' }, longAgo)
    expect(findThreadOwner(root, 'message://qq/group:1')).toBeUndefined()
  })

  it('unbinds', () => {
    bindThread(root, { threadKey: 'message://qq/group:1', sessionId: 's1' })
    unbindThread(root, 'message://qq/group:1')
    expect(findThreadOwner(root, 'message://qq/group:1')).toBeUndefined()
  })

  it('survives a corrupt file by reporting no bindings', () => {
    // Falling back to the supervisor is the pre-existing behaviour; throwing
    // here would take the ingest path down instead.
    writeFileSync(join(root, 'config', 'thread-bindings.json'), '{not json', 'utf-8')
    expect(loadThreadBindings(root)).toEqual([])
  })

  it('reports bindings whose session is gone', () => {
    bindThread(root, { threadKey: 'message://qq/a', sessionId: 'alive' })
    bindThread(root, { threadKey: 'message://qq/b', sessionId: 'dead' })
    const stale = staleThreadBindings(loadThreadBindings(root), (id) => id === 'alive')
    expect(stale.map((entry) => entry.sessionId)).toEqual(['dead'])
  })
})
