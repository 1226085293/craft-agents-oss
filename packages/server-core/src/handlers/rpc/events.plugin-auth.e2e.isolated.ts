/**
 * End-to-end sign-in check: real RPC handlers → real supervisor → real plugin
 * process → fake platform.
 *
 * Real (nothing on this path is a stand-in):
 *   - `registerEventsHandlers` and the four `events.PLUGIN_AUTH_*` channels,
 *   - `createAuthFinisher` and its write-once ledger,
 *   - `EventService.saveListenerConfig` → `setListenerConfig` → listeners.json,
 *   - `ListenerSupervisor` (spawn, ready timeout, restartWithFallback),
 *   - `plugins/<id>/program/serve.ts` running as a child process,
 *   - `<dataDir>/config.json`, written by the supervisor, read back by the plugin.
 *
 * Faked, and only this:
 *   - iLink cloud (`ilinkai.weixin.qq.com`): a local HTTP server handing out a QR
 *     and answering `get_qrcode_status` from a script,
 *   - the Baileys worker bundle for WhatsApp: a script speaking the same NDJSON
 *     protocol as `packages/messaging-whatsapp-worker`.
 *
 * Handlers are registered ONCE for the whole file. That is not tidiness: the
 * write-once ledger lives in the closure `registerEventsHandlers` builds, so a
 * per-test registration would give each test a fresh ledger and the idempotence
 * assertions would prove nothing.
 *
 * The single process-wide mock is the workspace lookup (as in the isolated test
 * suite), pointing at a temp dir so the developer's config is never touched.
 *
 * `.isolated.ts` for the same reason as `events.plugin-auth.isolated.ts`:
 * `mock.module` is process-wide in bun, so this must run in its own process.
 */

import { afterAll, beforeAll, describe, it, expect, mock, setDefaultTimeout } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The real supervisor waits `manifest.runtime.readyTimeoutMs ?? 20000` before
// deciding a plugin that has not reported health is needs_auth/degraded.
setDefaultTimeout(180_000)

// Repo root, derived so the file works in any checkout/worktree.
const REPO = join(import.meta.dir, '..', '..', '..', '..', '..')
const REPO_URL = `file:///${REPO.replace(/\\/g, '/')}`

const workspaceId = 'ws-e2e-auth'
const root = mkdtempSync(join(tmpdir(), 'craft-e2e-auth-'))
const workspaceRoot = join(root, 'ws')

const actualSharedConfigModule = await import(`${REPO_URL}/packages/shared/src/config/index.ts`)
mock.module('@craft-agent/shared/config', () => ({
  ...actualSharedConfigModule,
  getWorkspaceByNameOrId: (nameOrId: string) =>
    nameOrId === workspaceId
      ? { id: workspaceId, name: 'E2E auth', slug: 'e2e-auth', rootPath: workspaceRoot, createdAt: 0 }
      : null,
}))

const { RPC_CHANNELS } = await import(`${REPO_URL}/packages/shared/src/protocol/index.ts`)
const { registerEventsHandlers } = await import(`${REPO_URL}/packages/server-core/src/handlers/rpc/events.ts`)
const { resetEventServicesForTest } = await import(`${REPO_URL}/packages/server-core/src/events/event-service.ts`)

// ---------------------------------------------------------------------------
// One registration for the whole file (see the header comment)
// ---------------------------------------------------------------------------

interface Pushed {
  channel: string
  args: any[]
}
type HandlerFn = (...args: any[]) => Promise<any>

const handlers = new Map<string, HandlerFn>()
const pushes: Pushed[] = []

const server = {
  handle(channel: string, handler: HandlerFn) {
    handlers.set(channel, handler)
  },
  push(channel: string, _target: unknown, ...args: any[]) {
    pushes.push({ channel, args })
  },
  async invokeClient() {},
  hasClientCapability() {
    return false
  },
  findClientsWithCapability() {
    return []
  },
}

registerEventsHandlers(server as any, {
  sessionManager: {},
  oauthFlowStore: {},
  platform: {
    appRootPath: '/',
    resourcesPath: '/',
    isPackaged: false,
    appVersion: '0.0.0-e2e',
    isDebugMode: true,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    imageProcessor: { getMetadata: async () => null, process: async () => Buffer.from('') },
  },
} as any)

