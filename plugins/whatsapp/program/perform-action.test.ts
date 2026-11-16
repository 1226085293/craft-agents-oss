/**
 * performAction — the bridge the plugin's own page (and host relays) drive.
 *
 * The auth actions answer with the sign-in state as JSON in `message`. These
 * tests stay off the network: no worker is spawned, so `auth_start` is left
 * to auth-injection.test.ts's broken-worker case instead.
 */

import { describe, it, expect } from 'bun:test'
import { performAction, createAuth } from './index.ts'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..', '..')

describe('performAction — auth actions', () => {
  it('auth_state answers idle as JSON when nothing is running', async () => {
    const res = await performAction('auth_state', {})
    expect(res.ok).toBe(true)
    const state = JSON.parse(res.message!)
    expect(state.phase).toBe('idle')
  })

  it('auth_cancel is a no-op refusal, not an error', async () => {
    const res = await performAction('auth_cancel', {})
    expect(res.ok).toBe(true)
    expect(JSON.parse(res.message!).phase).toBe('idle')
  })

  it('createAuth still answers idle without a main adapter', () => {
    const auth = createAuth({ config: {}, dataDir: join(REPO, 'tmp-test-data', 'pa-idle') })
    expect(auth.state().phase).toBe('idle')
  })

  it('start() while a QR is live hands it back untouched instead of resetting', async () => {
    const auth = createAuth({ config: {}, dataDir: join(REPO, 'tmp-test-data', 'pa-idempotent') })
    // No worker is spawned here: the guard under test returns before touching
    // the adapter, which is the whole point — a second 开始授权 click must not
    // drop the QR the person is scanning, nor wait for a signal that only
    // arrives on the next rotation.
    const live = { phase: 'awaiting' as const, qr: '2@LIVE-QR', attempt: 7, detail: '请用手机 WhatsApp 扫描二维码配对' }
    const internals = auth as unknown as { snapshot: unknown; adapter: unknown }
    internals.snapshot = { ...live }
    internals.adapter = { onEvent: () => () => {} }

    const startedAt = Date.now()
    const state = await auth.start()
    expect(state.phase).toBe('awaiting')
    expect(state.qr).toBe('2@LIVE-QR')
    expect(state.attempt).toBe(7)
    // Returned at once; the old path sat in waitForFirstSignal for up to 12 s.
    expect(Date.now() - startedAt).toBeLessThan(1000)
    expect(auth.state().qr).toBe('2@LIVE-QR')

    internals.adapter = null
    internals.snapshot = { phase: 'idle' }
  })
})

describe('performAction — send actions', () => {
  it('send_message without a live adapter is an honest refusal', async () => {
    const res = await performAction('send_message', { text: 'hi', channelId: 'user:1' })
    expect(res.ok).toBe(false)
    expect(res.message).toBeTruthy()
  })

  it('an undeclared action is refused', async () => {
    const res = await performAction('bogus_action', {})
    expect(res.ok).toBe(false)
    expect(res.message).toContain('bogus_action')
  })
})
