/**
 * Tests for Agent Factory
 *
 * Verifies:
 * - Provider detection from auth type
 * - Backend creation for different providers
 * - LLM connection type mapping
 * - Available providers list
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { join } from 'node:path';
import {
  detectProvider,
  createBackend,
  createAgent,
  fetchBackendModels,
  getAvailableProviders,
  initializeBackendHostRuntime,
  isProviderAvailable,
  connectionAuthTypeToBackendAuthType,
  providerTypeToAgentProvider,
  resolveModelForProvider,
  resolveSetupTestConnectionHint,
  testBackendConnection,
  validateStoredBackendConnection,
} from '../factory.ts';
import type { BackendConfig } from '../types.ts';
import type { Workspace, LlmConnection } from '../../../config/storage.ts';
import type { SessionConfig as Session } from '../../../sessions/storage.ts';
import { PiAgent } from '../../pi-agent.ts';
import { isValidProviderAuthCombination } from '../../../config/llm-connections.ts';

// Test helpers
function createTestWorkspace(): Workspace {
  return {
    id: 'test-workspace',
    name: 'Test Workspace',
    slug: 'workspace',
    rootPath: '/test/workspace',
    createdAt: Date.now(),
  };
}

function createTestSession(): Session {
  return {
    id: 'test-session',
    name: 'Test Session',
    workspaceRootPath: '/test/workspace',
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    permissionMode: 'ask',
  };
}

function createTestConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    provider: 'pi',
    workspace: createTestWorkspace(),
    session: createTestSession(),
    isHeadless: true, // Prevent config watchers from starting
    ...overrides,
  };
}

describe('detectProvider', () => {
  /**
   * There is one backend. The function keeps its argument for the stored auth types that used to
   * select between two drivers, but every answer is 'pi'.
   */
  it('resolves every stored auth type to the one backend', () => {
    for (const authType of ['api_key', 'oauth_token', 'api_key_with_endpoint', 'unknown', '']) {
      expect(detectProvider(authType)).toBe('pi');
    }
  });
});

describe('createBackend / createAgent', () => {
  describe('Pi provider', () => {
    it('should create PiAgent for pi provider', () => {
      const config = createTestConfig({ provider: 'pi' });
      const agent = createBackend(config);

      expect(agent).toBeInstanceOf(PiAgent);
    });
  });

  describe('Unknown provider', () => {
    it('should throw for unknown provider', () => {
      const config = createTestConfig({ provider: 'unknown' as any });

      expect(() => createBackend(config)).toThrow('Unknown provider: unknown');
    });
  });

  describe('createAgent alias', () => {
    it('should be an alias for createBackend', () => {
      expect(createAgent).toBe(createBackend);
    });
  });
});

describe('getAvailableProviders', () => {
  it('should return the one backend', () => {
    expect(getAvailableProviders()).toEqual(['pi']);
  });
});

describe('isProviderAvailable', () => {
  it('should return true for pi', () => {
    expect(isProviderAvailable('pi')).toBe(true);
  });

  it('should return false for unknown provider', () => {
    expect(isProviderAvailable('unknown' as any)).toBe(false);
  });
});

describe('connectionAuthTypeToBackendAuthType (legacy)', () => {
  it('should map api_key to api_key', () => {
    expect(connectionAuthTypeToBackendAuthType('api_key')).toBe('api_key');
  });

  it('should map none to undefined', () => {
    expect(connectionAuthTypeToBackendAuthType('none')).toBeUndefined();
  });
});

describe('providerTypeToAgentProvider', () => {
  // `pi` and `pi_compat` differ only in whether the endpoint is a known provider or a typed URL;
  // both terminate in the same subprocess.
  it('maps every provider type to pi', () => {
    expect(providerTypeToAgentProvider('pi')).toBe('pi');
    expect(providerTypeToAgentProvider('pi_compat')).toBe('pi');
  });
});

// ============================================================
// Provider-Auth Validation Tests
// ============================================================

