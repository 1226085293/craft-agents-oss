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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
 * sign-in flow. A fresh random token per process, published only in a mode-600
 * file beside the data dir, closes that: nothing outside this process and Craft
 * ever sees it.
 */
const CONTROL_TOKEN = randomBytes(32).toString('hex')

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
  /**
   * The plugin's own sign-in flow, when it has one.
   *
   * Craft never learns the platform protocol: it calls these four and renders
   * whatever state comes back. `start` returns as soon as there is something to
   * show — long polling happens in this process, not inside the request, so the
   * host never waits on a slow platform.
   */
  createAuth?: (options?: Record<string, unknown>) => PluginAuthLike | null
  performAction?: (
    action: string,
    args: Record<string, unknown>,
  ) => Promise<{ ok: boolean; message?: string }>
}

/** One snapshot of the sign-in flow. `credentials` is relayed to the host only. */
interface PluginAuthState {
  phase: 'idle' | 'awaiting' | 'scanned' | 'need_code' | 'connected' | 'expired' | 'failed'
  qr?: string
  code?: string
  expiresAt?: number
  detail?: string
  error?: string
  attempt?: number
  credentials?: Record<string, unknown>
}

interface PluginAuthLike {
  start: () => Promise<PluginAuthState>
  state: () => PluginAuthState
  submit: (code: string) => Promise<PluginAuthState>
  cancel: () => Promise<PluginAuthState>
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
const adapter = plugin.createAdapter?.({ config, dataDir: DATA_DIR }) ?? null
/** Null when the plugin ships no sign-in flow; /auth/* then answers 404. */
const auth = plugin.createAuth?.({ config, dataDir: DATA_DIR }) ?? null

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

/**
 * Generic sign-in finish step, fired when a plugin's own `auth_*` action
 * reports `connected`.
 *
 * It is deliberately platform-agnostic:
 *   1. persist `credentials.token` into the plugin's config file, when the
 *      flow produced any — this is how the adapter learns the credential at
 *      the next start; platforms that keep their own state on disk (Baileys)
 *      have no token and just skip this step;
 *   2. (re)initialize the main adapter IN PLACE so the process becomes
 *      healthy without a supervisor restart; a failed re-init leaves the
 *      previous adapter state untouched;
 *   3. post a health report so the host marks the listener running.
 *
 * Fire-and-forget on purpose: the page already holds the `connected` state in
 * the action result; the health report may take up to a platform round-trip.
 */
function finishPluginAuth(
  action: string,
  result: { ok: boolean; message?: string },
): void {
  if (!result.ok || !action.startsWith('auth_') || typeof result.message !== 'string') return
  let state: { phase?: string; credentials?: { token?: unknown } } | null
  try {
    state = JSON.parse(result.message)
  } catch {
    return
  }
  if (state?.phase !== 'connected' || !adapter) return
  void (async () => {
    const credentials = state!.credentials
    if (typeof credentials?.token === 'string' && CONFIG_PATH) {
      try {
        const cfg = { ...readConfig(), token: credentials.token }
        writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
        console.log(JSON.stringify({ event: 'auth_credentials_saved' }))
      } catch (error) {
        console.error(JSON.stringify({ event: 'auth_credentials_save_failed', message: String(error) }))
      }
    }
    try {
      await adapter!.initialize?.(readConfig())
      connected = true
      console.log(JSON.stringify({ event: 'auth_adapter_reinitialized' }))
    } catch {
      // Previous adapter state stays alive; the health post below reports the
      // process's own /health truth either way.
    }
    if (EVENTS_URL) {
      await fetch(`${EVENTS_URL}/health`, {
        headers: { authorization: `Bearer ${EVENTS_TOKEN}` },
      }).catch(() => undefined)
    }
  })()
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

    // Everything below drives the plugin, so it needs the token from
    // control.json. Without this the published token would be decoration: any
    // local process could post /action or start a sign-in on the user's behalf.
    const presented = req.headers.authorization ?? ''
    if (presented !== `Bearer ${CONTROL_TOKEN}`) {
      send(401, { error: 'unauthorized' })
      return
    }

    // Sign-in flow (`craft-auth/1`). 404 is the honest answer for a plugin with
    // no such flow — Craft maps it to "unsupported" rather than an error.
    if (req.url?.startsWith('/auth/')) {
      if (!auth) {
        send(404, { error: 'no_auth_flow' })
        return
      }
      const route = req.url.slice('/auth/'.length).split('?')[0]
      try {
        if (route === 'start' && req.method === 'POST') {
          send(200, await auth.start())
          return
        }
        if (route === 'state' && req.method === 'GET') {
          send(200, auth.state())
          return
        }
        if (route === 'submit' && req.method === 'POST') {
          const body = (await readJson(req)) as { code?: unknown } | null
          const code = typeof body?.code === 'string' ? body.code.trim() : ''
          if (!code) {
            send(400, { error: 'code_required' })
            return
          }
          send(200, await auth.submit(code))
          return
        }
        if (route === 'cancel' && req.method === 'POST') {
          send(200, await auth.cancel())
          return
        }
        send(404, { error: 'unknown_auth_route' })
      } catch (error) {
        // A throwing provider is a broken attempt, not a broken plugin: report
        // it as `failed` so the UI can offer "try again" instead of a dead end.
        send(200, {
          phase: 'failed',
          error: error instanceof Error ? error.message : String(error),
        })
      }
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
        const result = await plugin.performAction(action, args)
        finishPluginAuth(action, result)
        send(200, result)
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
