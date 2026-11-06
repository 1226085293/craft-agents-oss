/**
 * This plugin's process entry.
 *
 * It belongs to this plugin, not to Craft and not to the other plugins: a
 * plugin is a standalone thing that ships everything it needs to run. Duplicating
 * this file across plugins is deliberate — shared host-side code would make five
 * independent plugins one coupled bundle, and a change for one would change all.
 */
/**
 * Generic plugin process.
 *
 * A platform plugin used to be `builtin`: its actions ran inside Craft and the
 * gateway ran its adapter. Both are gone, so this file is the whole contract —
 * and it carries no platform knowledge. A plugin supplies `createAdapter`; the
 * rest is the same for every platform, because it is only about turning platform
 * messages into events and host calls into adapter calls.
 *
 * Three jobs:
 *
 *   inbound   initialize the adapter, receive its messages, POST each one as a
 *             `craft-event/1` event. Craft never learns the platform's shape.
 *   outbound  serve `POST /action` so Craft can ask the plugin to send.
 *   host      the plugin decides everything user-facing; when it needs Craft to
 *             do something (stop a turn, compact) it calls `POST /host/<name>`,
 *             whose address arrives in the environment.
 */

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'

const PORT = Number(process.env.CRAFT_PLUGIN_PORT ?? 0)
const PLUGIN_ID = process.env.CRAFT_LISTENER_ID ?? 'plugin'
const EVENTS_URL = process.env.CRAFT_EVENTS_URL ?? ''
const EVENTS_TOKEN = process.env.CRAFT_EVENTS_TOKEN ?? ''
const CONFIG_PATH = process.env.CRAFT_LISTENER_CONFIG ?? ''

interface IncomingLike {
  channelId?: string
  channelName?: string
  threadId?: number
  text?: string
  senderName?: string
  senderId?: string
  messageId?: string
  isGroup?: boolean
  mentionsBot?: boolean
}

interface PlatformAdapterLike {
  initialize?: (config: unknown) => Promise<void>
  onMessage?: (handler: (msg: IncomingLike) => Promise<void>) => void
  sendText?: (channelId: string, text: string) => Promise<unknown>
  destroy?: () => Promise<void>
}

interface ActionModule {
  createAdapter?: (options?: Record<string, unknown>) => PlatformAdapterLike
  performAction?: (
    action: string,
    args: Record<string, unknown>,
  ) => Promise<{ ok: boolean; message?: string }>
}

/** The plugin's own config values, as the user filled them in. */
function readConfig(): Record<string, unknown> {
  if (!CONFIG_PATH) return {}
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Record<string, unknown>
  } catch {
    // Empty config is a normal state (just installed); the adapter decides
    // whether it can connect without it.
    return {}
  }
}

/**
 * Turn one platform message into one event.
 *
 * The text is the body; everything else is a link or a summary field. `type` is
 * namespaced by the plugin id so rules can target `telegram.message` without
 * Craft holding a list of platforms.
 */
function toEvent(msg: IncomingLike): Record<string, unknown> | null {
  const text = (msg.text ?? '').trim()
  if (!text) return null

  const channelId = msg.channelId ?? ''
  const event: Record<string, unknown> = {
    type: `${PLUGIN_ID}.message`,
    title: text.length > 80 ? `${text.slice(0, 77)}…` : text,
    summary: text.length > 80 ? text : undefined,
    body: text,
    source: PLUGIN_ID,
    occurredAt: Date.now(),
    // Reply target: whoever handles this event can answer without knowing the
    // platform, because the plugin already said which channel it came from.
    links: channelId
      ? [{ rel: 'reply', url: `message://${PLUGIN_ID}/${encodeURIComponent(channelId)}/${msg.messageId ?? ''}` }]
      : [],
    // Same platform message must never wake two turns, even if the adapter
    // reconnects and replays a short history window.
    ...(msg.messageId ? { dedupeKey: `${PLUGIN_ID}:${channelId}:${msg.messageId}` } : {}),
    meta: {
      channelId,
      ...(msg.channelName ? { channelName: msg.channelName } : {}),
      ...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
      ...(msg.senderName ? { senderName: msg.senderName } : {}),
      ...(msg.senderId ? { senderId: msg.senderId } : {}),
      ...(msg.isGroup !== undefined ? { isGroup: msg.isGroup } : {}),
      ...(msg.mentionsBot !== undefined ? { mentionsBot: msg.mentionsBot } : {}),
    },
  }
  return event
}

/** POST one event to Craft. Failures are logged, never fatal: a dropped event
 *  must not take the adapter's read loop down with it. */
async function publish(event: Record<string, unknown>): Promise<void> {
  if (!EVENTS_URL) return
  try {
    const res = await fetch(EVENTS_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${EVENTS_TOKEN}`,
      },
      body: JSON.stringify(event),
    })
    if (!res.ok) {
      console.error(JSON.stringify({ event: 'publish_failed', status: res.status }))
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'publish_error',
        message: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}

const entry = process.env.CRAFT_PLUGIN_ENTRY ?? './program/index.ts'
const url = new URL(entry, `file://${process.cwd().replace(/\\/g, '/')}/`).href
const plugin = (await import(url)) as ActionModule

const config = readConfig()
const adapter = plugin.createAdapter?.({ config }) ?? null

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
      // Craft treats this as proof the plugin is up, so answer only once the
      // adapter exists — a health check that passes with no adapter is a lie.
      // 200 once the platform is actually connected; 503 while it is waiting for
      // credentials. Craft shows "starting" rather than claiming it is healthy.
      send(connected ? 200 : 503, { ok: connected, plugin: PLUGIN_ID })
      return
    }

    if (req.url !== '/action' || req.method !== 'POST') {
      send(404, { error: 'not_found' })
      return
    }

    const body = (await readJson(req)) as { action?: string; args?: Record<string, unknown> } | null
    const action = typeof body?.action === 'string' ? body.action : ''
    if (!action) {
      send(400, { ok: false, message: 'action is required' })
      return
    }
    const args = body?.args ?? {}

    try {
      if (typeof plugin.performAction === 'function') {
        send(200, await plugin.performAction(action, args))
        return
      }

      if (action === 'send_message') {
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

      if (action === 'deliver_file') {
        send(501, { ok: false, message: 'plugin does not implement file delivery yet' })
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
  console.log(JSON.stringify({ ready: true, port }))
})

// Inbound: the adapter owns the platform connection; this only forwards.
//
// A failed initialize is not fatal. "No credentials yet" is the normal state the
// moment a plugin is installed, and taking the process down would turn that into
// a crash loop the supervisor has to babysit — and would also kill /action, so
// the plugin could not even report why it is not running.
let connected = false
if (adapter) {
  adapter.onMessage?.(async (msg) => {
    const event = toEvent(msg)
    if (event) await publish(event)
  })
  try {
    await adapter.initialize?.(config)
    connected = true
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'initialize_failed',
        plugin: PLUGIN_ID,
        message: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}

const shutdown = async () => {
  try {
    await adapter?.destroy?.()
  } finally {
    server.close(() => process.exit(0))
  }
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
