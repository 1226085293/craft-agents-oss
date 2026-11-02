import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackgroundTaskStore } from './background-tasks.ts'

let dir: string
let now: number
const clock = () => now

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bg-store-'))
  now = 1_000_000
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('BackgroundTaskStore', () => {
  it('mode 1 starts running and only becomes backgrounded explicitly', async () => {
    const store = new BackgroundTaskStore(dir, clock)
    const task = await store.create({ sessionId: 's1', kind: 'bash', intent: 'npm test' })

    expect(task.status).toBe('running')
    expect(task.backgroundedAt).toBeUndefined()
    await store.markBackgrounded(task.id)
    expect(store.get(task.id)?.status).toBe('backgrounded')
    expect(store.get(task.id)?.backgroundedAt).toBe(now)
  })

  it('mode 2 starts backgrounded immediately', async () => {
    const store = new BackgroundTaskStore(dir, clock)
    const task = await store.create({ sessionId: 's1', kind: 'bash', backgrounded: true })
    expect(task.status).toBe('backgrounded')
    expect(task.backgroundedAt).toBe(now)
  })

  it('complete is idempotent and keeps the record until delivered', async () => {
    const store = new BackgroundTaskStore(dir, clock)
    const task = await store.create({ sessionId: 's1', kind: 'bash', backgrounded: true })

    now += 5_000
    const done = await store.complete(task.id, { exitCode: 0, tail: 'ok' })
    expect(done.status).toBe('completed_pending')
    expect(done.completedAt).toBe(now)

    const again = await store.complete(task.id, { exitCode: 1 })
    expect(again.status).toBe('completed_pending')
    expect(again.exitCode).toBe(0)
  })

  it('markDelivered deletes the record and persists the deletion', async () => {
    const store = new BackgroundTaskStore(dir, clock)
    const task = await store.create({ sessionId: 's1', kind: 'bash', backgrounded: true })
    await store.complete(task.id)

    expect(await store.markDelivered(task.id, 'msg_1')).toBe(true)
    expect(store.get(task.id)).toBeUndefined()

    const reloaded = new BackgroundTaskStore(dir, clock)
    await reloaded.load()
    expect(reloaded.list()).toHaveLength(0)

    // Idempotent: a duplicate delivered event is a no-op.
    expect(await store.markDelivered(task.id, 'msg_1')).toBe(false)
  })

  it('stop records the source and stays pending until delivered', async () => {
    const store = new BackgroundTaskStore(dir, clock)
    const task = await store.create({ sessionId: 's1', kind: 'bash', backgrounded: true })

    const stopped = await store.stop(task.id, 'user')
    expect(stopped.status).toBe('stopped_pending')
    expect(stopped.stopSource).toBe('user')
    expect(store.get(task.id)?.status).toBe('stopped_pending')

    // Idempotent for pending states.
    const again = await store.stop(task.id, 'model')
    expect(again.stopSource).toBe('user')
  })

  it('markOrphaned flips only active tasks and persists', async () => {
    const store = new BackgroundTaskStore(dir, clock)
    const running = await store.create({ sessionId: 's1', kind: 'tool' })
    const backgrounded = await store.create({ sessionId: 's1', kind: 'bash', backgrounded: true })
    const done = await store.create({ sessionId: 's1', kind: 'bash', backgrounded: true })
    await store.complete(done.id)

    now += 1_000
    const orphaned = await store.markOrphaned()
    expect(orphaned.map((t) => t.id).sort()).toEqual([running.id, backgrounded.id].sort())
    expect(store.get(done.id)?.status).toBe('completed_pending')

    const reloaded = new BackgroundTaskStore(dir, clock)
    await reloaded.load()
    expect(reloaded.get(running.id)?.status).toBe('orphaned_pending')
    expect(reloaded.get(running.id)?.stopSource).toBe('app_quit')
    expect(reloaded.get(backgrounded.id)?.status).toBe('orphaned_pending')
  })

  it('reloads persisted records and keeps ids unique', async () => {
    const store = new BackgroundTaskStore(dir, clock)
    const a = await store.create({ sessionId: 's1', kind: 'bash' })
    const b = await store.create({ sessionId: 's1', kind: 'bash' })
    expect(a.id).not.toBe(b.id)

    const reloaded = new BackgroundTaskStore(dir, clock)
    await reloaded.load()
    expect(reloaded.list().map((t) => t.id).sort()).toEqual([a.id, b.id].sort())

    const c = await reloaded.create({ sessionId: 's1', kind: 'bash' })
    expect(c.id).not.toBe(a.id)
    expect(c.id).not.toBe(b.id)
  })

  it('rejects invalid transitions', async () => {
    const store = new BackgroundTaskStore(dir, clock)
    const task = await store.create({ sessionId: 's1', kind: 'bash', backgrounded: true })
    await store.complete(task.id)

    await expect(store.markBackgrounded(task.id)).rejects.toThrow()
    await expect(store.markBackgrounded('missing')).rejects.toThrow()
    await expect(store.get('missing')).toBeUndefined()
  })
})
