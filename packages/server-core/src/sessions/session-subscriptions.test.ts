import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager, createManagedSession } from './SessionManager.ts'

/**
 * Subscription registry: who follows whom is persisted per workspace so a
 * restart keeps the wiring. These pin the contract the tools rely on —
 * idempotency, self/cross-workspace rejection, and the on-disk shape.
 */
describe('session subscriptions', () => {
  let rootA: string
  let rootB: string
  let sm: SessionManager

  beforeEach(() => {
    rootA = mkdtempSync(join(tmpdir(), 'sm-sub-a-'))
    rootB = mkdtempSync(join(tmpdir(), 'sm-sub-b-'))
    sm = new SessionManager()
  })

  afterEach(async () => {
    await sm.flushAllSessions()
    rmSync(rootA, { recursive: true, force: true })
    rmSync(rootB, { recursive: true, force: true })
  })

  function addSession(id: string, rootPath: string) {
    const workspace = { id: `ws-${rootPath}`, name: 'test', rootPath, createdAt: Date.now() }
    const managed = createManagedSession({ id, name: id }, workspace as never, { messagesLoaded: true })
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  const registryPath = (root: string) => join(root, 'config', 'session-subscriptions.json')

  it('subscribes idempotently and persists the mapping', () => {
    addSession('a', rootA)
    addSession('b', rootA)

    const first = sm.subscribeSession('a', 'b')
    const second = sm.subscribeSession('a', 'b')

    expect(first.targetIds).toEqual(['b'])
    expect(second.targetIds).toEqual(['b'])
    expect(sm.listSubscriptions('a')).toEqual(['b'])
    expect(existsSync(registryPath(rootA))).toBe(true)
    expect(JSON.parse(readFileSync(registryPath(rootA), 'utf-8'))).toEqual({ a: ['b'] })
  })

  it('creates and removes the subscription background record', async () => {
    addSession('a', rootA)
    addSession('b', rootA)

    sm.subscribeSession('a', 'b')
    const store = sm.getBackgroundTaskStore('a')
    expect(store).not.toBeNull()
    await store!.load()

    const waitFor = async (predicate: () => boolean, timeoutMs = 2_000) => {
      const started = Date.now()
      while (!predicate() && Date.now() - started < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }

    await waitFor(() => store!.list().some((record) =>
      record.kind === 'subscription' && record.externalId === 'b'))

    const record = store!.list().find((entry) =>
      entry.kind === 'subscription' && entry.externalId === 'b')
    expect(record?.status).toBe('backgrounded')

    sm.unsubscribeSession('a', 'b')
    await waitFor(() => !store!.list().some((entry) =>
      entry.kind === 'subscription' && entry.externalId === 'b'))

    expect(store!.list().some((entry) =>
      entry.kind === 'subscription' && entry.externalId === 'b')).toBe(false)
  })

  it('unsubscribes idempotently and reports whether anything changed', () => {
    addSession('a', rootA)
    addSession('b', rootA)
    sm.subscribeSession('a', 'b')

    expect(sm.unsubscribeSession('a', 'b')).toEqual({ unsubscribed: true, targetIds: [] })
    expect(sm.unsubscribeSession('a', 'b')).toEqual({ unsubscribed: false, targetIds: [] })
    expect(sm.listSubscriptions('a')).toEqual([])
    expect(JSON.parse(readFileSync(registryPath(rootA), 'utf-8'))).toEqual({})
  })

  it('rejects self-subscription and unknown sessions', () => {
    addSession('a', rootA)

    expect(() => sm.subscribeSession('a', 'a')).toThrow(/cannot subscribe to itself/i)
    expect(() => sm.subscribeSession('a', 'missing')).toThrow(/not found/i)
    expect(() => sm.subscribeSession('missing', 'a')).toThrow(/not found/i)
  })

  it('rejects cross-workspace subscriptions', () => {
    addSession('a', rootA)
    addSession('b', rootB)

    expect(() => sm.subscribeSession('a', 'b')).toThrow(/cross-workspace/i)
  })

  it('returns an empty list for an unknown subscriber instead of throwing', () => {
    expect(sm.listSubscriptions('nobody')).toEqual([])
  })

  it('lists the sessions that subscribe to a target', () => {
    addSession('a', rootA)
    addSession('b', rootA)
    addSession('c', rootA)
    sm.subscribeSession('a', 'b')
    sm.subscribeSession('c', 'b')
    sm.subscribeSession('a', 'c')

    expect(sm.listSubscribersOf('b', rootA).sort()).toEqual(['a', 'c'])
    expect(sm.listSubscribersOf('c', rootA)).toEqual(['a'])
    // A session is never its own subscriber, and unknown targets have none.
    expect(sm.listSubscribersOf('a', rootA)).toEqual([])
    expect(sm.listSubscribersOf('nobody', rootA)).toEqual([])
  })
})
