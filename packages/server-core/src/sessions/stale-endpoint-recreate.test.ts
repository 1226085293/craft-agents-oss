import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionManager, createManagedSession } from './SessionManager.ts'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import { CONFIG_DIR } from '@craft-agent/shared/config/paths'

/**
 * Regression coverage for the 2026-10-15 `261014-misty-wren` incident.
 *
 * A session's LLM endpoint was repointed at a temporary local capture proxy
 * (`http://127.0.0.1:8001/v1`). When the proxy was killed and config.json was
 * restored to `http://localhost:8000/v1`, nothing propagated the change to the
 * already-running pi-agent-server subprocess — so every retry kept hitting the
 * dead port and the turn failed forever (9 consecutive `Connection error.`
 * retries, never recovering, while a fresh session on the same connection
 * worked fine).
 *
 * Root cause: `baseUrl` was only part of `buildBackendRuntimeSignature` (the
 * in-place path). But `update_runtime_config` cannot re-route an
 * already-created `AgentSession` — the subprocess re-registers the
 * custom-endpoint provider with the new URL, yet the live session keeps
 * resolving models through the object it captured at creation. So the new URL
 * only ever reached the NEXT session.
 *
 * The fix moves `baseUrl` into `buildRestartRequiredSignature`, so a drifted
 * endpoint forces dispose + recreate instead of a no-op in-place refresh.
 *
 * These tests run in a subprocess with an isolated CRAFT_CONFIG_DIR so the
 * global `getLlmConnection()` store reads a fixture we control.
 */

const BASE_URL_A = 'http://127.0.0.1:8001/v1'
const BASE_URL_B = 'http://localhost:8000/v1'
const SLUG = 'stale-endpoint'

function configWithBaseUrl(baseUrl: string, workspaceRoot: string): string {
  // `loadStoredConfig` rejects any config without a `workspaces` array, so the
  // fixture must carry a minimal workspace entry or every connection lookup
  // returns null and the test would silently assert against no connection.
  return JSON.stringify({
    workspaces: [
      {
        id: 'ws_fixture',
        name: 'Fixture Workspace',
        slug: 'fixture',
        rootPath: workspaceRoot,
        createdAt: 1,
      },
    ],
    activeWorkspaceId: 'ws_fixture',
    defaultLlmConnection: SLUG,
    llmConnections: [
      {
        slug: SLUG,
        name: 'Stale Endpoint',
        providerType: 'pi_compat',
        authType: 'api_key_with_endpoint',
        createdAt: 1,
        baseUrl,
        defaultModel: 'auto',
        piAuthProvider: 'openai',
        customEndpoint: { api: 'openai-completions' },
        models: ['auto'],
      },
    ],
  })
}

/**
 * The workspace rootPath the fixture config points at. Set per-run by
 * `runInIsolatedConfig` so `loadStoredConfig`'s workspace validation and
 * `loadWorkspaceConfig` both agree on the same directory.
 */
let workspaceRootForFixture = ''

/**
 * Run a scenario inside a subprocess with an isolated CRAFT_CONFIG_DIR holding
 * a single fixture connection whose `baseUrl` is `baseUrl`.
 */
