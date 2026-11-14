/**
 * WeChat QR sign-in state machine — replayed against a fake iLink endpoint.
 *
 * The real platform cannot be driven from a test, so `fetch` is replaced with a
 * scripted responder keyed by URL. That is enough to prove the part this repo
 * owns: the seven platform statuses map to the right phases, a verification
 * code is carried through, and `confirmed` produces the exact credential shape
 * this plugin's own `parseCredentials` reads back.
 *
 * Not covered here (needs a real account): the platform actually accepting a
 * scan, and the bot token working against iLink afterwards.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { WeChatQrLogin } from './login.ts'

/** Responses the fake iLink returns, in call order. */
let statusQueue: Array<Record<string, unknown>> = []
let qrShouldFail = false
/** Every qrcode value the machine polled with, to prove the code is forwarded. */
let polledUrls: string[] = []

const realFetch = globalThis.fetch

function installFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input : input.url)

    if (url.includes('/get_bot_qrcode')) {
      if (qrShouldFail) return new Response('boom', { status: 500 })
      return Response.json({
        qrcode: 'qr-ticket-123',
        qrcode_img_content: 'https://weixin.test/qr/qr-ticket-123',
      })
    }

    if (url.includes('/get_qrcode_status')) {
      polledUrls.push(url)
      const next = statusQueue.shift() ?? { status: 'wait' }
      return Response.json(next)
    }

    return new Response('not found', { status: 404 })
  }) as typeof fetch
}

/** Let the background poll loop advance; it sleeps 1 s between ticks. */
async function settle(rounds = 2): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1100))
  }
}

/**
 * Wait until the machine reports `phase`, or fail.
 *
 * The loop sleeps 1 s between polls, so counting ticks couples the test to the
 * interval. Waiting for the state it should reach tests the behaviour instead.
 */
async function waitForPhase(login: WeChatQrLogin, phase: string, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (login.state().phase === phase) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for phase ${phase}, saw ${login.state().phase}`)
}

beforeEach(() => {
  statusQueue = []
  qrShouldFail = false
  polledUrls = []
  installFetch()
})

afterEach(() => {
  globalThis.fetch = realFetch
  mock.restore()
})

describe('WeChatQrLogin', () => {
  it('starts idle', () => {
    const login = new WeChatQrLogin()
    expect(login.state().phase).toBe('idle')
  })

  it('start() returns a scannable payload immediately, without waiting for a poll', async () => {
    const login = new WeChatQrLogin()
    const state = await login.start()
    expect(state.phase).toBe('awaiting')
    // The image content is what the phone reads; it is a raw string, not a data URL.
    expect(state.qr).toBe('https://weixin.test/qr/qr-ticket-123')
    expect(state.attempt).toBe(1)
    expect(state.expiresAt).toBeGreaterThan(Date.now())
    await login.cancel()
  })

  it('reports a failed attempt when the platform will not issue a code', async () => {
    qrShouldFail = true
    const login = new WeChatQrLogin()
    const state = await login.start()
    expect(state.phase).toBe('failed')
    expect(state.error).toContain('500')
  })

  it('walks wait → scaned → need_code → connected and yields config.token', async () => {
    statusQueue = [
      { status: 'wait' },
      { status: 'scaned' },
      { status: 'need_verifycode' },
      {
        status: 'confirmed',
        bot_token: 'BOT-TOKEN-XYZ',
        ilink_bot_id: 'bot-42',
        baseurl: 'https://ilinkai.weixin.qq.com',
        ilink_user_id: 'user-7',
      },
    ]

    const login = new WeChatQrLogin()
    await login.start()
    expect(login.state().phase).toBe('awaiting')

    // scaned, then need_verifycode — each reached on its own poll.
    await waitForPhase(login, 'scanned')
    await waitForPhase(login, 'need_code')

    // The code the person typed is forwarded to the platform on the next poll.
    await login.submit('654321')
    await waitForPhase(login, 'connected')

    const final = login.state()
    expect(final.phase).toBe('connected')
    expect(polledUrls.some((url) => url.includes('verify_code=654321'))).toBe(true)

    // Exactly what parseWeChatCredentials reads: a JSON string under `token`.
    expect(final.credentials).toBeDefined()
    const token = String((final.credentials as Record<string, unknown>).token)
    const parsed = JSON.parse(token) as Record<string, unknown>
    expect(parsed.botToken).toBe('BOT-TOKEN-XYZ')
    expect(parsed.botId).toBe('bot-42')
    expect(parsed.baseUrl).toBe('https://ilinkai.weixin.qq.com')
    expect(parsed.userId).toBe('user-7')
  })

  it('refuses a code when nothing is waiting for one', async () => {
    const login = new WeChatQrLogin()
    await login.start()
    const state = await login.submit('123456')
    expect(state.error).toBe('当前没有等待验证码的授权请求')
    await login.cancel()
  })

  it('reports an already-bound account as failed, with the reason', async () => {
    statusQueue = [{ status: 'binded_redirect' }]
    const login = new WeChatQrLogin()
    await login.start()
    await waitForPhase(login, 'failed')
    const state = login.state()
    expect(state.error).toContain('已经绑定过机器人')
  })

  it('refreshes an expired code instead of dropping the attempt', async () => {
    statusQueue = [{ status: 'expired' }]
    const login = new WeChatQrLogin()
    await login.start()
    // The expired tick triggers a refresh; the flow stays showable rather than dying.
    await settle(2)
    expect(login.state().phase).toBe('awaiting')
    expect(login.state().qr).toBe('https://weixin.test/qr/qr-ticket-123')
    await login.cancel()
  })

  it('cancel() stops the loop and returns to idle', async () => {
    const login = new WeChatQrLogin()
    await login.start()
    const state = await login.cancel()
    expect(state.phase).toBe('idle')
    // A poll already in flight may still land; what must stop is the loop, so
    // allow that one and require the count to freeze afterwards.
    await settle(1)
    const afterFirst = polledUrls.length
    await settle(1)
    expect(polledUrls.length).toBe(afterFirst)
  })
})
