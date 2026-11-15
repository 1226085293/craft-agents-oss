/**
 * The idempotence has to hold on the path the app actually runs.
 *
 * `plugin-auth-finish.test.ts` drives `createAuthFinisher` directly, so it can
 * only prove the ledger works — not that the handlers use it. They used to
 * carry their own inline copy of the tail, which is exactly the failure the
 * factory exists to prevent: the ledger sat unused while the live path merged
 * the same credentials twice and pushed two `listenerChanged` events for one
 * sign-in.
 *
 * These tests therefore call the registered RPC handlers. Nothing on the sign-in
 * path is mocked except the workspace lookup: `readPluginAuth` really reads
 * `control.json`, really fetches `127.0.0.1`, and `applyAuthCredentials` really
 * writes `events-data/listeners.json` through the event service. A test-local
 * stand-in for the writer would prove nothing about production.
 *
 * `.isolated.ts` because the workspace lookup is replaced with `mock.module`,
 * which is process-wide in bun; the repo runs these files in their own process.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { RpcServer, HandlerFn, RequestContext } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { resetEventServicesForTest } from '../../events/event-service'
import { registerEventsHandlers } from './events'

const workspaceId = 'ws-plugin-auth-test'
const ctx: RequestContext = { clientId: 'c1', workspaceId, webContentsId: 101 }
let workspaceRoot = ''

// Partial mock: the real module, minus the one lookup that would otherwise need
// a registered workspace inside the developer's config dir.
const actualSharedConfigModule = await import('../../../../shared/src/config/index.ts')
mock.module('@craft-agent/shared/config', () => ({
  ...actualSharedConfigModule,
  getWorkspaceByNameOrId: (nameOrId: string) =>
    nameOrId === workspaceId
      ? { id: workspaceId, name: 'Plugin auth test', slug: 'plugin-auth-test', rootPath: workspaceRoot, createdAt: 0 }
      : null,
}))

interface Pushed {
  channel: string
  args: any[]
}

function createServer_() {
  const handlers = new Map<string, HandlerFn>()
  const pushes: Pushed[] = []
  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push(channel, _target, ...args) {
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
  const deps = {
    sessionManager: {},
    oauthFlowStore: {},
    platform: {
      appRootPath: '/',
      resourcesPath: '/',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      imageProcessor: { getMetadata: async () => null, process: async () => Buffer.from('') },
    },
  } as unknown as HandlerDeps

  registerEventsHandlers(server, deps)

  const handler = (channel: string): HandlerFn => {
    const fn = handlers.get(channel)
    if (!fn) throw new Error(`handler not registered: ${channel}`)
    return fn
  }
  return { handler, pushes }
}

/** What the fake plugin answers, and what it saw — one mutable relay. */
const plugin = {
  response: {} as Record<string, unknown>,
  authorization: [] as Array<string | undefined>,
  server: null as Server | null,
  port: 0,
}

function authPushes(pushes: Pushed[]) {
  return pushes.filter((p) => p.channel === RPC_CHANNELS.events.PLUGIN_AUTH_EVENT)
}

function listenerChanges(pushes: Pushed[], reason: string) {
  return pushes.filter(
    (p) => p.channel === RPC_CHANNELS.events.LISTENER_CHANGED && p.args[1]?.reason === reason,
  )
}

const dataDir = () => join(workspaceRoot, 'events-data', 'wechat')

function savedConfig(): Record<string, unknown> {
  const path = join(workspaceRoot, 'events-data', 'listeners.json')
  // No file at all is the honest "nothing was written" — the handler only
  // creates it when it saves.
  if (!existsSync(path)) return {}
  const state = JSON.parse(readFileSync(path, 'utf8'))
  return state.listeners.wechat?.config ?? {}
}