const handler = (channel: string): HandlerFn => {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`handler not registered: ${channel}`)
  return fn
}
const ctx = { clientId: 'c1', workspaceId, webContentsId: 101 }

/** Pushes recorded since the last call. */
function drain(): Pushed[] {
  return pushes.splice(0, pushes.length)
}
function authPushes(list: Pushed[]) {
  return list.filter((p) => p.channel === RPC_CHANNELS.events.PLUGIN_AUTH_EVENT)
}
function listenerChanges(list: Pushed[], reason: string) {
  return list.filter((p) => p.channel === RPC_CHANNELS.events.LISTENER_CHANGED && p.args[1]?.reason === reason)
}

// ---------------------------------------------------------------------------
// The fake iLink cloud
// ---------------------------------------------------------------------------

const ilink = {
  statuses: [] as string[],
  qrIssued: 0,
  statusPolls: 0,
  botToken: 'e2e-bot-token',
  botId: 'e2e-bot-id',
  server: null as Server | null,
  baseUrl: '',
}

function startFakeIlink(): Promise<void> {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const json = (payload: unknown) => {
        const body = JSON.stringify(payload)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(body)
      }

      if (url.pathname.includes('/get_bot_qrcode')) {
        ilink.qrIssued += 1
        json({
          qrcode: `qr-ticket-${ilink.qrIssued}`,
          qrcode_img_content: `https://liteapp.weixin.qq.com/q/e2e-${ilink.qrIssued}`,
        })
        return
      }

      if (url.pathname.includes('/get_qrcode_status')) {
        ilink.statusPolls += 1
        const next = ilink.statuses.shift() ?? 'wait'
        if (next === 'confirmed') {
          json({
            status: 'confirmed',
            bot_token: ilink.botToken,
            ilink_bot_id: ilink.botId,
            baseurl: ilink.baseUrl,
            ilink_user_id: 'e2e-user',
          })
          return
        }
        json({ status: next })
        return
      }

      if (req.method === 'POST') {
        json({ ret: 0, msgs: [], get_updates_buf: '' })
        return
      }
      json({ ret: 0 })
    })
    s.listen(0, '127.0.0.1', () => {
      const address = s.address()
      const port = typeof address === 'object' && address ? address.port : 0
      ilink.baseUrl = `http://127.0.0.1:${port}`
      ilink.server = s
      resolve()
    })
  })
}

// ---------------------------------------------------------------------------
// Workspace scaffolding: the real plugin, adopted into a temp workspace
// ---------------------------------------------------------------------------

function linkNodeModules(pluginDir: string): void {
  // The plugins import `@craft-agent/*` at runtime; a copy outside the repo
  // cannot resolve those, so the copy gets a junction to the repo's tree.
  execFileSync('cmd', ['/c', 'mklink', '/J', join(pluginDir, 'node_modules'), join(REPO, 'node_modules')], {
    stdio: 'ignore',
  })
}

function adopt(id: string, config: Record<string, unknown>): void {
  const to = join(workspaceRoot, 'events', id)
  mkdirSync(join(workspaceRoot, 'events'), { recursive: true })
  cpSync(join(REPO, 'plugins', id), to, { recursive: true })
  linkNodeModules(to)
  writeListenerState(id, true, config)
}

function writeListenerState(id: string, enabled: boolean, config: Record<string, unknown>): void {
  mkdirSync(join(workspaceRoot, 'events-data'), { recursive: true })
  const path = join(workspaceRoot, 'events-data', 'listeners.json')
  const state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { version: 1, listeners: {} }
  state.listeners[id] = { ...(state.listeners[id] ?? {}), enabled, config }
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

function savedConfig(id: string): Record<string, unknown> {
  const path = join(workspaceRoot, 'events-data', 'listeners.json')
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, 'utf8')).listeners[id]?.config ?? {}
}

const dataDir = (id: string) => join(workspaceRoot, 'events-data', id)
const configPath = (id: string) => join(dataDir(id), 'config.json')

