/**
 * Generic plugin process.
 *
 * Every platform plugin used to be `builtin`: its actions ran inside Craft, so
 * the plugin was a manifest plus an in-process adapter. That meant two kinds of
 * plugin existed and only one of them was ever really exercised.
 *
 * This file is the smallest thing that makes a plugin a real program: it loads
 * the plugin's own adapter, serves `POST /action` for the host to call, and
 * exits. It contains no platform knowledge — each plugin supplies its adapter
 * through `createAdapter`, exactly as before.
 *
 * The host sends `{ action, args }` and gets `{ ok, message }` back. Anything the
 * plugin wants to tell its users goes through the action itself; anything it
 * wants Craft to do it calls on the host command API (`POST /host/<name>`),
 * whose address and token arrive in the environment.
 */

import { createServer } from 'node:http'

const PORT = Number(process.env.CRAFT_PLUGIN_PORT ?? 0)
const WORKSPACE = process.env.CRAFT_WORKSPACE_DIR ?? process.cwd()

interface ActionRequest {
  action?: string
  args?: Record<string, unknown>
}

interface ActionModule {
  /** The plugin's own adapter factory, kept from the pre-process design. */
  createAdapter?: (options?: Record<string, unknown>) => PlatformAdapterLike
  /** Preferred: an explicit action dispatcher when the plugin provides one. */
  performAction?: (
    action: string,
    args: Record<string, unknown>,
  ) => Promise<{ ok: boolean; message?: string }>
}

/** Only the part of the adapter this server uses. */
interface PlatformAdapterLike {
  initialize?: (config: unknown) => Promise<void>
  sendText?: (channelId: string, text: string) => Promise<unknown>
}

async function loadPluginModule(entry: string): Promise<ActionModule> {
  const url = new URL(entry, `file://${WORKSPACE.replace(/\\/g, '/')}/`).href
  return (await import(url)) as ActionModule
}

function readJson(req: import('node:http').IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 4 * 1024 * 1024) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

const entry = process.env.CRAFT_PLUGIN_ENTRY ?? './program/index.ts'
const plugin = await loadPluginModule(entry)

const server = createServer((req, res) => {
  void (async () => {
    const send = (status: number, payload: unknown) => {
      const body = JSON.stringify(payload)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      })
      res.end(body)
    }

    if (req.url === '/health') {
      send(200, { ok: true })
      return
    }

    if (req.url !== '/action' || req.method !== 'POST') {
      send(404, { error: 'not_found' })
      return
    }

    const body = (await readJson(req)) as ActionRequest | null
    const action = typeof body?.action === 'string' ? body.action : ''
    if (!action) {
      send(400, { ok: false, message: 'action is required' })
      return
    }

    const args = body?.args ?? {}

    try {
      // An explicit dispatcher wins: it can implement actions the adapter's
      // shape does not cover (pairing, QR handshakes, command replies).
      if (typeof plugin.performAction === 'function') {
        send(200, await plugin.performAction(action, args))
        return
      }

      // Otherwise map the one action every platform has onto the adapter. This
      // is what `builtin` used to do inside Craft; now it happens here, in the
      // plugin's own process, which is the whole point of removing builtin.
      if (action === 'send_message') {
        const adapter = plugin.createAdapter?.({})
        const text = typeof args.text === 'string' ? args.text.trim() : ''
        const channelId = typeof args.channelId === 'string' ? args.channelId : ''
        if (!text) {
          send(400, { ok: false, message: 'text is required' })
          return
        }
        if (!channelId || typeof adapter?.sendText !== 'function') {
          send(501, { ok: false, message: 'adapter cannot send to this channel' })
          return
        }
        await adapter.sendText(channelId, text)
        send(200, { ok: true, message: `sent to ${channelId}` })
        return
      }

      send(501, { ok: false, message: `plugin does not implement ${action}` })
    } catch (error) {
      send(500, {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  })()
})

server.listen(PORT, '127.0.0.1', () => {
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  // The host reads this line to learn the port. One line, machine-readable, so
  // supervision does not depend on guessing a fixed port per plugin.
  console.log(JSON.stringify({ ready: true, port }))
})
