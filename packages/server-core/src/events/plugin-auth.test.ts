/**
 * Plugin sign-in relay — real loopback server, real client.
 *
 * These tests stand in for a plugin's control service and drive the whole
 * relay: start / state / submit / cancel, the `unsupported` 404, token
 * rejection, malformed payloads, and the credential hand-over that only
 * happens on `connected`.
 *
 * What they cannot prove: that WeChat or WhatsApp actually accepts a scan.
 * That needs a real account and is listed in the report as the one step no
 * offline test can cover.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  startPluginAuth,
  readPluginAuth,
  submitPluginAuthCode,
  cancelPluginAuth,
} from './plugin-auth.ts'

let root: string
let server: Server | null = null
const TOKEN = 'auth-test-token'

/** What the fake plugin answers next; tests rewrite it per case. */
let nextState: unknown = { phase: 'awaiting', qr: 'https://example.test/qr-1' }
let noAuthFlow = false
/** Code the fake plugin was asked to verify (_submit only). */
let seenCode: string | null = null

function startServer(): Promise<number> {
  return new Promise((resolve) => {
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const auth = req.headers.authorization ?? ''
      if (auth !== `Bearer ${TOKEN}`) {
        res.writeHead(401).end('unauthorized')
        return
      }
      if (noAuthFlow) {
        res.writeHead(404).end('no auth flow')
        return
      }
      const url = req.url ?? ''
      if (req.method === 'POST' && url === '/auth/start') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(nextState))
        return
      }
      if (req.method === 'GET' && url === '/auth/state') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(nextState))
        return
      }
      if (req.method === 'POST' && url === '/auth/submit') {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { code?: string }
          seenCode = body.code ?? null
        } catch {
          seenCode = null
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(nextState))
        return
      }
      if (req.method === 'POST' && url === '/auth/cancel') {
        nextState = { phase: 'idle' }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(nextState))
        return
      }
      res.writeHead(404).end('not found')
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server?.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
}

/** Publish a control.json the relay will find, exactly like a plugin does. */
function writeControl(port: number, token = TOKEN): void {
  writeFileSync(join(root, 'control.json'), JSON.stringify({ port, token, pid: process.pid }), {
    encoding: 'utf8',
    mode: 0o600,
  })
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'plugin-auth-'))
  nextState = { phase: 'awaiting', qr: 'https://example.test/qr-1' }
  noAuthFlow = false
  seenCode = null
})

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
  }
  rmSync(root, { recursive: true, force: true })
})

describe('plugin auth relay', () => {
  it('reports not-running when the plugin published no control service', async () => {
    const result = await startPluginAuth('wechat', join(root, 'events-data', 'wechat'))
    expect(result.ok).toBe(false)
    expect(result.code).toBe('not-running')
  })

  it('starts an attempt and returns the QR string as issued', async () => {
    const port = await startServer()
    writeControl(port)
    const result = await startPluginAuth('wechat', root)
    expect(result.ok).toBe(true)
    expect(result.state?.phase).toBe('awaiting')
    // Raw platform string, not a data URL: the UI encodes it.
    expect(result.state?.qr).toBe('https://example.test/qr-1')
    expect(result.state?.listenerId).toBe('wechat')
  })

  it('maps a plugin without a sign-in flow to `unsupported`, not an error', async () => {
    const port = await startServer()
    noAuthFlow = true
    writeControl(port)
    const result = await startPluginAuth('telegram', root)
    expect(result.ok).toBe(false)
    expect(result.code).toBe('unsupported')
  })

  it('rejects a control.json whose token does not match', async () => {
    const port = await startServer()
    writeControl(port, 'wrong-token')
    const result = await startPluginAuth('wechat', root)
    // The plugin answers 401; the relay must not treat that as success.
    expect(result.ok).toBe(false)
    expect(result.code).toBe('rejected')
  })

  it('reads the current snapshot without starting anything', async () => {
    const port = await startServer()
    writeControl(port)
    nextState = { phase: 'scanned', detail: '已扫码，请在手机上确认' }
    const result = await readPluginAuth('wechat', root)
    expect(result.ok).toBe(true)
    expect(result.state?.phase).toBe('scanned')
    expect(result.state?.detail).toBe('已扫码，请在手机上确认')
  })

  it('walks the state machine: awaiting → need_code → submit → connected', async () => {
    const port = await startServer()
    writeControl(port)

    const started = await startPluginAuth('wechat', root)
    expect(started.state?.phase).toBe('awaiting')

    nextState = { phase: 'need_code', detail: '请输入手机上的数字' }
    const mid = await readPluginAuth('wechat', root)
    expect(mid.state?.phase).toBe('need_code')

    nextState = {
      phase: 'connected',
      detail: '登录成功',
      credentials: { token: '{"botToken":"t","botId":"b"}' },
    }
    const done = await submitPluginAuthCode('wechat', root, ' 123456 ')
    expect(seenCode).toBe('123456')
    expect(done.ok).toBe(true)
    expect(done.state?.phase).toBe('connected')
    // Credentials are handed to the caller separately, never inside the state.
    expect(done.credentials).toEqual({ token: '{"botToken":"t","botId":"b"}' })
    expect((done.state as unknown as Record<string, unknown>).credentials).toBeUndefined()
  })

  it('refuses an empty verification code without calling the plugin', async () => {
    const port = await startServer()
    writeControl(port)
    const result = await submitPluginAuthCode('wechat', root, '   ')
    expect(result.ok).toBe(false)
    expect(result.code).toBe('rejected')
    expect(seenCode).toBeNull()
  })

  it('cancels back to idle', async () => {
    const port = await startServer()
    writeControl(port)
    const result = await cancelPluginAuth('wechat', root)
    expect(result.ok).toBe(true)
    expect(result.state?.phase).toBe('idle')
  })

  it('treats an unknown phase as a bad payload instead of passing it on', async () => {
    const port = await startServer()
    writeControl(port)
    nextState = { phase: 'totally-made-up' }
    const result = await startPluginAuth('wechat', root)
    expect(result.ok).toBe(false)
    expect(result.code).toBe('bad-payload')
  })

  it('truncates an over-long QR instead of trusting the plugin blindly', async () => {
    const port = await startServer()
    writeControl(port)
    nextState = { phase: 'awaiting', qr: 'x'.repeat(9000) }
    const result = await startPluginAuth('wechat', root)
    expect(result.ok).toBe(true)
    expect(result.state?.qr?.length).toBe(4096)
  })
})