function pluginConfigFile(id: string): Record<string, unknown> | null {
  const path = configPath(id)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function configFileStat(id: string): { mtimeMs: number; size: number; mode: number } | null {
  const path = configPath(id)
  if (!existsSync(path)) return null
  const s = statSync(path)
  return { mtimeMs: s.mtimeMs, size: s.size, mode: s.mode & 0o777 }
}

function procLog(id: string): string {
  const path = join(dataDir(id), 'proc.log')
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

async function waitFor<T>(
  label: string,
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last = await read()
  while (Date.now() < deadline) {
    if (predicate(last)) return last
    await Bun.sleep(100)
    last = await read()
  }
  throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(last)}`)
}

async function stopAllListeners(): Promise<void> {
  const view = await handler(RPC_CHANNELS.events.LIST_LISTENERS)(ctx, workspaceId, true)
  for (const listener of view) {
    if (listener.status?.state !== 'stopped') {
      await handler(RPC_CHANNELS.events.SET_LISTENER_ENABLED)(ctx, workspaceId, listener.id, false)
    }
  }
}

beforeAll(async () => {
  mkdirSync(join(workspaceRoot, 'events'), { recursive: true })
  mkdirSync(join(workspaceRoot, 'config'), { recursive: true })
  // A workspace folder is one carrying config.json.
  writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify({ name: 'E2E auth' }), 'utf8')
  await startFakeIlink()
})

afterAll(async () => {
  try {
    await stopAllListeners()
  } catch {
    /* best effort */
  }
  await new Promise<void>((resolve) => ilink.server?.close(() => resolve()))
  resetEventServicesForTest()
  await Bun.sleep(500)
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // Windows keeps junctions/sqlite handles briefly; leftovers are harmless.
  }
  mock.restore()
})

// ---------------------------------------------------------------------------
// WeChat: real plugin, fake iLink, real handlers + supervisor
// ---------------------------------------------------------------------------

describe('wechat: QR → scan → connected → config.json → plugin restart', () => {
  const id = 'wechat'
  /** Every supervisor state the app was told about, in order. */
  const states: string[] = []

  it('comes up as needs_auth with no credentials, and /auth/start yields a QR', async () => {
    drain()
    adopt(id, { baseUrl: ilink.baseUrl })
    const enable = await handler(RPC_CHANNELS.events.SET_LISTENER_ENABLED)(ctx, workspaceId, id, true)
    expect(enable.state).toBe('starting')

    // The supervisor's own ready-timeout path is what decides needs_auth; this
    // is the production 20s default, not a shortened one.
    const settled = await waitFor(
      'supervisor to settle',
      async () => {
        const view = await handler(RPC_CHANNELS.events.GET_LISTENER)(ctx, workspaceId, id)
        const next = view.status.state as string
        if (states[states.length - 1] !== next) states.push(next)
        return next
      },
      (state) => state === 'needs_auth' || state === 'degraded' || state === 'failed',
      40_000,
    )
    expect(settled).toBe('needs_auth')
    expect(states).toEqual(['starting', 'needs_auth'])

    // No credential yet. The supervisor writes <dataDir>/config.json on every
    // start (that is how the saved config reaches the plugin), so the file
    // exists — what must be absent is the token the sign-in will produce.
    const beforeSignIn = pluginConfigFile(id)
    expect(beforeSignIn).toEqual({ baseUrl: ilink.baseUrl })

    // The dialog's real first call.
    const start = await handler(RPC_CHANNELS.events.PLUGIN_AUTH_START)(ctx, workspaceId, id)
    expect(start.ok).toBe(true)
    expect(start.state.phase).toBe('awaiting')
    expect(start.state.qr).toMatch(/^https:\/\/liteapp\.weixin\.qq\.com\//)
    expect(ilink.qrIssued).toBe(1)
    // The credential never travels to the renderer.
    expect('credentials' in start).toBe(false)
  })

  it('reaches connected through the poll, writes config.json once, and restarts the plugin', async () => {
    drain()

    // Script the fake platform. The plugin's own 1s poll loop consumes these;
    // our RPC polls only observe.
    ilink.statuses = ['wait', 'scaned', 'confirmed']

    // Watch the file the plugin will read, so "written once" is measured rather
    // than inferred from a poll that could not see the intermediate states.
    const samples: Array<{ mtime: number; hasToken: boolean }> = []
    let sampling = true
    const sampler = (async () => {
      while (sampling) {
        const st = configFileStat(id)
        if (st) {
          const cfg = pluginConfigFile(id)
          samples.push({ mtime: st.mtimeMs, hasToken: typeof cfg?.token === 'string' })
        }
        await Bun.sleep(30)
      }
    })()

    const poll = handler(RPC_CHANNELS.events.PLUGIN_AUTH_STATE)
    const scanned = await waitFor(
      'scanned phase via the poll',
      async () => poll(ctx, workspaceId, id),
      (res) => res.ok && res.state.phase === 'scanned',
      30_000,
    )
    expect(scanned.state.phase).toBe('scanned')

    const connected = await waitFor(
      'connected phase via the poll',
      async () => poll(ctx, workspaceId, id),
      (res) => res.ok && res.state.phase === 'connected',
      30_000,
    )
    expect(connected.state.phase).toBe('connected')
    expect('credentials' in connected).toBe(false)

    // 1. The credential landed in the plugin's saved config…
    const afterConnect = savedConfig(id)
    expect(typeof afterConnect.token).toBe('string')
    expect(JSON.parse(afterConnect.token as string)).toEqual({
      botToken: ilink.botToken,
      baseUrl: ilink.baseUrl,
      botId: ilink.botId,
      userId: 'e2e-user',
    })
    // …merged, not replacing: the baseUrl the run was set up with survives.
    expect(afterConnect.baseUrl).toBe(ilink.baseUrl)

    // 2. …and the supervisor wrote it as <dataDir>/config.json for the plugin.
    const onDisk = await waitFor(
      '<dataDir>/config.json',
      async () => pluginConfigFile(id),
      (cfg) => cfg !== null && typeof cfg.token === 'string',
      15_000,
    )
    expect(onDisk!.token).toBe(afterConnect.token)
    expect(onDisk!.baseUrl).toBe(ilink.baseUrl)

    // 3. The plugin was restarted holding it: with credentials present the
    //    adapter now starts and reports health, so the plugin reaches `running`
    //    (it could only ever be needs_auth before the token existed).
    const view = await waitFor(
      'plugin running on the new credentials',
      async () => handler(RPC_CHANNELS.events.GET_LISTENER)(ctx, workspaceId, id),
      (v) => v.status.state === 'running' || v.status.state === 'failed' || v.status.state === 'degraded',
      60_000,
    )
    expect(view.status.state).toBe('running')

    // The plugin's own log proves the restart read the token: "credentials
    // missing" appears exactly once, from the first (pre-sign-in) start.
    const log = procLog(id)
    expect((log.match(/WeChat credentials are missing/g) ?? []).length).toBe(1)

    // 4. Written exactly once. Count the distinct mtimes observed between the
    //    first sample without a token and the last one with it: a second merge
    //    of the same credentials would show up as a second mtime.
    await Bun.sleep(1500)
    sampling = false
    await sampler
    const firstWithToken = samples.findIndex((s) => s.hasToken)
    expect(firstWithToken).toBeGreaterThan(-1)
    const afterToken = samples.slice(firstWithToken)
    const distinctMtimes = [...new Set(afterToken.map((s) => s.mtime))]
    console.log('CONFIG_WRITE_SAMPLES =', JSON.stringify({ samples: samples.length, firstWithToken, distinctMtimes }))
    expect(distinctMtimes).toHaveLength(1)

    // 5. Exactly one config change reached the renderers for this sign-in.
    expect(listenerChanges(drain(), 'config')).toHaveLength(1)
  })

  it('does not write again after the post-sign-in restart, and keeps one process', async () => {
    const poll = handler(RPC_CHANNELS.events.PLUGIN_AUTH_STATE)
    drain()

    // Signing in restarts the plugin on purpose, so its own auth snapshot starts
    // over: `idle` here is the fresh process, not a lost sign-in. (The
    // "same attempt seen twice" case is pinned at handler level by
    // events.plugin-auth.isolated.ts, where no restart is involved.)
    const before = configFileStat(id)!
    const phase = (await poll(ctx, workspaceId, id)).state.phase
    expect(['idle', 'connected']).toContain(phase)

    for (let i = 0; i < 5; i += 1) {
      const res = await poll(ctx, workspaceId, id)
      expect(res.ok).toBe(true)
      await Bun.sleep(250)
    }

    // The restart itself must not merge the credentials again.
    const after = configFileStat(id)!
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.size).toBe(before.size)
    expect(listenerChanges(drain(), 'config')).toHaveLength(0)

    // And only one process is serving: the plugin publishes control.json with
    // its pid, and that pid must be one the supervisor knows about.
    const control = JSON.parse(readFileSync(join(dataDir(id), 'control.json'), 'utf8'))
    const view = await handler(RPC_CHANNELS.events.GET_LISTENER)(ctx, workspaceId, id)
    expect(control.pid).toBe(view.status.pid)
  })

  it('reads the token back after the plugin process is restarted again', async () => {
    // Toggle off/on the way the detail page does.
    await handler(RPC_CHANNELS.events.SET_LISTENER_ENABLED)(ctx, workspaceId, id, false)
    const restarted = await handler(RPC_CHANNELS.events.SET_LISTENER_ENABLED)(ctx, workspaceId, id, true)
    expect(restarted.state).toBe('starting')

    const view = await waitFor(
      'plugin up on the saved credentials',
      async () => handler(RPC_CHANNELS.events.GET_LISTENER)(ctx, workspaceId, id),
      (v) => v.status.state === 'running' || v.status.state === 'degraded' || v.status.state === 'failed' || v.status.state === 'needs_auth',
      60_000,
    )
    expect(view.status.state).toBe('running')

    // A second start with a token present must not repeat the missing-credential
    // failure: the plugin found what the host wrote.
    const log = procLog(id)
    expect((log.match(/WeChat credentials are missing/g) ?? []).length).toBe(1)

    // And the plugin's own copy on disk still holds the same token.
    const onDisk = pluginConfigFile(id)!
    expect(typeof onDisk.token).toBe('string')
    expect(onDisk.token).toBe(savedConfig(id).token)
  })

  it('a new sign-in attempt writes again (the ledger was cleared)', async () => {
    const poll = handler(RPC_CHANNELS.events.PLUGIN_AUTH_STATE)
    drain()
    const before = configFileStat(id)!

    ilink.botToken = 'e2e-bot-token-2'
    ilink.statuses = ['wait', 'confirmed']
    ilink.qrIssued = 0

    const start = await handler(RPC_CHANNELS.events.PLUGIN_AUTH_START)(ctx, workspaceId, id)
    expect(start.state.phase).toBe('awaiting')

    await waitFor(
      'second connected',
      async () => poll(ctx, workspaceId, id),
      (res) => res.ok && res.state.phase === 'connected',
      30_000,
    )

    const after = configFileStat(id)!
    expect(after.mtimeMs).not.toBe(before.mtimeMs)
    expect(JSON.parse(savedConfig(id).token as string).botToken).toBe('e2e-bot-token-2')
    expect(listenerChanges(drain(), 'config')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// WhatsApp: real plugin, fake worker, same handlers
// ---------------------------------------------------------------------------

/**
 * A stand-in for `packages/messaging-whatsapp-worker/dist/worker.cjs`.
 *
 * It speaks the same NDJSON: reads the `start` command, emits a `qr`, then —
 * on script — the `disconnected` a real Baileys socket produces right after
 * handing out a QR (515 restart-required), then `connected`.
 */
const FAKE_WORKER = `
let buffer = ''
const emit = (ev) => process.stdout.write(JSON.stringify(ev) + String.fromCharCode(10))
let started = false
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf(String.fromCharCode(10))) >= 0) {
    const line = buffer.slice(0, idx)
    buffer = buffer.slice(idx + 1)
    if (!line.trim()) continue
    const cmd = JSON.parse(line)
    if (cmd.type === 'start' && !started) {
      started = true
      emit({ type: 'ready', baileysVersion: 'e2e' })
      setTimeout(() => emit({ type: 'qr', qr: '2@e2e-wa-qr-ticket' }), 120)
      // The blip the real worker emits right after a QR: a socket close that is
      // NOT a logout, then a reconnect that hands out a fresh code.
      setTimeout(() => emit({ type: 'disconnected', loggedOut: false, reason: 'Stream Errored (restart required)' }), 500)
      setTimeout(() => emit({ type: 'qr', qr: '2@e2e-wa-qr-ticket' }), 800)
      setTimeout(() => emit({ type: 'connected', jid: 'e2e@s.whatsapp.net', name: 'E2E' }), 2600)
    }
    if (cmd.type === 'shutdown') process.exit(0)
  }
})
setInterval(() => {}, 60000)
`

describe('whatsapp: the QR survives the socket blip the worker emits right after it', () => {
  const id = 'whatsapp'

  it('never shows expired/failed between the QR and the confirmation', async () => {
    drain()
    const workerScript = join(root, 'fake-wa-worker.mjs')
    writeFileSync(workerScript, FAKE_WORKER, 'utf8')
    adopt(id, {
      workerEntry: workerScript,
      authStateDir: join(dataDir(id), 'wa-auth'),
      nodeBin: process.execPath,
    })

    await handler(RPC_CHANNELS.events.SET_LISTENER_ENABLED)(ctx, workspaceId, id, true)

    // The plugin has to be up before it can be asked to start a flow.
    await waitFor(
      'whatsapp plugin up',
      async () => handler(RPC_CHANNELS.events.GET_LISTENER)(ctx, workspaceId, id),
      (v) => v.status.state === 'needs_auth' || v.status.state === 'running' || v.status.state === 'degraded',
      60_000,
    )

    // Opening the dialog does this first (ListenerAuthDialog: start()).
    const started = await handler(RPC_CHANNELS.events.PLUGIN_AUTH_START)(ctx, workspaceId, id)
    expect(started.ok).toBe(true)

    const poll = handler(RPC_CHANNELS.events.PLUGIN_AUTH_STATE)
    const start = await waitFor(
      'whatsapp awaiting with a QR',
      async () => poll(ctx, workspaceId, id),
      (res) => res.ok && res.state.phase !== 'idle' && Boolean(res.state.qr),
      40_000,
    )
    expect(start.state.phase).toBe('awaiting')
    expect(typeof start.state.qr).toBe('string')

    // Sample across the blip (which lands ~500ms in) and up to `connected`
    // (~2.6s): the snapshot must never become expired/failed, and the QR must
    // never disappear.
    const seen: Array<{ phase: string; hasQr: boolean; detail?: string }> = []
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const res = await poll(ctx, workspaceId, id)
      if (res.ok && res.state) {
        seen.push({ phase: res.state.phase, hasQr: Boolean(res.state.qr), detail: res.state.detail })
        if (res.state.phase === 'connected') break
      }
      await Bun.sleep(100)
    }

    const phases = [...new Set(seen.map((s) => s.phase))]
    console.log('WHATSAPP_PHASES_SEEN =', JSON.stringify(phases))
    console.log(
      'WHATSAPP_RETRY_SAMPLES =',
      JSON.stringify(seen.filter((s) => (s.detail ?? '').includes('连接中断')).slice(0, 3)),
    )

    // Never expired, never failed.
    expect(seen.filter((s) => s.phase === 'failed' || s.phase === 'expired')).toEqual([])
    // The blip was observed, and it kept the code on screen saying it retries.
    const retrying = seen.filter((s) => (s.detail ?? '').includes('连接中断'))
    expect(retrying.length).toBeGreaterThan(0)
    expect(retrying.every((s) => s.hasQr)).toBe(true)
    // The code stayed on screen in every sample up to and including the last
    // live one; only the final `connected` hides it, which is the dialog's
    // intended behaviour (it swaps the code for「已连接」).
    expect(seen.filter((s) => !s.hasQr && s.phase !== 'connected')).toEqual([])
    expect(seen[seen.length - 1]!.phase).toBe('connected')
    // And it ends connected, without any user action.
    expect(seen[seen.length - 1]!.phase).toBe('connected')
  })

  it('writes nothing for whatsapp, because Baileys keeps its own auth state', async () => {
    const poll = handler(RPC_CHANNELS.events.PLUGIN_AUTH_STATE)
    drain()
    for (let i = 0; i < 3; i += 1) {
      const res = await poll(ctx, workspaceId, id)
      expect(res.state.phase).toBe('connected')
      expect('credentials' in res).toBe(false)
    }
    // No token key invented for a platform that has none.
    expect(savedConfig(id).token).toBeUndefined()
    expect(listenerChanges(drain(), 'config')).toHaveLength(0)
  })
})

export { }
