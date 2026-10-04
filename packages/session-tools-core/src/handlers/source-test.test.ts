import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleSourceTest } from './source-test.ts';
import type { SessionToolContext } from '../context.ts';
import type { SourceConfig } from '../types.ts';

interface CtxOverrides {
  validateStdioMcpConnection?: SessionToolContext['validateStdioMcpConnection'];
  validateMcpConnection?: SessionToolContext['validateMcpConnection'];
  credentialManager?: SessionToolContext['credentialManager'];
}

function createCtx(workspacePath: string, overrides: CtxOverrides = {}): SessionToolContext {
  const saved: { last?: SourceConfig } = {};
  const ctx = {
    sessionId: 'test-session',
    workspacePath,
    get sourcesPath() {
      return join(workspacePath, 'sources');
    },
    get skillsPath() {
      return join(workspacePath, 'skills');
    },
    plansFolderPath: join(workspacePath, 'plans'),
    callbacks: {
      onPlanSubmitted: () => {},
      onAuthRequest: () => {},
    },
    fs: {
      exists: (path: string) => existsSync(path),
      readFile: (path: string) => readFileSync(path, 'utf-8'),
      readFileBuffer: (path: string) => readFileSync(path),
      writeFile: (path: string, content: string) => writeFileSync(path, content),
      isDirectory: (path: string) => existsSync(path) && statSync(path).isDirectory(),
      readdir: (path: string) => readdirSync(path),
      stat: (path: string) => {
        const s = statSync(path);
        return { size: s.size, isDirectory: () => s.isDirectory() };
      },
    },
    loadSourceConfig: (slug: string) => {
      const configPath = join(workspacePath, 'sources', slug, 'config.json');
      if (!existsSync(configPath)) return null;
      return JSON.parse(readFileSync(configPath, 'utf-8')) as SourceConfig;
    },
    saveSourceConfig: (source: SourceConfig) => {
      saved.last = source;
      const configPath = join(workspacePath, 'sources', source.slug, 'config.json');
      writeFileSync(configPath, JSON.stringify(source, null, 2));
    },
    // Stub the MCP validator so connection tests don't hit the network.
    validateStdioMcpConnection: overrides.validateStdioMcpConnection,
    validateMcpConnection: overrides.validateMcpConnection,
    credentialManager: overrides.credentialManager,
  } as unknown as SessionToolContext;
  // Expose saved for assertions (test-only — not on real ctx).
  (ctx as unknown as { _saved: typeof saved })._saved = saved;
  return ctx;
}

function writeSource(
  workspacePath: string,
  slug: string,
  overrides: Partial<SourceConfig> = {}
): void {
  const sourcePath = join(workspacePath, 'sources', slug);
  mkdirSync(sourcePath, { recursive: true });
  const config: SourceConfig = {
    id: slug,
    slug,
    name: `Test ${slug}`,
    enabled: true,
    provider: 'test',
    type: 'mcp',
    tagline: 'A test source',
    icon: '🧪',
    mcp: {
      transport: 'stdio',
      command: 'echo',
      args: ['ok'],
    },
    ...overrides,
  } as SourceConfig;
  writeFileSync(join(sourcePath, 'config.json'), JSON.stringify(config, null, 2));
  writeFileSync(
    join(sourcePath, 'guide.md'),
    '# Guide\n\nThis is a longer guide with more than fifty words so the validator does not warn about the guide being too short for the readability criteria the tool enforces when evaluating source completeness for this test suite which is only here to exercise the auto-enable flow and not the completeness check.'
  );
}

function stubMcpOk(): NonNullable<SessionToolContext['validateStdioMcpConnection']> {
  return async () => ({
    success: true,
    toolCount: 1,
    toolNames: ['dummy'],
    serverName: 'stub',
    serverVersion: '0.0.0',
  });
}

function stubMcpFail(): NonNullable<SessionToolContext['validateStdioMcpConnection']> {
  return async () => ({ success: false, error: 'boom' });
}

