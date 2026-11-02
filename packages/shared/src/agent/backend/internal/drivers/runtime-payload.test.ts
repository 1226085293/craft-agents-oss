import { describe, expect, it } from 'bun:test';
import { anthropicDriver } from './anthropic.ts';
import { piDriver } from './pi.ts';

const resolvedPaths = {
  piServerPath: '/tmp/pi-agent-server/index.js',
  nodeRuntimePath: '/tmp/vendor/bun/bun',
  interceptorBundlePath: '/tmp/interceptor.cjs',
  sessionServerPath: '/tmp/session-mcp-server/index.js',
  bridgeServerPath: '/tmp/bridge-mcp-server/index.js',
};

function makeConnection(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'probe',
    name: 'Probe',
    providerType: 'anthropic',
    authType: 'api_key',
    defaultModel: 'claude-sonnet-4-6',
    createdAt: 0,
    ...overrides,
  };
}

function makeArgs(provider: 'anthropic' | 'pi', connection = makeConnection()) {
  return {
    context: {
      connection,
      provider,
      authType: 'api_key',
      resolvedModel: 'claude-sonnet-4-6',
      capabilities: { needsHttpPoolServer: false },
    },
    coreConfig: {
      workspace: {
        id: 'probe',
        name: 'Probe',
        slug: 'probe',
        rootPath: '/tmp/probe',
        createdAt: 0,
      },
      session: {
        id: 'probe-session',
        workspaceRootPath: '/tmp/probe',
        createdAt: 0,
        lastUsedAt: 0,
      },
      isHeadless: true,
    },
    hostRuntime: {
      appRootPath: '/tmp/probe',
      isPackaged: false,
    },
    resolvedPaths,
  } as any;
}

describe('Pi runtime payload', () => {
  it('direct Anthropic connections receive Pi spawn paths and the Anthropic auth provider', () => {
    const runtime = anthropicDriver.buildRuntime(makeArgs('anthropic'));

    expect(runtime.paths?.piServer).toBe(resolvedPaths.piServerPath);
    expect(runtime.paths?.node).toBe(resolvedPaths.nodeRuntimePath);
    expect(runtime.paths?.interceptor).toBe(resolvedPaths.interceptorBundlePath);
    expect(runtime.paths?.sessionServer).toBe(resolvedPaths.sessionServerPath);
    expect(runtime.paths?.bridgeServer).toBe(resolvedPaths.bridgeServerPath);
    expect(runtime.piAuthProvider).toBe('anthropic');
  });

  it('Pi connections keep their explicit Pi auth provider', () => {
    const connection = makeConnection({
      providerType: 'pi',
      piAuthProvider: 'openai-codex',
    });
    const runtime = piDriver.buildRuntime(makeArgs('pi', connection));

    expect(runtime.paths?.piServer).toBe(resolvedPaths.piServerPath);
    expect(runtime.piAuthProvider).toBe('openai-codex');
  });

  it('provider options override the connection auth provider for both drivers', () => {
    const args = makeArgs('anthropic');
    args.providerOptions = { piAuthProvider: 'google' };

    expect(anthropicDriver.buildRuntime(args).piAuthProvider).toBe('google');
    expect(piDriver.buildRuntime(args).piAuthProvider).toBe('google');
  });

  it('preserves per-model maxTokens overrides for custom endpoints', () => {
    const connection = makeConnection({
      providerType: 'pi_compat',
      models: [{ id: 'tight-output-model', contextWindow: 32_000, maxTokens: 2_048 }],
    });
    const runtime = piDriver.buildRuntime(makeArgs('pi', connection));

    expect(runtime.customModels).toEqual([
      { id: 'tight-output-model', contextWindow: 32_000, maxTokens: 2_048 },
    ]);
  });
});