/** The production path the handler writes through: setListenerConfig → listeners.json. */
function seedSavedConfig(config: Record<string, unknown>): void {
  mkdirSync(join(workspaceRoot, 'events-data'), { recursive: true })
  writeFileSync(
    join(workspaceRoot, 'events-data', 'listeners.json'),
    `${JSON.stringify({ version: 1, listeners: { wechat: { enabled: false, config } } }, null, 2)}\n`,
    'utf8',
  )
}

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), 'craft-auth-handler-'))
  workspaceRoot = join(root, 'ws')
  mkdirSync(join(workspaceRoot, 'events', 'wechat'), { recursive: true })
  mkdirSync(join(workspaceRoot, 'config'), { recursive: true })
  // A workspace folder is one carrying config.json, else loadStoredConfig
  // would try to scaffold it again on every lookup.
  writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify({ name: 'Plugin auth test' }), 'utf8')
  writeFileSync(
    join(workspaceRoot, 'events', 'wechat', 'manifest.json'),
    JSON.stringify({ spec: 'craft-plugin/1', id: 'wechat', name: 'WeChat', version: '1.0.0' }),
    'utf8',
  )

  plugin.response = {}
  plugin.authorization = []
  plugin.server = createServer((req, res) => {
    plugin.authorization.push(req.headers.authorization)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(plugin.response))
  })
  await new Promise<void>((resolve) => plugin.server!.listen(0, '127.0.0.1', resolve))
  const address = plugin.server.address()
  plugin.port = typeof address === 'object' && address ? address.port : 0

  // Exactly the file a live plugin publishes for the host to talk to.
  mkdirSync(dataDir(), { recursive: true })
  writeFileSync(
    join(dataDir(), 'control.json'),
    JSON.stringify({ port: plugin.port, token: 'control-token' }),
    'utf8',
  )
})

afterEach(async () => {
  resetEventServicesForTest()
  const server = plugin.server
  plugin.server = null
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  try {
    rmSync(join(workspaceRoot, '..'), { recursive: true, force: true })
  } catch {
    // Windows keeps sqlite -wal handles briefly; leftovers are harmless.
  }
})

describe('the registered sign-in handlers', () => {
  it('persist and broadcast once when the poll sees the same connected twice', async () => {
    const { handler, pushes } = createServer_()
    const pollState = handler(RPC_CHANNELS.events.PLUGIN_AUTH_STATE)

    // The same attempt, reported with credentials both times — the shape that
    // used to write and broadcast twice.
    plugin.response = { phase: 'connected', attempt: 1, credentials: { token: 'poll-token' } }
    const first = await pollState(ctx, workspaceId, 'wechat')
    const second = await pollState(ctx, workspaceId, 'wechat')

    // The real store, written by the real handler.
    expect(savedConfig().token).toBe('poll-token')
    expect(authPushes(pushes)).toHaveLength(1)
    expect(listenerChanges(pushes, 'config')).toHaveLength(1)

    // The renderer still gets the snapshot, never the credential.
    expect(first.state.phase).toBe('connected')
    expect(second.state.phase).toBe('connected')
    expect('credentials' in first).toBe(false)

    // Proof it went through control.json + loopback, not a shortcut.
    expect(plugin.authorization).toEqual(['Bearer control-token', 'Bearer control-token'])
  })

  it('keeps a field the person already filled in', async () => {
    seedSavedConfig({ email: 'me@example.test' })
    const { handler } = createServer_()

    plugin.response = { phase: 'connected', attempt: 1, credentials: { token: 't' } }
    await handler(RPC_CHANNELS.events.PLUGIN_AUTH_STATE)(ctx, workspaceId, 'wechat')

    expect(savedConfig()).toEqual({ email: 'me@example.test', token: 't' })
  })

  it('writes again when a new attempt connects, because the ledger was cleared', async () => {
    const { handler, pushes } = createServer_()
    const pollState = handler(RPC_CHANNELS.events.PLUGIN_AUTH_STATE)

    plugin.response = { phase: 'connected', attempt: 1, credentials: { token: 'first' } }
    await pollState(ctx, workspaceId, 'wechat')

    // A fresh flow: the plugin reports a new attempt that has not connected yet.
    plugin.response = { phase: 'awaiting', attempt: 2, qr: 'qr-2' }
    await pollState(ctx, workspaceId, 'wechat')

    plugin.response = { phase: 'connected', attempt: 2, credentials: { token: 'second' } }
    await pollState(ctx, workspaceId, 'wechat')

    expect(savedConfig().token).toBe('second')
    expect(listenerChanges(pushes, 'config')).toHaveLength(2)
    // awaiting + two connected sightings.
    expect(authPushes(pushes).map((p) => p.args[1].phase)).toEqual(['connected', 'awaiting', 'connected'])
  })

  it('a failing plugin leaves nothing written and nothing broadcast', async () => {
    const { handler, pushes } = createServer_()
    const pollState = handler(RPC_CHANNELS.events.PLUGIN_AUTH_STATE)

    plugin.response = { phase: 'failed', attempt: 1, error: '扫码失败' }
    writeFileSync(join(dataDir(), 'control.json'), JSON.stringify({ port: plugin.port, token: 'control-token' }))

    const result = await pollState(ctx, workspaceId, 'wechat')

    expect(result.ok).toBe(true)
    expect(savedConfig()).toEqual({})
    expect(listenerChanges(pushes, 'config')).toHaveLength(0)
    expect(authPushes(pushes).map((p) => p.args[1].phase)).toEqual(['failed'])
  })
})