describe('isValidProviderAuthCombination', () => {
  describe('Pi provider', () => {
    it('should accept api_key auth', () => {
      expect(isValidProviderAuthCombination('pi', 'api_key')).toBe(true);
    });

    // OAuth was removed, so this combination is no longer valid.
    it('should reject oauth auth', () => {
      expect(isValidProviderAuthCombination('pi', 'oauth' as never)).toBe(false);
    });

    it('should accept none auth', () => {
      expect(isValidProviderAuthCombination('pi', 'none')).toBe(true);
    });
  });

  describe('Pi compat provider', () => {
    it('should accept api_key_with_endpoint auth', () => {
      expect(isValidProviderAuthCombination('pi_compat', 'api_key_with_endpoint')).toBe(true);
    });

    it('should accept none auth (for local models like Ollama)', () => {
      expect(isValidProviderAuthCombination('pi_compat', 'none')).toBe(true);
    });
  });

});

describe('phase4 backend abstraction APIs', () => {
  it('initializeBackendHostRuntime bootstraps without throwing in dev runtime', () => {
    expect(() => initializeBackendHostRuntime({
      hostRuntime: {
        appRootPath: process.cwd(),
        isPackaged: false,
      },
    })).not.toThrow();
  });

  it('resolveSetupTestConnectionHint maps provider/baseUrl/piAuthProvider correctly', () => {
    // A baseUrl alone is not enough to make a compat connection: `pi_compat` means "custom
    // endpoint protocol", which is what `customEndpoint` carries. Without it the connection stays
    // plain `pi` and the URL is just an override of that provider's endpoint.
    expect(resolveSetupTestConnectionHint({
      provider: 'pi',
      baseUrl: 'https://api.example.com',
    })).toEqual({ providerType: 'pi', piAuthProvider: undefined });

    expect(resolveSetupTestConnectionHint({
      provider: 'pi',
      baseUrl: '',
    })).toEqual({ providerType: 'pi', piAuthProvider: undefined });

    expect(resolveSetupTestConnectionHint({
      provider: 'pi',
      piAuthProvider: 'openai-codex',
    })).toEqual({ providerType: 'pi', piAuthProvider: 'openai-codex' });

    expect(resolveSetupTestConnectionHint({
      provider: 'pi',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      customEndpoint: { api: 'openai-completions' },
    })).toEqual({ providerType: 'pi_compat', piAuthProvider: 'openai', customEndpoint: { api: 'openai-completions' } });

    expect(resolveSetupTestConnectionHint({
      provider: 'pi',
      baseUrl: 'https://my-anthropic-proxy.internal/v1',
      customEndpoint: { api: 'anthropic-messages' },
    })).toEqual({ providerType: 'pi_compat', piAuthProvider: 'anthropic', customEndpoint: { api: 'anthropic-messages' } });
  });

  it('fetchBackendModels dispatches for pi provider', async () => {
    const connection: LlmConnection = {
      slug: 'pi-test',
      name: 'Pi Test',
      providerType: 'pi',
      authType: 'none',
      createdAt: Date.now(),
    };

    const result = await fetchBackendModels({
      connection,
      credentials: {},
      hostRuntime: {
        appRootPath: process.cwd(),
        isPackaged: false,
      },
    });

    expect(result.models.length).toBeGreaterThan(0);
  });

  it('validateStoredBackendConnection returns not found for unknown slug', async () => {
    const result = await validateStoredBackendConnection({
      slug: '__missing-connection__',
      hostRuntime: {
        appRootPath: process.cwd(),
        isPackaged: false,
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Connection not found');
  });

  it('testBackendConnection keeps required model argument and validates key presence', async () => {
    const result = await testBackendConnection({
      provider: 'pi',
      apiKey: '   ',
      model: 'claude-sonnet-4-6',
      hostRuntime: {
        appRootPath: process.cwd(),
        isPackaged: false,
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('API key is required');
  });
});

describe('resolveModelForProvider', () => {
  it('falls back to the Pi connection default when a normalized stale model is not in the connection list', () => {
    const connection = {
      providerType: 'pi',
      defaultModel: 'pi/claude-opus-4-7',
      models: ['pi/claude-opus-4-7', 'pi/claude-sonnet-4-6'],
    } as unknown as LlmConnection;

    expect(resolveModelForProvider('pi', 'pi/claude-opus-4-6', connection)).toBe('pi/claude-opus-4-7');
  });
});

describe('Backend model switching', () => {
  it('setModel updates getModel (regression: setModel used to write config.model but getModel reads _model)', () => {
    const agent = createBackend(createTestConfig({ provider: 'pi', model: 'claude-opus-4-7' }));

    expect(agent.getModel()).toBe('claude-opus-4-7');

    agent.setModel('claude-sonnet-4-6');

    expect(agent.getModel()).toBe('claude-sonnet-4-6');
  });
});