describe('source_test validation-only behavior', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'source-test-validation-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('validates a usable source without changing its enabled selection', async () => {
    writeSource(tempDir, 'craft-kb', { enabled: false });
    const result = await handleSourceTest(createCtx(tempDir, {
      validateStdioMcpConnection: stubMcpOk(),
    }), { sourceSlug: 'craft-kb' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('Validation passed');
    expect(text).toContain('select it in the session source picker');
    expect(text).not.toContain('auto-enabled');
    expect(text).not.toContain('auto-restart');

    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'craft-kb', 'config.json'), 'utf-8')
    ) as SourceConfig;
    expect(persisted.enabled).toBe(false);
    expect(persisted.connectionStatus).toBe('connected');
  });

  it('leaves an already-enabled source enabled without changing session selection', async () => {
    writeSource(tempDir, 'craft-kb', { enabled: true });
    const result = await handleSourceTest(createCtx(tempDir, {
      validateStdioMcpConnection: stubMcpOk(),
    }), { sourceSlug: 'craft-kb' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('Validation passed');
    expect(text).not.toContain('auto-restart');
    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'craft-kb', 'config.json'), 'utf-8')
    ) as SourceConfig;
    expect(persisted.enabled).toBe(true);
  });

  it('reports connection failure without enabling a source', async () => {
    writeSource(tempDir, 'broken', { enabled: false });
    const result = await handleSourceTest(createCtx(tempDir, {
      validateStdioMcpConnection: stubMcpFail(),
    }), { sourceSlug: 'broken' });
    const text = result.content[0]?.text ?? '';

    expect(result.isError).toBe(true);
    expect(text).not.toContain('auto-enabled');
    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'broken', 'config.json'), 'utf-8')
    ) as SourceConfig;
    expect(persisted.enabled).toBe(false);
    expect(persisted.connectionStatus).toBe('error');
  });
});

