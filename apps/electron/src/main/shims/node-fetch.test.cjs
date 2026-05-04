const { describe, expect, it } = require('bun:test')
const { Readable } = require('node:stream')

const originalFetch = globalThis.fetch

describe('node-fetch shim', () => {
  it('adds duplex=half for Node Readable request bodies and strips node-fetch-only options', async () => {
    let captured
    globalThis.fetch = async (_url, init) => {
      captured = init
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      })
    }

    try {
      delete require.cache[require.resolve('./node-fetch.cjs')]
      const fetchCompat = require('./node-fetch.cjs')
      const body = Readable.from([Buffer.from('hello')])

      await fetchCompat('https://api.telegram.org/botTOKEN/sendDocument', {
        method: 'POST',
        body,
        agent: { keepAlive: true },
        compress: true,
      })

      expect(captured.duplex).toBe('half')
      expect(captured.body).toBe(body)
      expect('agent' in captured).toBe(false)
      expect('compress' in captured).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