function runInIsolatedConfig(baseUrl: string, script: string): { ok: boolean; out: string } {
  const configDir = mkdtempSync(join(tmpdir(), 'stale-endpoint-cfg-'))
  const scriptDir = mkdtempSync(join(tmpdir(), 'stale-endpoint-run-'))
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'stale-endpoint-ws-'))
  try {
    writeFileSync(join(configDir, 'config.json'), configWithBaseUrl(baseUrl, workspaceRoot))
    // No workspace-level default → resolution falls through to the global
    // default connection, which is the fixture above.
    writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify({ id: 'ws', name: 'ws', slug: 'ws' }))

    const prelude = [
      `const cfgDir = ${JSON.stringify(configDir)};`,
      `const wsRoot = ${JSON.stringify(workspaceRoot)};`,
      `process.env.CRAFT_CONFIG_DIR = cfgDir;`,
      // The eval script runs with CWD = the server-core package root, so the
      // relative specifiers below resolve against the real source tree.
      `const { SessionManager, createManagedSession } = require('./src/sessions/SessionManager.ts');`,
      `const { resolveBackendContext } = require('@craft-agent/shared/agent/backend');`,
      `const { buildRestartRequiredSignature, buildBackendRuntimeSignature } = require('./src/sessions/runtime-config.ts');`,
    ].join('\n')

    const run = Bun.spawnSync([process.execPath, '--eval', `${prelude}\n${script}`], {
      env: {
        ...process.env,
        CRAFT_CONFIG_DIR: configDir,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = run.stdout.toString()
    if (run.exitCode !== 0) {
      return { ok: false, out: `${out}\n${run.stderr.toString()}` }
    }
    return { ok: true, out }
  } finally {
    rmSync(configDir, { recursive: true, force: true })
    rmSync(scriptDir, { recursive: true, force: true })
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
}

describe('stale endpoint drift forces backend recreate (261014-misty-wren)', () => {
  beforeEach(() => {
    // Pin the fingerprint source to "no key" so it cannot drift between the
    // captured signature and the recomputed one — baseUrl is the only variable.
    jest.spyOn(getCredentialManager(), 'getLlmApiKey').mockResolvedValue(null)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('disposes the runtime when baseUrl changes, without attempting an in-place refresh', () => {
    // The agent is created while config still points at the DEAD endpoint, so
    // `backendRestartSignature` is captured against BASE_URL_A. Config is then
    // restored to BASE_URL_B (the live gateway) and a refresh is triggered —
    // exactly the misty-wren sequence.
    const scenario = `
      const sm = new SessionManager();
      const agent = {
        isProcessing: () => false,
        updateRuntimeConfig: async () => true,
        dispose: () => {},
      };
      const managed = createManagedSession(
        { id: 'stale', name: 'stale', llmConnection: '${SLUG}' },
        { id: 'ws', name: 'ws', rootPath: wsRoot, createdAt: 1 },
        { messagesLoaded: true },
      );
      managed.agent = agent;
      managed.isProcessing = false;
      // Capture signatures from the CURRENT (stale-endpoint) config.
      const ctx = resolveBackendContext({ sessionConnectionSlug: '${SLUG}' });
      managed.backendRuntimeSignature = '__sentinel_runtime__';
      managed.backendRestartSignature = buildRestartRequiredSignature({
        connection: ctx.connection,
        provider: ctx.provider,
        authType: ctx.authType,
        resolvedModel: ctx.resolvedModel,
      });
      sm.sessions.set('stale', managed);
      'scenario-ready';
    `

    // Phase 1 — capture the signature against BASE_URL_A.
    // NOTE: `scenario` already declares sm/managed, so phase 1 only reads the
    // already-captured signature instead of re-declaring those bindings.
    const capture = runInIsolatedConfig(
      BASE_URL_A,
      scenario + `
      console.log(JSON.stringify({ sig: managed.backendRestartSignature }));
      `,
    )
    expect(capture.ok, capture.out).toBe(true)
    const { sig: staleSig } = JSON.parse(capture.out.trim().split('\n').at(-1)!)
    expect(staleSig).toContain('8001')

    // Phase 2 — config now points at the live endpoint; recomputing the
    // signature must drift, which is what routes the session to dispose +
    // recreate instead of the in-place no-op.
    const drift = runInIsolatedConfig(
      BASE_URL_B,
      `
      const ctx = resolveBackendContext({ sessionConnectionSlug: '${SLUG}' });
      const sig = buildRestartRequiredSignature({
        connection: ctx.connection,
        provider: ctx.provider,
        authType: ctx.authType,
        resolvedModel: ctx.resolvedModel,
      });
      console.log(JSON.stringify({ sig }));
      `,
    )
    expect(drift.ok, drift.out).toBe(true)
    const { sig: liveSig } = JSON.parse(drift.out.trim().split('\n').at(-1)!)
    expect(liveSig).toContain('localhost:8000')
    expect(liveSig).not.toBe(staleSig)
  })

  it('a baseUrl-only drift routes through dispose, not the in-place refresh path', () => {
    // Full SessionManager path, isolating `baseUrl` as the ONLY drift:
    //
    //   1. Boot with config pointing at the DEAD endpoint and capture BOTH
    //      signatures from that real config (no sentinels — a sentinel makes
    //      the test pass for the wrong reason, e.g. any unrelated field
    //      change would satisfy it).
    //   2. Rewrite config.json on disk to the LIVE endpoint, mid-process.
    //   3. Run refreshConnectionRuntime and assert dispose + recreate.
    //
    // Before the fix this took the in-place branch: `update_runtime_config`
    // re-registered the provider URL, but the live session kept resolving the
    // old one, so the session kept hitting the dead port.
    const script = `
      const sm = new SessionManager();
      const calls = { updateRuntimeConfig: 0, disposed: false };
      const agent = {
        isProcessing: () => false,
        updateRuntimeConfig: async () => { calls.updateRuntimeConfig++; return true; },
        dispose: () => { calls.disposed = true; },
      };
      const managed = createManagedSession(
        { id: 'drift', name: 'drift', llmConnection: '${SLUG}' },
        { id: 'ws', name: 'ws', rootPath: wsRoot, createdAt: 1 },
        { messagesLoaded: true },
      );
      managed.agent = agent;
      managed.isProcessing = false;

      // Step 1 - capture both signatures from the CURRENT (dead) config.
      const ctxDead = resolveBackendContext({ sessionConnectionSlug: '${SLUG}' });
      const sigArgs = {
        connection: ctxDead.connection,
        provider: ctxDead.provider,
        authType: ctxDead.authType,
        resolvedModel: ctxDead.resolvedModel,
      };
      managed.backendRestartSignature = buildRestartRequiredSignature(sigArgs);
      // Also capture the runtime signature from the same dead config, so
      // baseUrl is the only field that can drift in step 2.
      managed.backendRuntimeSignature = buildBackendRuntimeSignature(sigArgs);
      sm.sessions.set('drift', managed);

      // Step 2 - repoint config.json at the live endpoint, mid-process.
      const fs = require('fs');
      const path = require('path');
      const live = JSON.parse(fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf-8'));
      live.llmConnections[0].baseUrl = '${BASE_URL_B}';
      fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify(live));

      // Step 3 - the refresh must notice ONLY the baseUrl drift and recreate.
      await sm.refreshConnectionRuntime('${SLUG}');

      console.log(JSON.stringify({
        updateRuntimeConfig: calls.updateRuntimeConfig,
        disposed: calls.disposed,
        agentIsNull: managed.agent === null,
      }));
    `

    const res = runInIsolatedConfig(BASE_URL_A, script)
    expect(res.ok, res.out).toBe(true)
    const result = JSON.parse(res.out.trim().split('\n').at(-1)!)
    expect(result.updateRuntimeConfig).toBe(0)
    expect(result.disposed).toBe(true)
    expect(result.agentIsNull).toBe(true)
  })
  it('an unchanged baseUrl does not force recreate (no spurious restarts)', () => {
    const script = `
      const sm = new SessionManager();
      let updateCalls = 0;
      const agent = {
        isProcessing: () => false,
        updateRuntimeConfig: async () => { updateCalls++; return true; },
        dispose: () => {},
      };
      const managed = createManagedSession(
        { id: 'stable', name: 'stable', llmConnection: '${SLUG}' },
        { id: 'ws', name: 'ws', rootPath: wsRoot, createdAt: 1 },
        { messagesLoaded: true },
      );
      managed.agent = agent;
      managed.isProcessing = false;
      const ctx = resolveBackendContext({ sessionConnectionSlug: '${SLUG}' });
      // Capture BOTH signatures from live config, so nothing has drifted.
      managed.backendRestartSignature = buildRestartRequiredSignature({
        connection: ctx.connection,
        provider: ctx.provider,
        authType: ctx.authType,
        resolvedModel: ctx.resolvedModel,
      });
      managed.backendRuntimeSignature = buildBackendRuntimeSignature({
        connection: ctx.connection,
        provider: ctx.provider,
        authType: ctx.authType,
        resolvedModel: ctx.resolvedModel,
      });
      sm.sessions.set('stable', managed);

      await sm.refreshConnectionRuntime('${SLUG}');

      console.log(JSON.stringify({
        updateRuntimeConfig: updateCalls,
        agentStillSet: managed.agent !== null,
      }));
    `

    const res = runInIsolatedConfig(BASE_URL_B, script)
    expect(res.ok, res.out).toBe(true)
    const result = JSON.parse(res.out.trim().split('\n').at(-1)!)
    // Nothing drifted → the helper early-returns without touching the agent.
    expect(result.updateRuntimeConfig).toBe(0)
    expect(result.agentStillSet).toBe(true)
  })
})
