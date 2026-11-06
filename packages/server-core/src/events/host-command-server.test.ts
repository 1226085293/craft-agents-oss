import { describe, it, expect } from 'bun:test'
import { createServer } from 'node:http'
import { handleHostCommandRequest, type HostCommand } from './host-command-server.ts'

/** Minimal body reader: the router only needs text plus a size cap. */
function readBody(req: import('node:http').IncomingMessage, limit: number): Promise<string | 'too_large'> {
  return new Promise((resolve) => {
    let total = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > limit) resolve('too_large')
      else chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

/**
 * A plugin must be able to discover and call host capabilities from the
 * catalogue alone, and must not be able to reach them without the token.
 */

const TOKEN = 'test-token'

function start(options: { commands: HostCommand[]; token?: string }) {
  const server = createServer((req, res) => {
    void handleHostCommandRequest(req, res, {
      commands: options.commands,
      token: options.token ?? TOKEN,
      isLoopbackHostHeader: (host) => host?.startsWith('127.0.0.1') === true,
      readBody,
    }).then((handled) => {
      if (!handled) {
        res.writeHead(404).end()
      }
    })
  })
  return new Promise<{ base: string; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => server.close(),
      })
    })
  })
}

const compactCalls: string[] = []
const commands: HostCommand[] = [
  {
    name: 'compact',
    summary: 'Compact the session context now',
    params: [
      { name: 'sessionId', type: 'string', required: true, description: 'Target session' },
    ],
    run: async (args) => {
      compactCalls.push(String(args.sessionId))
      return { compacting: true }
    },
  },
]

describe('host command API', () => {
  it('publishes a catalogue a plugin can build calls from', async () => {
    const { base, close } = await start({ commands })
    try {
      const res = await fetch(`${base}/host`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { commands: Array<Record<string, unknown>> }
      expect(body.commands).toHaveLength(1)
      expect(body.commands[0]).toMatchObject({ name: 'compact', summary: expect.any(String) })
      // The shape has to be in the payload: a plugin cannot guess param names.
      expect(body.commands[0]!.params).toEqual([
        { name: 'sessionId', type: 'string', required: true, description: 'Target session' },
      ])
    } finally {
      close()
    }
  })

  it('runs a command with its parameters', async () => {
    compactCalls.length = 0
    const { base, close } = await start({ commands })
    try {
      const res = await fetch(`${base}/host/compact`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-1' }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, result: { compacting: true } })
      expect(compactCalls).toEqual(['sess-1'])
    } finally {
      close()
    }
  })

  it('rejects a call without the token', async () => {
    const { base, close } = await start({ commands })
    try {
      const res = await fetch(`${base}/host/compact`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-1' }),
      })
      expect(res.status).toBe(401)
    } finally {
      close()
    }
  })

  it('names the missing parameter instead of running anyway', async () => {
    compactCalls.length = 0
    const { base, close } = await start({ commands })
    try {
      const res = await fetch(`${base}/host/compact`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string; param: string }
      expect(body.error).toBe('missing_param')
      expect(body.param).toBe('sessionId')
      expect(compactCalls).toEqual([])
    } finally {
      close()
    }
  })

  it('lists what does exist when the name is unknown', async () => {
    const { base, close } = await start({ commands })
    try {
      const res = await fetch(`${base}/host/compactt`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: '{}',
      })
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error: string; available: string[] }
      expect(body.error).toBe('unknown_command')
      expect(body.available).toEqual(['compact'])
    } finally {
      close()
    }
  })

  it('reports a failing command without pretending it worked', async () => {
    const failing: HostCommand[] = [
      {
        name: 'stop',
        summary: 'Stop',
        params: [],
        run: async () => {
          throw new Error('session is gone')
        },
      },
    ]
    const { base, close } = await start({ commands: failing })
    try {
      const res = await fetch(`${base}/host/stop`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: '{}',
      })
      expect(res.status).toBe(500)
      const body = (await res.json()) as { ok: boolean; message: string }
      expect(body.ok).toBe(false)
      expect(body.message).toBe('session is gone')
    } finally {
      close()
    }
  })

  it('leaves non-host paths to the ingest router', async () => {
    const { base, close } = await start({ commands })
    try {
      const res = await fetch(`${base}/events/some-plugin`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      expect(res.status).toBe(404)
    } finally {
      close()
    }
  })
})