// ============================================================
// API connection-branch coverage (regression for #683)
// ============================================================
//
// These tests exercise the built-in fetch-based connection probe and the
// auto-enable gate that depends on its result. They drive global fetch via
// a swap-in stub so no network IO happens.

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function installFetchStub(
  responder: (call: FetchCall) => Response | Promise<Response>
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : String(input);
    const call: FetchCall = { url, init };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function writeApiSource(
  workspacePath: string,
  slug: string,
  overrides: Partial<SourceConfig> = {}
): void {
  const sourcePath = join(workspacePath, 'sources', slug);
  mkdirSync(sourcePath, { recursive: true });
  const config: SourceConfig = {
    id: slug,
    slug,
    name: slug,
    enabled: false,
    provider: 'test',
    type: 'api',
    tagline: 'A test API source',
    icon: '🧪',
    api: {
      baseUrl: 'https://api.example.test',
      authType: 'none',
    },
    ...overrides,
  } as SourceConfig;
  writeFileSync(join(sourcePath, 'config.json'), JSON.stringify(config, null, 2));
  writeFileSync(
    join(sourcePath, 'guide.md'),
    '# Guide\n\nThis is a longer guide with more than fifty words so the validator does not warn about the guide being too short for the readability criteria the tool enforces when evaluating source completeness for this test suite which is only here to exercise the connection-branch behavior.'
  );
}

describe('source_test API connection branches', () => {
  let tempDir: string;
  let restoreFetch: () => void = () => {};

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'source-test-api-conn-'));
  });

  afterEach(() => {
    restoreFetch();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('200 → connected, but does not enable or select the source', async () => {
    writeApiSource(tempDir, 'good-api');
    ({ restore: restoreFetch } = installFetchStub(() => new Response(null, { status: 200 })));

    const result = await handleSourceTest(createCtx(tempDir), { sourceSlug: 'good-api' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('Validation passed');
    expect(text).toContain('select it in the session source picker');
    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'good-api', 'config.json'), 'utf-8')
    ) as SourceConfig;
    expect(persisted.enabled).toBe(false);
    expect(persisted.connectionStatus).toBe('connected');
  });

  it('500 → disconnected and leaves the source disabled', async () => {
    writeApiSource(tempDir, 'flaky-api');
    ({ restore: restoreFetch } = installFetchStub(() => new Response(null, { status: 500 })));

    const result = await handleSourceTest(createCtx(tempDir), { sourceSlug: 'flaky-api' });
    const text = result.content[0]?.text ?? '';

    // The summary line must be the warnings variant because the endpoint is not healthy.
    expect(text).toContain('Validation passed with warnings');
    expect(text).toContain('API returned 500');
    expect(text).not.toContain('auto-enabled');

    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'flaky-api', 'config.json'), 'utf-8')
    ) as SourceConfig;
    expect(persisted.enabled).toBe(false);
    expect(persisted.connectionStatus).toBe('disconnected');
  });

  it('404 → disconnected and remains unselected', async () => {
    writeApiSource(tempDir, 'wrong-path-api');
    ({ restore: restoreFetch } = installFetchStub(() => new Response(null, { status: 404 })));

    const result = await handleSourceTest(createCtx(tempDir), { sourceSlug: 'wrong-path-api' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('Validation passed with warnings');
    expect(text).toContain('API returned 404');
    expect(text).not.toContain('auto-enabled');
    const persisted = JSON.parse(readFileSync(join(tempDir, 'sources', 'wrong-path-api', 'config.json'), 'utf-8')) as SourceConfig;
    expect(persisted.enabled).toBe(false);
  });

  it('401 → connected (auth-required) without enabling the source', async () => {
    // 401 means the probe reached the endpoint, not that this source was selected.
    writeApiSource(tempDir, 'auth-needed-api');
    ({ restore: restoreFetch } = installFetchStub(() => new Response(null, { status: 401 })));

    const result = await handleSourceTest(createCtx(tempDir), { sourceSlug: 'auth-needed-api' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('select it in the session source picker');
    expect(text).not.toContain('auto-enabled');
    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'auth-needed-api', 'config.json'), 'utf-8')
    ) as SourceConfig;
    expect(persisted.enabled).toBe(false);
    expect(persisted.connectionStatus).toBe('connected');
  });

  it('basic probe honors testEndpoint.method (no HEAD→GET fallback dance)', async () => {
    // Regression for the HEAD→GET-on-405 fallback that silently passed POST-only
    // endpoints. With a configured method, the basic probe must call it directly.
    writeApiSource(tempDir, 'post-only-api', {
      api: {
        baseUrl: 'https://api.example.test',
        authType: 'none',
        testEndpoint: { method: 'POST', path: '/v1/things' },
      },
    } as Partial<SourceConfig>);

    let stub: ReturnType<typeof installFetchStub>;
    stub = installFetchStub(() => new Response(null, { status: 200 }));
    restoreFetch = stub.restore;

    await handleSourceTest(createCtx(tempDir), { sourceSlug: 'post-only-api' });

    expect(stub.calls.length).toBe(1);
    expect(stub.calls[0]?.init?.method).toBe('POST');
    expect(stub.calls[0]?.url).toBe('https://api.example.test/v1/things');
  });
});

// ============================================================
// HTTP MCP probe — credential resolution (regression for #720)
// ============================================================
//
// The probe must forward the same auth token the live runtime would resolve:
// - cached token first
// - refresh fallback only on miss
// - works for `oauth` AND `bearer` whose token lives in the credential store
// - existing `headerNames` flow still merges credential headers, accessToken
//   stays undefined (regression guard).

type ValidateMcpCall = Parameters<NonNullable<SessionToolContext['validateMcpConnection']>>[0];

function writeHttpMcpSource(
  workspacePath: string,
  slug: string,
  overrides: Partial<SourceConfig> = {}
): void {
  const sourcePath = join(workspacePath, 'sources', slug);
  mkdirSync(sourcePath, { recursive: true });
  const config: SourceConfig = {
    id: slug,
    slug,
    name: slug,
    enabled: true,
    provider: 'test',
    type: 'mcp',
    tagline: 'A test HTTP MCP source',
    icon: '🧪',
    mcp: {
      transport: 'http',
      url: 'https://mcp.example.test',
      authType: 'oauth',
    },
    ...overrides,
  } as SourceConfig;
  writeFileSync(join(sourcePath, 'config.json'), JSON.stringify(config, null, 2));
  writeFileSync(
    join(sourcePath, 'guide.md'),
    '# Guide\n\nThis is a longer guide with more than fifty words so the validator does not warn about the guide being too short for the readability criteria the tool enforces when evaluating source completeness for this test suite which is only here to exercise the probe credential resolution behavior.'
  );
}

