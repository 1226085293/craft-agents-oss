/**
 * Listener control contract tests — real loopback HTTP server, real client.
 * Covers: no control.json → control:false; bad token → 401 → control:false;
 * /deps parsing incl. malformed rows; action POST incl. 409 conflict.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fetchReportedDeps, postDepAction, readControlInfo } from './listener-control.ts'

let root: string
let server: Server | null = null
let port = 0
const TOKEN = 'test-token-1234'

/** Deps payload the fake control service answers with. */
let depsPayload: unknown = { deps: [] }
/** Action behaviour: status code the next POST returns. */
let actionStatus = 202

function startServer(): Promise<number> {
  return new Promise((resolve) => {
    const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const auth = req.headers.authorization ?? ''
      if (auth !== `Bearer ${TOKEN}`) {
        res.writeHead(401).end('unauthorized')
        return
      }
      if (req.method === 'GET' && req.url === '/deps') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(depsPayload))
        return
      }
      if (req.method === 'POST' && req.url?.match(/^\/deps\/[^/]+\/action$/)) {
        res.writeHead(actionStatus).end(actionStatus === 202 ? '{"running":true}' : 'busy')
        return
      }
      res.writeHead(404).end('not found')
    })
    server = httpServer
    httpServer.listen(0, '127.0.0.1', () => {
      const address = httpServer.address()
      port = typeof address === 'object' && address ? address.port : 0
      resolve(port)
    })
  })
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'craft-control-'))
  port = await startServer()
})

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
  rmSync(root, { recursive: true, force: true })
})

function writeControl(info: Record<string, unknown> | null): void {
  const dataDir = join(root, 'events-data', 'demo')
  const { mkdirSync } = require('node:fs') as typeof import('node:fs')
  mkdirSync(dataDir, { recursive: true })
  if (info !== null) {
    writeFileSync(join(dataDir, 'control.json'), JSON.stringify(info), 'utf8')
  }
}

const dataDir = () => join(root, 'events-data', 'demo')

describe('listener control client', () => {
  it('reads control.json and rejects malformed files', () => {
    expect(readControlInfo(dataDir())).toBeNull()
    writeControl({ port, token: TOKEN, pid: 4242 })
    expect(readControlInfo(dataDir())).toEqual({ port, token: TOKEN, pid: 4242 })
    writeControl({ port: 'not-a-port', token: TOKEN })
    expect(readControlInfo(dataDir())).toBeNull()
    writeControl({ port: 99999, token: TOKEN })
    expect(readControlInfo(dataDir())).toBeNull()
  })

  it('reports control:false when there is no control service', async () => {
    const result = await fetchReportedDeps(join(root, 'events-data', 'missing'))
    expect(result.control).toBe(false)
    expect(result.reason).toContain('no control service')
  })

  it('reports control:false when the token is wrong (401)', async () => {
    writeControl({ port, token: 'wrong-token' })
    const result = await fetchReportedDeps(dataDir())
    expect(result.control).toBe(false)
    expect(result.reason).toContain('401')
  })

  it('parses /deps and drops malformed rows', async () => {
    writeControl({ port, token: TOKEN })
    depsPayload = {
      deps: [
        { id: 'ffmpeg', name: 'ffmpeg', installed: false, detail: 'not on PATH', action: { label: 'winget 安装', running: false } },
        { id: 'imaplib', name: 'Python stdlib', installed: true, version: '3.14' },
        { id: 'BAD ID!', name: 'dropped' },
        { name: 'no id' },
        'not an object',
      ],
    }
    const result = await fetchReportedDeps(dataDir())
    expect(result.control).toBe(true)
    expect(result.deps).toHaveLength(2)
    expect(result.deps?.[0]).toMatchObject({
      id: 'ffmpeg', name: 'ffmpeg', installed: false, detail: 'not on PATH',
    })
    expect(result.deps?.[0]?.action).toEqual({ label: 'winget 安装', running: false })
    expect(result.deps?.[1]).toMatchObject({ id: 'imaplib', installed: true, version: '3.14' })
  })

  it('reports control:false on a structurally invalid payload', async () => {
    writeControl({ port, token: TOKEN })
    depsPayload = { deps: 'not-an-array' }
    const result = await fetchReportedDeps(dataDir())
    expect(result.control).toBe(false)
    expect(result.reason).toContain('invalid')
  })

  it('posts actions and surfaces 409 conflicts', async () => {
    writeControl({ port, token: TOKEN })
    actionStatus = 202
    expect(await postDepAction(dataDir(), 'ffmpeg')).toEqual({ ok: true })
    actionStatus = 409
    const busy = await postDepAction(dataDir(), 'ffmpeg')
    expect(busy.ok).toBe(false)
    expect(busy.conflict).toBe(true)
    // Unsafe ids never reach the wire.
    expect((await postDepAction(dataDir(), '../etc')).ok).toBe(false)
  })
})
