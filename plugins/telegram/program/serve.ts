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
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

const PORT = Number(process.env.CRAFT_PLUGIN_PORT ?? 0)
const PLUGIN_ID = process.env.CRAFT_LISTENER_ID ?? 'plugin'
const EVENTS_URL = process.env.CRAFT_EVENTS_URL ?? ''
const EVENTS_TOKEN = process.env.CRAFT_EVENTS_TOKEN ?? ''
const CONFIG_PATH = process.env.CRAFT_LISTENER_CONFIG ?? ''
/** Where the plugin may write `control.json` — Craft reads the service from there. */
const DATA_DIR = process.env.CRAFT_LISTENER_DATA ?? ''
/**
 * Bearer token for the loopback control service.
 *
 * Craft and the plugin run on the same machine but not in the same address
 * space, so the port alone would let any local process drive this plugin's
 * outbound actions. A fresh random token per process, published only in a
 * mode-600 file beside the data dir, closes that: nothing outside this
 * process and Craft ever sees it.
 */
const CONTROL_TOKEN = randomBytes(32).toString('hex')

/**
 * Channel display labels — what THIS platform calls each chat. The host has
 * no platform vocabulary: it asks the plugin "what is this channel named?"
 * (POST /channel_labels) and renders the answer on the pairing page. The
 * plugin learns names from the messages it observes (group titles, sender
 * names) and persists them beside control.json so restarts remember them.
 */
const labelsPath = DATA_DIR ? join(DATA_DIR, 'channel-labels.json') : ''
let channelLabels: Record<string, string> = {}
if (labelsPath) {
  try {
    const raw = JSON.parse(readFileSync(labelsPath, 'utf8')) as Record<string, unknown>
    for (const [key, value] of Object.entries(raw)) {
      if (typeof key === 'string' && typeof value === 'string' && value.trim() && key.length <= 128) {
        channelLabels[key] = value.trim().slice(0, 120)
      }
    }
  } catch {
    // No file or corrupt: start with an empty cache.
  }
}

function noteChannelLabel(msg: IncomingLike): void {
  const key = msg.channelId
  if (!key || key.length > 128) return
  const group = msg.isGroup === true || (msg as { chatKind?: string }).chatKind === 'group'
  const name = group
    ? (msg.channelName ?? msg.senderName)
    : msg.senderName
      ? msg.senderUsername
        ? `${msg.senderName} (@${msg.senderUsername})`
        : msg.senderName
      : msg.channelName
  if (!name || !name.trim()) return
  const clean = name.trim().slice(0, 120)
  if (channelLabels[key] === clean) return
  channelLabels[key] = clean
  if (labelsPath) {
    try {
      writeFileSync(labelsPath, JSON.stringify(channelLabels, null, 2), { encoding: 'utf8', mode: 0o600 })
    } catch {
      // The cache is best-effort; a disk problem must not kill the plugin.
    }
  }
}

interface IncomingLike {
  channelId?: string
  channelName?: string
  threadId?: number
  text?: string
  senderName?: string
  senderId?: string
  senderUsername?: string
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
  // Chat shape, when the adapter told us: 'group' / 'private' / undefined
  // (platform does not distinguish). The host renders it verbatim.
  const chatKind =
    msg.isGroup === true || (msg as { chatKind?: string }).chatKind === 'group'
      ? 'group'
      : msg.isGroup === false || (msg as { chatKind?: string }).chatKind === 'private'
        ? 'private'
        : undefined
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
    // Well-known provenance keys (shared/events/types.ts EVENT_META_ORIGIN_KEYS):
    // who sent it, where, and the chat shape. The host renders these, holds
    // no platform vocabulary; every listener can enrich events this way
    // without a host release.
    meta: {
      channelId,
      ...(msg.channelName ? { channel: msg.channelName } : {}),
      ...(chatKind ? { channelKind: chatKind } : {}),
      ...(msg.senderName
        ? { sender: msg.senderUsername ? `${msg.senderName} (@${msg.senderUsername})` : msg.senderName }
        : {}),
      ...(msg.senderId ? { senderId: msg.senderId } : {}),
      ...(msg.threadId !== undefined ? { threadId: String(msg.threadId) } : {}),
      ...(msg.mentionsBot === true ? { mentionsBot: 'true' } : {}),
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

    // Optional label endpoint: the host asks "what are these channels called?"
    // and renders the answers (a group title, a contact name). Keys the
    // plugin has not seen come back absent; the host then falls back to the
    // raw key. Same Bearer gate as /action — it drives the plugin, after all.
    if (req.url === '/channel_labels' && req.method === 'POST') {
      const presented = req.headers.authorization ?? ''
      if (presented !== `Bearer ${CONTROL_TOKEN}`) {
        send(401, { error: 'unauthorized' })
        return
      }
      const body = (await readJson(req)) as { channelKeys?: unknown } | null
      const keys = Array.isArray(body?.channelKeys)
        ? body.channelKeys.filter((key): key is string => typeof key === 'string').slice(0, 100)
        : []
      const prefix = `message://${PLUGIN_ID}/`
      const labels: Record<string, string> = {}
      for (const key of keys) {
        if (!key.startsWith(prefix)) continue
        const label = channelLabels[decodeURIComponent(key.slice(prefix.length))]
        if (label) labels[key] = label
      }
      send(200, { labels })
      return
    }

    if (req.url !== '/action' || req.method !== 'POST') {
      send(404, { error: 'not_found' })
      return
    }

    // Everything below drives the plugin, so it needs the token from
    // control.json. Without this the published token would be decoration: any
    // local process could post /action on the user's behalf.
    const presented = req.headers.authorization ?? ''
    if (presented !== `Bearer ${CONTROL_TOKEN}`) {
      send(401, { error: 'unauthorized' })
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

      // `reply` carries the same shape: the host has already filled the origin's
      // channelId (repliesToOrigin), so it is a send to a known channel.
      if (action === 'send_message' || action === 'reply') {
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

  // Publish the control service so Craft can reach us (`craft-deps/1` contract).
  // The port is ephemeral and the token is per-process: Craft reads both from
  // this file, so no port is ever guessed and a stale file cannot impersonate a
  // fresh process. mode 600 — the token is a bearer credential for 127.0.0.1.
  if (DATA_DIR) {
    try {
      mkdirSync(DATA_DIR, { recursive: true })
      writeFileSync(
        join(DATA_DIR, 'control.json'),
        `${JSON.stringify({ port, token: CONTROL_TOKEN, pid: process.pid }, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'control_json_failed',
          message: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  }
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
    noteChannelLabel(msg)
    const event = toEvent(msg)
    if (event) await publish(event)
  })
  try {
    await adapter.initialize?.(config)
    connected = true
    // Prove liveness to Craft. Without this the host has no way to tell
    // "connected" from "still starting", and the plugin sits in `starting`
    // until the readiness timeout downgrades it to `degraded`.
    await fetch(`${EVENTS_URL}/health`, {
      headers: { authorization: `Bearer ${EVENTS_TOKEN}` },
    }).catch(() => undefined)
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
