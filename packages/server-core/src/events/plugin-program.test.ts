import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer, type Server } from 'node:http'
import { EventService } from './event-service.ts'

/**
 * The plugin program is the only thing between a platform and Craft now that
 * the gateway is gone, so its contract is pinned here end to end: a real child
 * process, a real adapter emitting a real message, and a real ingest endpoint
 * deciding whether the result is an event.
 *
 * A unit test with a stubbed fetch would pass even if the plugin sent a payload
 * Craft rejects — which is exactly the failure this replaces.
 */

/**
 * A plugin ships its own process entry — there is no shared runtime any more.
 * The fixture copies the real one from a shipped plugin so this test exercises
 * the code that actually runs, not a stand-in.
 */
const SERVE_SOURCE = resolve(import.meta.dir, '../../../../plugins/telegram/program/serve.ts')

let root: string
let service: EventService

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'plugin-program-'))
  service = new EventService({ workspaceId: 'ws', workspaceRoot: root })
  await service.start()
})

afterAll(async () => {
  await service.stop()
  cleanup(root)
})

/**
 * Windows keeps a directory locked for a moment after the child exits, so a
 * failed cleanup is not a test failure — it is housekeeping. Retry briefly and
 * give up quietly; the OS temp dir is not an assertion.
 */
function cleanup(dir: string): void {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      cleanup(dir)
      return
    } catch {
      Bun.sleepSync(50)
    }
  }
}

function writeFixture(id: string, adapterSource: string, config?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), `fixture-${id}-`))
  mkdirSync(join(dir, 'program'), { recursive: true })
  writeFileSync(join(dir, 'program', 'index.ts'), adapterSource, 'utf8')
  writeFileSync(join(dir, 'program', 'serve.ts'), readFileSync(SERVE_SOURCE, 'utf8'), 'utf8')
  if (config) writeFileSync(join(dir, 'config.json'), JSON.stringify(config), 'utf8')
  return dir
}

/** Spawn the plugin and wait for its readiness line. */
function spawnPlugin(dir: string, pluginId: string): { stop: () => void; port: Promise<number> } {
  const env = service.listenerEnv(pluginId)
  const proc = Bun.spawn(['bun', 'run', 'program/serve.ts'], {
    cwd: dir,
    env: {
      ...process.env,
      ...env,
      CRAFT_LISTENER_ID: pluginId,
      CRAFT_PLUGIN_ENTRY: './program/index.ts',
      CRAFT_LISTENER_CONFIG: join(dir, 'config.json'),
      CRAFT_PLUGIN_PORT: '0',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const port = (async () => {
    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) throw new Error('plugin exited before reporting readiness')
      buffer += decoder.decode(value, { stream: true })
      const line = buffer.split('\n').find((entry) => entry.includes('"ready"'))
      if (line) return (JSON.parse(line) as { port: number }).port
    }
  })()

  return { stop: () => proc.kill(), port }
}

const adapterThatEmitsOneMessage = `
export function createAdapter() {
  let handler = null
  return {
    onMessage: (h) => { handler = h },
    initialize: async () => {
      setTimeout(() => {
        void handler?.({
          channelId: 'chat-9',
          threadId: 3,
          text: '你好 Craft',
          senderName: '小明',
          messageId: 'm-1',
        })
      }, 100)
    },
    sendText: async (channelId, text) => { globalThis.__sent = { channelId, text }; return { id: 'sent-1' } },
  }
}
`

describe('plugin program', () => {
  it('publishes an incoming platform message as an event Craft accepts', async () => {
    const dir = writeFixture('inbound', adapterThatEmitsOneMessage)
    const plugin = spawnPlugin(dir, 'telegram')
    try {
      await plugin.port
      // Give the adapter's delayed message time to travel through the program.
      await Bun.sleep(1200)

      const events = service.list({ limit: 10 }) as Array<{ id: string; source: string; type: string; title: string }>
      const event = events.find((entry) => entry.type === 'telegram.message')
      expect(event).toBeDefined()
      expect(event!.title).toBe('你好 Craft')
      expect(event!.source).toBe('telegram')
    } finally {
      plugin.stop()
      cleanup(dir)
    }
  })

  it('answers health only once it has an adapter, and sends through it', async () => {
    const dir = writeFixture('outbound', adapterThatEmitsOneMessage)
    const plugin = spawnPlugin(dir, 'lark')
    try {
      const port = await plugin.port
      const health = await fetch(`http://127.0.0.1:${port}/health`)
      expect(health.status).toBe(200)

      const sent = await fetch(`http://127.0.0.1:${port}/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'send_message', args: { channelId: 'chat-9', text: 'hi' } }),
      })
      expect(sent.status).toBe(200)
      expect(await sent.json()).toEqual({ ok: true, message: 'sent to chat-9' })
    } finally {
      plugin.stop()
      cleanup(dir)
    }
  })
})
