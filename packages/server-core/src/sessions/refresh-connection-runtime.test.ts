import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveBackendContext } from '@craft-agent/shared/agent/backend'
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces'
import { SessionManager, createManagedSession, gatewayRouteDeps, applyGatewayStrategy } from './SessionManager.ts'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import * as llmStorage from '@craft-agent/shared/config/storage'
import { buildRestartRequiredSignature } from './runtime-config.ts'

// Regression coverage for the stale-Pi-subprocess bug where toggling
// `supportsImages` on a custom-endpoint model wrote to disk but never reached
// the live agent.
//
// Two failure modes are guarded here:
//   1. `getOrCreateAgent` deferred refresh whenever `managed.isProcessing` was
//      true, but `sendMessage` flips that flag *before* calling
//      `getOrCreateAgent` — which made the refresh branch dead code on the
//      send path. The new gate uses only `agent.isProcessing()`.
//   2. Saving a connection had no notification path to active sessions, so
//      capability changes only propagated lazily after the next send.
//      `refreshConnectionRuntime` now pushes updates from the SAVE handler.

interface AgentStub {
  isProcessing: () => boolean
  updateRuntimeConfig: jest.Mock
  dispose: () => void
  disposeForRestart?: () => Promise<void>
}

/** The group every injected session is routed through in these tests. */
const STRATEGY_ID = 'auto'

function createAgentStub(opts: {
  isProcessing?: boolean
  refreshSucceeds?: boolean
  refreshDelayMs?: number
} = {}): AgentStub {
  const delay = opts.refreshDelayMs ?? 0
  const result = opts.refreshSucceeds ?? true
  return {
    isProcessing: () => opts.isProcessing ?? false,
    updateRuntimeConfig: jest.fn().mockImplementation(async () => {
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
      return result
    }),
    dispose: () => { /* no-op for tests */ },
  }
}

function injectSession(
  sm: SessionManager,
  id: string,
  workspaceRoot: string,
  llmConnection: string,
  agent: AgentStub | null,
  opts: { backendRuntimeSignature?: string; backendRestartSignature?: string; isProcessing?: boolean } = {},
) {
  const workspace = {
    id: 'ws_test',
    name: 'Test Workspace',
    rootPath: workspaceRoot,
    createdAt: Date.now(),
  }
  const managed = createManagedSession(
    { id, name: id, llmConnection },
    workspace as never,
    { messagesLoaded: true },
  ) as unknown as { agent: AgentStub | null; backendRuntimeSignature?: string; backendRestartSignature?: string; isProcessing: boolean; llmConnection?: string; strategy?: string }
  managed.agent = agent
  // Force a stale runtime signature so the helper's comparison always reaches
  // the refresh branch — the signature it computes from real disk config will
  // never equal this sentinel.
  managed.backendRuntimeSignature = opts.backendRuntimeSignature ?? '__stale_runtime_signature_for_test__'
  // Pre-compute the restart signature against the same resolution the helper
  // will use, so by default tests route through the in-place refresh path.
  // Tests that want the restart-required path pass an explicit sentinel.
  if (opts.backendRestartSignature !== undefined) {
    managed.backendRestartSignature = opts.backendRestartSignature
  } else {
    const workspaceConfig = loadWorkspaceConfig(workspaceRoot)
    // Same resolution the helper performs, including the gateway rewrite — the
    // restart signature is compared against what the helper will compute, so
    // both sides must see the routed context.
    const routed = applyGatewayStrategy(
      resolveBackendContext({
        sessionConnectionSlug: llmConnection,
        workspaceDefaultConnectionSlug: workspaceConfig?.defaults?.defaultLlmConnection,
      }),
      STRATEGY_ID,
    )
    const ctx = routed ?? resolveBackendContext({
      sessionConnectionSlug: llmConnection,
      workspaceDefaultConnectionSlug: workspaceConfig?.defaults?.defaultLlmConnection,
    })
    managed.backendRestartSignature = buildRestartRequiredSignature({
      connection: ctx.connection,
      provider: ctx.provider,
      authType: ctx.authType,
      resolvedModel: ctx.resolvedModel,
    })
  }
  managed.isProcessing = opts.isProcessing ?? false
  managed.llmConnection = llmConnection
  // Every refresh path now needs a route; without one the helper leaves the
  // session alone (there is no direct connection to refresh into).
  managed.strategy = STRATEGY_ID
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
  return managed
}

