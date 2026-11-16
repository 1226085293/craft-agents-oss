/**
 * performAction — the bridge the plugin's own page (and host relays) drive.
 *
 * auth_* moves the sign-in state machine and answers with its full state as
 * JSON in `message`; send actions go through the main adapter. The QR start
 * is replayed against a fake iLink endpoint, the way login.test.ts does it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { performAction } from './index.ts'

const realFetch = globalThis.fetch

function installFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/get_bot_qrcode')) {
      return Response.json({
        qrcode: 'qr-ticket-abc',
        qrcode_img_content: 'https://weixin.test/qr/qr-ticket-abc',
      })
    }
    if (url.includes('/get_qrcode_status')) {
      return Response.json({ status: 'wait' })
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
}

beforeEach(() => installFetch())
afterEach(() => {
  globalThis.fetch = realFetch
})

describe('performAction — auth actions', () => {
  it('auth_state answers idle as JSON when nothing is running', async () => {
    const res = await performAction('auth_state', {})
    expect(res.ok).toBe(true)
    const state = JSON.parse(res.message!)
    expect(state.phase).toBe('idle')
  })

  it('auth_start produces the QR and auth_state keeps answering', async () => {
    const start = await performAction('auth_start', {})
    expect(start.ok).toBe(true)
    const st = JSON.parse(start.message!)
    expect(st.phase).toBe('awaiting')
    expect(st.qr).toBe('https://weixin.test/qr/qr-ticket-abc')

    const mid = await performAction('auth_state', {})
    expect(JSON.parse(mid.message!).phase).toBe('awaiting')

    const cancel = await performAction('auth_cancel', {})
    expect(JSON.parse(cancel.message!).phase).toBe('idle')
  })

  it('auth_submit without a pending attempt is a truthful refusal, not a crash', async () => {
    const res = await performAction('auth_submit', { code: '1234' })
    expect(res.ok).toBe(true)
    const st = JSON.parse(res.message!)
    // The state machine says "nothing is waiting for a code" instead of swallowing it.
    expect(st.error).toBeTruthy()
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
