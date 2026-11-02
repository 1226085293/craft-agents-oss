import type { ProviderDriver } from '../driver-types.ts';
import { validateAnthropicConnection } from '../../../../config/llm-validation.ts';
import { DEFAULT_MODEL, getModelById, getModelContextWindow, normalizeDeprecatedModelId } from '../../../../config/models.ts';
import { getDefaultContextWindow } from '../../../../config/storage.ts';
import { buildPiRuntimePayload } from './runtime-payload.ts';

export const anthropicDriver: ProviderDriver = {
  provider: 'anthropic',
  // Direct Anthropic connections also terminate in the Pi subprocess. The
  // driver must provide the same spawn paths and pin the Pi auth provider so
  // PiAgent can resolve the connection-scoped Anthropic credential.
  buildRuntime: (args) => buildPiRuntimePayload(args, 'anthropic'),
  fetchModels: async ({ connection, credentials }) => {
    // After legacy migration, only direct 'anthropic' connections reach this driver.
    // iam_credentials and service_account_file are no longer valid auth types for anthropic.

    const apiKey = credentials.apiKey;
    const oauthAccessToken = credentials.oauthAccessToken;

    if (!apiKey && !oauthAccessToken) {
      throw new Error('Anthropic credentials required to fetch models');
    }

    const baseUrl = connection.baseUrl || 'https://api.anthropic.com';
    const headers: Record<string, string> = {
      'anthropic-version': '2023-06-01',
    };
    if (apiKey) {
      headers['x-api-key'] = apiKey;
    } else {
      headers.authorization = `Bearer ${oauthAccessToken}`;
    }

    const allRawModels: Array<{
      id: string;
      display_name: string;
      created_at: string;
      type: string;
    }> = [];
    let afterId: string | undefined;

    do {
      const params = new URLSearchParams({ limit: '100' });
      if (afterId) params.set('after_id', afterId);

      const response = await fetch(`${baseUrl}/v1/models?${params}`, { headers });
      if (!response.ok) {
        throw new Error(`Anthropic /v1/models failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as {
        data: Array<{ id: string; display_name: string; created_at: string; type: string }>;
        has_more: boolean;
        first_id: string;
        last_id: string;
      };
      if (data.data) allRawModels.push(...data.data);

      if (data.has_more && data.last_id) {
        afterId = data.last_id;
      } else {
        break;
      }
    } while (true);

    if (allRawModels.length === 0) {
      throw new Error('No models returned from Anthropic API');
    }

    const seen = new Set<string>();
    const models = allRawModels
      .filter(m => m.id.startsWith('claude-') && !m.id.startsWith('claude-2') && !m.id.startsWith('claude-instant') && !m.id.startsWith('claude-1'))
      // The live Anthropic API can still list deprecated models. Do not persist
      // them back into active connection catalogs at startup.
      .filter(m => normalizeDeprecatedModelId(m.id) === m.id)
      .filter(m => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      })
      .map(m => {
        const registryModel = getModelById(m.id);
        return {
          id: m.id,
          name: registryModel?.name ?? m.display_name,
          shortName: registryModel?.shortName ?? (() => {
            const stripped = m.id
              .replace('claude-', '')
              .replace(/-\d{8}$/, '')
              .replace(/-latest$/, '');
            const variant = stripped
              .replace(/^[\d.-]+/, '')
              .replace(/-[\d.]+$/, '')
              .replace(/^-/, '');
            return variant ? variant.charAt(0).toUpperCase() + variant.slice(1) : stripped;
          })(),
          description: registryModel?.description ?? '',
          descriptionKey: registryModel?.descriptionKey,
          provider: 'anthropic' as const,
          contextWindow: getModelContextWindow(m.id) ?? getDefaultContextWindow(),
          supportsThinking: registryModel?.supportsThinking,
          supportsImages: registryModel?.supportsImages,
        };
      });

    return {
      models,
      serverDefault: models.some(m => m.id === DEFAULT_MODEL) ? DEFAULT_MODEL : models[0]?.id,
    };
  },
  validateStoredConnection: async ({ slug, connection, credentialManager }) => {
    // Only API-key and environment auth remain: OAuth connections were removed,
    // so an 'oauth' authType is now a stale config entry rather than a path.
    // `bearerToken` holds the value for bearer_token auth — the name is kept
    // because validateAnthropicConnection's parameter is spelled that way.
    let apiKey: string | null = null;
    let bearerToken: string | null = null;

    if (connection.authType === 'api_key' || connection.authType === 'api_key_with_endpoint') {
      apiKey = await credentialManager.getLlmApiKey(slug);
    } else if (connection.authType === 'bearer_token') {
      bearerToken = await credentialManager.getLlmApiKey(slug);
    } else if (connection.authType === 'environment') {
      apiKey = process.env.ANTHROPIC_API_KEY || null;
      if (!apiKey) {
        return { success: false, error: 'ANTHROPIC_API_KEY environment variable not set' };
      }
    } else if (connection.authType === 'none') {
      apiKey = 'ollama';
    }

    if (!apiKey && !bearerToken && connection.authType !== 'none') {
      return { success: false, error: 'Could not retrieve credentials' };
    }

    const testModel = connection.defaultModel!;
    const validationResult = await validateAnthropicConnection({
      model: testModel,
      apiKey: apiKey || undefined,
      oauthToken: bearerToken || undefined,
      baseUrl: connection.baseUrl || undefined,
    });

    if (!validationResult.success) {
      return { success: false, error: validationResult.error };
    }

    return { success: true };
  },
};