interface CredManagerStub {
  manager: NonNullable<SessionToolContext['credentialManager']>;
  getTokenCalls: number;
  refreshCalls: number;
}

function makeCredentialManager({
  cachedToken,
  refreshedToken,
}: {
  cachedToken?: string | null;
  refreshedToken?: string | null;
}): CredManagerStub {
  const stub: CredManagerStub = {
    manager: {
      hasValidCredentials: async () => Boolean(cachedToken),
      getToken: async () => {
        stub.getTokenCalls += 1;
        return cachedToken ?? null;
      },
      refresh: async () => {
        stub.refreshCalls += 1;
        return refreshedToken ?? null;
      },
    },
    getTokenCalls: 0,
    refreshCalls: 0,
  };
  return stub;
}

describe('source_test HTTP MCP probe credential forwarding (regression for #720)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'source-test-mcp-cred-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('OAuth MCP with cached token forwards accessToken to the probe (no refresh)', async () => {
    writeHttpMcpSource(tempDir, 'oauth-cached', {
      mcp: {
        transport: 'http',
        url: 'https://mcp.example.test',
        authType: 'oauth',
      },
    } as Partial<SourceConfig>);

    const cred = makeCredentialManager({ cachedToken: 'cached-tok' });
    const calls: ValidateMcpCall[] = [];
    const ctx = createCtx(tempDir, {
      credentialManager: cred.manager,
      validateMcpConnection: async (config) => {
        calls.push(config);
        return { success: true, toolCount: 2 };
      },
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'oauth-cached' });

    expect(result.isError).toBeFalsy();
    expect(calls.length).toBe(1);
    expect(calls[0]?.accessToken).toBe('cached-tok');
    expect(cred.getTokenCalls).toBe(1);
    expect(cred.refreshCalls).toBe(0);

    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'oauth-cached', 'config.json'), 'utf-8')
    ) as SourceConfig;
    expect(persisted.connectionStatus).toBe('connected');
  });

  it('OAuth MCP without cached token falls back to refresh and forwards the fresh token', async () => {
    writeHttpMcpSource(tempDir, 'oauth-refresh', {
      mcp: {
        transport: 'http',
        url: 'https://mcp.example.test',
        authType: 'oauth',
      },
    } as Partial<SourceConfig>);

    const cred = makeCredentialManager({ cachedToken: null, refreshedToken: 'fresh-tok' });
    const calls: ValidateMcpCall[] = [];
    const ctx = createCtx(tempDir, {
      credentialManager: cred.manager,
      validateMcpConnection: async (config) => {
        calls.push(config);
        return { success: true };
      },
    });

    await handleSourceTest(ctx, { sourceSlug: 'oauth-refresh' });

    expect(calls.length).toBe(1);
    expect(calls[0]?.accessToken).toBe('fresh-tok');
    expect(cred.getTokenCalls).toBe(1);
    expect(cred.refreshCalls).toBe(1);
  });

  it('Bearer MCP without headerNames forwards accessToken (defense-in-depth)', async () => {
    writeHttpMcpSource(tempDir, 'bearer-cached', {
      mcp: {
        transport: 'http',
        url: 'https://mcp.example.test',
        authType: 'bearer',
      },
    } as Partial<SourceConfig>);

    const cred = makeCredentialManager({ cachedToken: 'bearer-tok' });
    const calls: ValidateMcpCall[] = [];
    const ctx = createCtx(tempDir, {
      credentialManager: cred.manager,
      validateMcpConnection: async (config) => {
        calls.push(config);
        return { success: true };
      },
    });

    await handleSourceTest(ctx, { sourceSlug: 'bearer-cached' });

    expect(calls.length).toBe(1);
    expect(calls[0]?.accessToken).toBe('bearer-tok');
    expect(cred.getTokenCalls).toBe(1);
    expect(cred.refreshCalls).toBe(0);
  });

  it('headerNames flow still merges credential headers, accessToken stays undefined', async () => {
    // Multi-header credential — credential value is a JSON object keyed by header name.
    writeHttpMcpSource(tempDir, 'header-style', {
      mcp: {
        transport: 'http',
        url: 'https://mcp.example.test',
        headerNames: ['X-Api-Key'],
      },
    } as Partial<SourceConfig>);

    const cred = makeCredentialManager({ cachedToken: JSON.stringify({ 'X-Api-Key': 'k1' }) });
    const calls: ValidateMcpCall[] = [];
    const ctx = createCtx(tempDir, {
      credentialManager: cred.manager,
      validateMcpConnection: async (config) => {
        calls.push(config);
        return { success: true };
      },
    });

    await handleSourceTest(ctx, { sourceSlug: 'header-style' });

    expect(calls.length).toBe(1);
    expect(calls[0]?.headers).toEqual({ 'X-Api-Key': 'k1' });
    expect(calls[0]?.accessToken).toBeUndefined();
    expect(cred.refreshCalls).toBe(0);
  });
});

