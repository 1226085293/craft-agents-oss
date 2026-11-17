/**
 * End-to-end check of thread ownership, through production modules.
 *
 * Real here: the HTTP ingest server (token + loopback + content-type checks), the
 * SQLite event store, the dispatcher with its merge/quota guards, the
 * thread-bindings JSON file, and `bindThreadForEvent` — the exact function the
 * host calls when a session receives an event.
 *
 * Substituted: the "session" that receives a delivery, because a real one lives
 * inside the Electron main process. The stand-in records the delivery and then
 * calls the same binder with the same arguments, so the behaviour under test —
 * who claims a conversation, and what happens to the next message in it — is the
 * production behaviour.
 *
 * The point of going through HTTP instead of calling the store directly: the
 * token, the loopback rule and the envelope validation are part of the path a
 * plugin actually takes, and they have broken before.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { EventService } from './event-service.ts'
import type { DispatchTarget } from './event-dispatcher.ts'
import { bindThreadForEvent, findThreadOwner } from '@craft-agent/shared/events/thread-bindings.ts'
import { saveSubscriptions } from '@craft-agent/shared/events/subscriptions.ts'
import { markChannelPaired } from '@craft-agent/shared/events/pairings.ts'

const dirs: string[] = []
const open: EventService[] = []
afterEach(async () => {
  // Stop first: SQLite keeps the file open, and deleting a database still held
  // fails with EBUSY on Windows.
  for (const service of open.splice(0)) {
    try {
      await service.stop()
    } catch {
      // already stopped by the case
    }
  }
  // Windows releases SQLite's WAL handles slightly after close, so a removal can
  // still hit EBUSY. Failing the case on cleanup would hide the assertions that
  // just passed; the temp dir is disposable either way.
  for (const dir of dirs.splice(0)) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(dir, { recursive: true, force: true })
        break
      } catch {
        await new Promise((r) => setTimeout(r, 40))
      }
    }
  }
})

interface Harness {
  service: EventService
  deliveries: Array<{ sessionId: string; eventId: string }>
  unclaimed: string[]
  workRoot: string
  post: (body: unknown) => Promise<{ status: number; text: string }>
  flush: () => Promise<void>
  bindings: () => Array<{ threadKey: string; sessionId: string; updatedAt?: number }>
}

async function harness(): Promise<Harness> {
  const workRoot = mkdtempSync(join(tmpdir(), 'craft-thread-'))
  dirs.push(workRoot)
  mkdirSync(join(workRoot, 'config'), { recursive: true })

  // A source-wide subscription, because an event with nobody subscribed never
  // reaches a session at all — it falls to triage, where nothing claims it.
  saveSubscriptions(workRoot, [
    { subscriptionId: 'sub-1', sessionId: 'sess_worker', filter: { sources: ['verify'] }, createdAt: 0 },
  ])

  // Channel pairing (host gate): these cases exercise paired chats — the
  // exact keys the pairing gate derives from the links below.
  markChannelPaired(workRoot, 'message://qq/group%3A123')
  markChannelPaired(workRoot, 'message://qq/group%3A999')

  const deliveries: Harness['deliveries'] = []
  const unclaimed: string[] = []

  const target: DispatchTarget = {
    deliver: async (sessionId, params) => {
      deliveries.push({ sessionId, eventId: params.eventId })
      // What a live session does on receipt: claim the conversation.
      bindThreadForEvent({
        workspaceRoot: workRoot,
        dbPath: join(workRoot, 'config', 'events.sqlite'),
        eventId: params.eventId,
        sessionId,
      })
      return true
    },
    isBusy: () => false,
    hasQueuedUserMessage: () => false,
    exists: (id) => id === 'sess_worker',
  }

  const service = new EventService({
    workspaceId: 'ws_thread',
    workspaceRoot: workRoot,
    dispatchTarget: target,
    onUnclaimed: (event) => unclaimed.push(event.id),
  })
  await service.start()
  open.push(service)

  const status = service.status()
  if (!status.listening || !status.port) throw new Error('ingest server did not start')
  const token = service.listenerEnv('verify').CRAFT_EVENTS_TOKEN ?? ''

  return {
    service,
    deliveries,
    unclaimed,
    workRoot,
    post: (body) =>
      fetch(`http://127.0.0.1:${status.port}/events/verify`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          host: `127.0.0.1:${status.port}`,
        },
        body: JSON.stringify(body),
      }).then(async (res) => ({ status: res.status, text: await res.text() })),
    // Delivery passes through a 5s merge window; flush instead of waiting.
    flush: async () => {
      service.flushAllDeferredEvents()
      await new Promise((r) => setTimeout(r, 50))
    },
    bindings: () => {
      const path = join(workRoot, 'config', 'thread-bindings.json')
      if (!existsSync(path)) return []
      return JSON.parse(readFileSync(path, 'utf-8')).bindings ?? []
    },
  }
}

const message = (channel: string, messageId: string, title = '一条消息') => ({
  type: 'message.received',
  title,
  summary: '帮我看看',
  links: [{ rel: 'reply', url: `message://qq/${channel}/${messageId}` }],
})

describe('thread ownership end to end', () => {
  it('accepts an event over HTTP and stores it', async () => {
    const h = await harness()
    const res = await h.post(message('group%3A123', 'msg-001'))
    expect(res.status).toBe(200)
    expect(h.service.list({ limit: 10 })).toHaveLength(1)
  })

  it('claims the conversation when a session receives the event', async () => {
    const h = await harness()
    await h.post(message('group%3A123', 'msg-001'))
    await h.flush()
    expect(h.bindings()).toEqual([
      { threadKey: 'message://qq/group%3A123', sessionId: 'sess_worker', updatedAt: expect.any(Number) },
    ])
  })

  it('sends the next message in that conversation straight to its owner', async () => {
    const h = await harness()
    await h.post(message('group%3A123', 'msg-001'))
    await h.flush()
    const unclaimedBefore = h.unclaimed.length

    await h.post(message('group%3A123', 'msg-002'))
    await h.flush()

    // Still no triage decision, and the second delivery landed on the owner.
    expect(h.unclaimed.length).toBe(unclaimedBefore)
    expect(h.deliveries.filter((d) => d.sessionId === 'sess_worker')).toHaveLength(2)
  })

  it('keeps separate conversations separate', async () => {
    const h = await harness()
    await h.post(message('group%3A123', 'msg-001'))
    await h.flush()
    await h.post(message('group%3A999', 'msg-777'))
    await h.flush()

    const keys = h.bindings().map((b) => b.threadKey).sort()
    expect(keys).toEqual(['message://qq/group%3A123', 'message://qq/group%3A999'])
    expect(findThreadOwner(h.workRoot, 'message://qq/group%3A999')?.sessionId).toBe('sess_worker')
  })

  it('never binds an event that carries no conversation', async () => {
    const h = await harness()
    // A CI webhook has a URL, not a chat. Binding it would weld an unrelated
    // event onto whichever conversation was handled last.
    await h.post({ type: 'build.failed', title: 'CI 失败', links: [{ url: 'https://ci.example/1' }] })
    await h.flush()
    expect(h.bindings()).toEqual([])
  })

  it('rejects a request without the bearer token', async () => {
    const h = await harness()
    const status = h.service.status()
    const res = await fetch(`http://127.0.0.1:${status.port}/events/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message('group%3A123', 'msg-001')),
    })
    expect(res.status).toBe(401)
  })
})
