/**
 * Gateway branch of resolveAuthEnvVars.
 *
 * The contract under test is a **replacement**, not a merge: when the in-process
 * gateway is armed, the session must be pointed at the gateway and given its
 * client key, and the connection's own upstream credential must NOT be looked
 * up or forwarded. Forwarding it would put a real provider key into a
 * subprocess env that only meant to carry a client key — the exact seam that
 * keeps upstream keys out of session logs.
 *
 * The fallback contract is equally load-bearing: passing no gateway (or null)
 * must reproduce the legacy per-connection behaviour, otherwise this change is
 * not a safe rollout.
 */

import { describe, expect, it } from 'bun:test';
import type { LlmConnection } from '../storage.ts';
import { environmentSnapshotKeys, resolveAuthEnvVars } from '../llm-connections.ts';

function anthropicConnection(overrides: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: 'anthropic-test',
    name: 'Anthropic Test',
    providerType: 'anthropic',
    authType: 'api_key',
    baseUrl: 'https://upstream.example.com/v1/messages',
    createdAt: Date.now(),
    ...overrides,
  } as LlmConnection;
}

/** A credential manager that fails the test if a key is actually requested. */
function trackingCredentialManager() {
  const requested: string[] = [];
  return {
    requested,
    manager: {
      getLlmApiKey: async (slug: string) => {
        requested.push(slug);
        return 'sk-upstream-DIRECT-KEY';
      },
      getLlmIamCredentials: async () => null,
    },
  };
}

describe('resolveAuthEnvVars gateway branch', () => {
  it('replaces the upstream address with the gateway URL', async () => {
    const { manager } = trackingCredentialManager();
    const connection = anthropicConnection();

    const result = await resolveAuthEnvVars(
      connection,
      connection.slug,
      manager as never,
      { baseUrl: 'http://127.0.0.1:54321', clientKey: 'sk-client-abc' },
    );

    expect(result.success).toBe(true);
    expect(result.envVars.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:54321');
    expect(result.envVars.ANTHROPIC_BASE_URL).not.toContain('upstream.example.com');
  });

  it('forwards the client key and never the upstream key', async () => {
    const { manager, requested } = trackingCredentialManager();
    const connection = anthropicConnection();

    const result = await resolveAuthEnvVars(
      connection,
      connection.slug,
      manager as never,
      { baseUrl: 'http://127.0.0.1:54321', clientKey: 'sk-client-abc' },
    );

    expect(result.envVars.ANTHROPIC_API_KEY).toBe('sk-client-abc');
    expect(result.envVars.ANTHROPIC_API_KEY).not.toContain('DIRECT-KEY');
    expect(JSON.stringify(result.envVars)).not.toContain('DIRECT-KEY');
    // The upstream credential must not even be fetched.
    expect(requested).toEqual([]);
  });

  it('does not emit an OAuth token in the gateway branch', async () => {
    const { manager } = trackingCredentialManager();
    // OAuth connections were removed; the assertion still guards against a
    // stray CLAUDE_CODE_OAUTH_TOKEN leaking into the gateway env.
    const connection = anthropicConnection({ authType: 'api_key' });

    const result = await resolveAuthEnvVars(
      connection,
      connection.slug,
      manager as never,
      { baseUrl: 'http://127.0.0.1:54321', clientKey: 'sk-client-abc' },
    );

    expect(result.success).toBe(true);
    expect(result.envVars.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(JSON.stringify(result.envVars)).not.toContain('DIRECT-TOKEN');
  });

  it('emits exactly the two gateway vars and nothing else', async () => {
    const { manager } = trackingCredentialManager();
    const connection = anthropicConnection();

    const result = await resolveAuthEnvVars(
      connection,
      connection.slug,
      manager as never,
      { baseUrl: 'http://127.0.0.1:54321', clientKey: 'sk-client-abc' },
    );

    expect(Object.keys(result.envVars).sort()).toEqual([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
    ]);
  });

  it('falls back to the legacy path when no gateway is passed', async () => {
    const { manager, requested } = trackingCredentialManager();
    const connection = anthropicConnection();

    const result = await resolveAuthEnvVars(connection, connection.slug, manager as never);

    expect(result.success).toBe(true);
    expect(result.envVars.ANTHROPIC_BASE_URL).toBe('https://upstream.example.com/v1/messages');
    expect(result.envVars.ANTHROPIC_API_KEY).toBe('sk-upstream-DIRECT-KEY');
    expect(requested).toEqual([connection.slug]);
  });

  it('falls back when the gateway override is explicitly null', async () => {
    const { manager, requested } = trackingCredentialManager();
    const connection = anthropicConnection();

    const result = await resolveAuthEnvVars(
      connection,
      connection.slug,
      manager as never,
      null,
    );

    expect(result.success).toBe(true);
    expect(result.envVars.ANTHROPIC_BASE_URL).toBe('https://upstream.example.com/v1/messages');
    expect(requested).toEqual([connection.slug]);
  });

  it('leaves non-Anthropic providers untouched even with a gateway armed', async () => {
    const { manager } = trackingCredentialManager();
    const connection = anthropicConnection({ providerType: 'pi' } as Partial<LlmConnection>);

    const result = await resolveAuthEnvVars(
      connection,
      connection.slug,
      manager as never,
      { baseUrl: 'http://127.0.0.1:54321', clientKey: 'sk-client-abc' },
    );

    // The Pi backend handles its own auth; redirecting the SDK env at the
    // gateway would break it.
    expect(result.success).toBe(true);
    expect(result.envVars).toEqual({});
  });
});

describe('environmentSnapshotKeys', () => {
  it('inherits the full trio when the gateway is not armed', () => {
    expect(environmentSnapshotKeys(false).sort()).toEqual([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_OAUTH_TOKEN',
    ]);
  });

  it('drops the address and key under the gateway so traffic cannot detour it', () => {
    const keys = environmentSnapshotKeys(true);

    // These two are the ones that would send a subprocess to the upstream
    // directly, bypassing scheduling, cooldowns and usage accounting.
    expect(keys).not.toContain('ANTHROPIC_BASE_URL');
    expect(keys).not.toContain('ANTHROPIC_API_KEY');
    expect(keys).toEqual(['CLAUDE_CODE_OAUTH_TOKEN']);
  });

  it('never returns a duplicate or unknown key', () => {
    for (const underGateway of [false, true]) {
      const keys = environmentSnapshotKeys(underGateway);
      expect(new Set(keys).size).toBe(keys.length);
      for (const key of keys) {
        expect([
          'ANTHROPIC_API_KEY',
          'ANTHROPIC_BASE_URL',
          'CLAUDE_CODE_OAUTH_TOKEN',
        ]).toContain(key);
      }
    }
  });
});