describe('source_test basic-auth header (regression for #824)', () => {
  let tempDir: string;
  const origFetch = globalThis.fetch;
  let captured: { url: string; init: RequestInit } | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'source-test-basic-'));
    captured = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeBasicAuthSource(slug: string): void {
    const sourcePath = join(tempDir, 'sources', slug);
    mkdirSync(sourcePath, { recursive: true });
    const config = {
      id: slug,
      slug,
      name: `Test ${slug}`,
      enabled: true,
      provider: 'test',
      type: 'api',
      tagline: 'Basic auth API source',
      icon: '🧪',
      isAuthenticated: true,
      api: {
        baseUrl: 'https://api.example.test',
        authType: 'basic',
        testEndpoint: { method: 'GET', path: '/ping' },
      },
    } as unknown as SourceConfig;
    writeFileSync(join(sourcePath, 'config.json'), JSON.stringify(config, null, 2));
    writeFileSync(
      join(sourcePath, 'guide.md'),
      '# Guide\n\nThis is a longer guide with more than fifty words so the validator does not warn about the guide being too short for the readability criteria the tool enforces when evaluating source completeness for this test suite which is only here to exercise the basic-auth header path and not the completeness check.'
    );
  }

  function authHeader(): string | undefined {
    const h = captured?.init.headers as Record<string, string> | undefined;
    return h?.['Authorization'];
  }

  it('JSON {username,password} token → base64-encoded header', async () => {
    writeBasicAuthSource('json-basic');
    const cred = makeCredentialManager({
      cachedToken: JSON.stringify({ username: 'u', password: 'p' }),
    });
    const ctx = createCtx(tempDir, { credentialManager: cred.manager });

    await handleSourceTest(ctx, { sourceSlug: 'json-basic' });

    expect(authHeader()).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('already-base64 token → passed through unchanged', async () => {
    writeBasicAuthSource('legacy-basic');
    const encoded = Buffer.from('u:p').toString('base64');
    const cred = makeCredentialManager({ cachedToken: encoded });
    const ctx = createCtx(tempDir, { credentialManager: cred.manager });

    await handleSourceTest(ctx, { sourceSlug: 'legacy-basic' });

    expect(authHeader()).toBe(`Basic ${encoded}`);
  });

  it('non-JSON, non-base64 token → passed through unchanged (no throw)', async () => {
    writeBasicAuthSource('garbage-basic');
    const cred = makeCredentialManager({ cachedToken: 'not-json' });
    const ctx = createCtx(tempDir, { credentialManager: cred.manager });

    await handleSourceTest(ctx, { sourceSlug: 'garbage-basic' });

    expect(authHeader()).toBe('Basic not-json');
  });
});