describe('refreshConnectionRuntime', () => {
  let tmpRoot: string
  let sm: SessionManager
  let keySpy: ReturnType<typeof jest.spyOn>
  let connSpy: ReturnType<typeof jest.spyOn>

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-refresh-'))
    sm = new SessionManager()
    // Arm a route: a session runtime is only refreshable through a strategy
    // group now, so without one every case below would be a no-op.
    gatewayRouteDeps.runtime = {
      running: true,
      enabled: true,
      baseUrl: 'http://127.0.0.1:8799',
      noteRouteRefusal: () => {},
    } as never
    gatewayRouteDeps.config = {
      strategies: [{ id: STRATEGY_ID, type: 'round_robin', modelAliases: { 'pub-a': 'pub-a' } }],
    } as never
    // Tests run on the developer's machine where the resolved connection (via
    // the real default-connection fallback) may carry a live API key. Pin the
    // fingerprint source to "no key" so injected pre-rotation signatures stay
    // comparable; individual tests opt in with a key via `keySpy`.
    keySpy = jest.spyOn(getCredentialManager(), 'getLlmApiKey').mockResolvedValue(null)
    // `resolveSessionConnection` falls back to the global default connection,
    // which reads the developer's real ~/.craft-agent config. Pin a synthetic
    // connection so the route guard can resolve one regardless of host config.
    connSpy = jest.spyOn(llmStorage, 'getLlmConnection').mockImplementation((slug) => ({
      slug: slug || 'default',
      name: 'test',
      providerType: 'pi_compat',
      authType: 'api_key',
      defaultModel: 'pub-a',
      models: [],
      createdAt: 0,
    }))
  })

  afterEach(() => {
    keySpy.mockRestore()
    connSpy.mockRestore()
    delete gatewayRouteDeps.runtime
    delete gatewayRouteDeps.config
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('pushes updateRuntimeConfig to sessions on the matching connection slug', async () => {
    const matchingAgent = createAgentStub()
    const otherAgent = createAgentStub()
    injectSession(sm, 'matching', tmpRoot, 'slug-A', matchingAgent)
    injectSession(sm, 'other', tmpRoot, 'slug-B', otherAgent)

    await sm.refreshConnectionRuntime('slug-A')

    expect(matchingAgent.updateRuntimeConfig).toHaveBeenCalledTimes(1)
    expect(otherAgent.updateRuntimeConfig).not.toHaveBeenCalled()
  })

  it('skips sessions whose agent is mid-stream (defers, does not yank)', async () => {
    const busyAgent = createAgentStub({ isProcessing: true })
    injectSession(sm, 'busy', tmpRoot, 'slug-A', busyAgent)

    await sm.refreshConnectionRuntime('slug-A')

    expect(busyAgent.updateRuntimeConfig).not.toHaveBeenCalled()
  })

  it('does not defer just because managed.isProcessing is true (Fix 1 regression)', async () => {
    // sendMessage flips managed.isProcessing=true *before* calling
    // getOrCreateAgent → tryRefreshAgentRuntime. The pre-fix gate
    // `managed.isProcessing || agent.isProcessing()` was therefore always true
    // on the send path, making the refresh branch dead code. The fix narrows
    // the gate to `agent.isProcessing()` only — which is what actually means
    // "an in-flight stream we shouldn't yank."
    const idleAgent = createAgentStub({ isProcessing: false })
    injectSession(sm, 'sending', tmpRoot, 'slug-A', idleAgent, { isProcessing: true })

    await sm.refreshConnectionRuntime('slug-A')

    expect(idleAgent.updateRuntimeConfig).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when there is no agent yet (cold session)', async () => {
    injectSession(sm, 'cold', tmpRoot, 'slug-A', null)

    await expect(sm.refreshConnectionRuntime('slug-A')).resolves.toBeUndefined()
  })

  it('disposes the runtime when in-place refresh fails so the next send rebuilds it', async () => {
    const failingAgent = createAgentStub({ refreshSucceeds: false })
    const managed = injectSession(sm, 'failing', tmpRoot, 'slug-A', failingAgent)

    await sm.refreshConnectionRuntime('slug-A')

    expect(failingAgent.updateRuntimeConfig).toHaveBeenCalledTimes(1)
    expect(managed.agent).toBeNull()
  })

  it('disposes the runtime when the api key fingerprint appears (credential rotation)', async () => {
    // Regression: a rotated API key must not be pushed via update_runtime_config
    // (it carries no key material). The restart signature now fingerprints the
    // current key, so a session spawned with a pre-rotation signature must be
    // disposed and recreated to pick up the new credential.
    keySpy.mockResolvedValue('rotated-key-secret')
    const agent = createAgentStub()
    const managed = injectSession(sm, 'key-rotated', tmpRoot, 'slug-A', agent)

    await sm.refreshConnectionRuntime('slug-A')

    expect(agent.updateRuntimeConfig).not.toHaveBeenCalled()
    expect(managed.agent).toBeNull()
  })

  it('skips in-place refresh and forces recreation when a restart-required field changed', async () => {
    // `update_runtime_config` cannot propagate `piAuthProvider`, slug,
    // providerType, or authType cleanly. When any of those drift, the helper
    // must dispose the runtime instead of marking it refreshed (which would
    // record the new signature against a stale subprocess).
    const agent = createAgentStub()
    const managed = injectSession(sm, 'auth-changed', tmpRoot, 'slug-A', agent, {
      backendRestartSignature: '__stale_restart_signature__',
    })

    await sm.refreshConnectionRuntime('slug-A')

    expect(agent.updateRuntimeConfig).not.toHaveBeenCalled()
    expect(managed.agent).toBeNull()
  })

  it('serializes concurrent refresh requests via the per-session mutex', async () => {
    // SAVE handler is fire-and-forget (Finding 1) so its refresh can be
    // mid-flight when sendMessage triggers another via getOrCreateAgent.
    // Without a mutex, both fire updateRuntimeConfig and the subprocess can
    // race a chat against the still-pending update.
    //
    // The first call holds the lock long enough for the second to see it,
    // wait, and re-evaluate from the post-refresh state — at which point the
    // signature matches and the second call is a no-op.
    const agent = createAgentStub({ refreshDelayMs: 50 })
    injectSession(sm, 'concurrent', tmpRoot, 'slug-A', agent)

    const [first, second] = await Promise.all([
      sm.refreshConnectionRuntime('slug-A'),
      sm.refreshConnectionRuntime('slug-A'),
    ])

    expect(first).toBeUndefined()
    expect(second).toBeUndefined()
    // Only one updateRuntimeConfig — the second call awaited the first via
    // the mutex, then saw matching signatures and bailed.
    expect(agent.updateRuntimeConfig).toHaveBeenCalledTimes(1)
  })

  it('records customModels with the per-model supportsImages flag in the IPC payload', async () => {
    // End-to-end shape check: when the session's connection resolves to a
    // pi_compat connection with explicit per-model `supportsImages`, the
    // helper must forward that field on `customModels` so the Pi subprocess
    // can re-register the model with `input: ['text', 'image']`.
    const agent = createAgentStub()
    injectSession(sm, 'shape-check', tmpRoot, 'slug-A', agent)

    await sm.refreshConnectionRuntime('slug-A')

    expect(agent.updateRuntimeConfig).toHaveBeenCalledTimes(1)
    const payload = agent.updateRuntimeConfig.mock.calls[0]?.[0]
    expect(payload).toBeDefined()
    expect(payload).toMatchObject({
      model: expect.any(String),
      runtime: expect.any(Object),
    })
    // The runtime envelope mirrors what `pi-agent.ts:requestRuntimeConfigUpdate`
    // unpacks — `customModels` shape preserves `supportsImages` when set.
    if (payload.runtime?.customModels) {
      for (const m of payload.runtime.customModels) {
        if (typeof m === 'object') {
          expect(typeof m.id).toBe('string')
          if ('supportsImages' in m) {
            expect(typeof m.supportsImages).toBe('boolean')
          }
        }
      }
    }
  })

  it('refreshGatewayRuntime applies the configured window and pushes it to the active session UI', async () => {
    const agent = createAgentStub()
    const managed = injectSession(sm, 'gw-context', tmpRoot, 'slug-A', agent) as unknown as {
      tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number; contextWindow?: number }
    }
    managed.tokenUsage = { inputTokens: 40_000, outputTokens: 0, totalTokens: 40_000, contextWindow: 1_000_000 }
    gatewayRouteDeps.config = {
      strategies: [{
        id: STRATEGY_ID,
        type: 'round_robin',
        modelAliases: { 'claude-sonnet-5': 'claude-sonnet-5' },
        members: [{ provider: 'provider', model: 'claude-sonnet-5' }],
      }],
      providers: [{
        id: 'provider',
        modelOptions: { 'claude-sonnet-5': { contextWindow: 256_000 } },
      }],
    } as never
    const events: any[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))

    await sm.refreshGatewayRuntime()

    expect(agent.updateRuntimeConfig).toHaveBeenCalledTimes(1)
    expect(agent.updateRuntimeConfig.mock.calls[0]?.[0].runtime?.customModels).toContainEqual({
      id: 'claude-sonnet-5',
      contextWindow: 256_000,
    })
    expect(managed.tokenUsage?.contextWindow).toBe(256_000)
    expect(events).toContainEqual({
      type: 'usage_update',
      sessionId: 'gw-context',
      tokenUsage: { inputTokens: 40_000, contextWindow: 256_000 },
    })
  })

  it('refreshGatewayRuntime pushes to every strategy-routed session regardless of connection slug', async () => {
    // A group's per-model capabilities live in llm-config.json, not in any
    // connection, so the gateway refresh must not be keyed on a slug.
    const sessionA = createAgentStub()
    const sessionB = createAgentStub()
    injectSession(sm, 'gw-a', tmpRoot, 'slug-A', sessionA)
    injectSession(sm, 'gw-b', tmpRoot, 'slug-B', sessionB)

    await sm.refreshGatewayRuntime()

    expect(sessionA.updateRuntimeConfig).toHaveBeenCalledTimes(1)
    expect(sessionB.updateRuntimeConfig).toHaveBeenCalledTimes(1)
  })

  it('refreshGatewayRuntime skips sessions that are not strategy-routed', async () => {
    const routed = createAgentStub()
    const direct = createAgentStub()
    const directManaged = injectSession(sm, 'gw-direct', tmpRoot, 'slug-A', direct)
    injectSession(sm, 'gw-routed', tmpRoot, 'slug-A', routed)
    // A session without a strategy routes through a direct connection, not the
    // gateway — its capabilities are governed by llmConnections, not llm-config.
    ;(directManaged as { strategy?: string }).strategy = undefined

    await sm.refreshGatewayRuntime()

    expect(routed.updateRuntimeConfig).toHaveBeenCalledTimes(1)
    expect(direct.updateRuntimeConfig).not.toHaveBeenCalled()
  })
})
