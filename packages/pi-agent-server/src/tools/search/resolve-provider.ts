/**
 * Resolves the best web search provider based on the user's LLM connection.
 *
 * Priority:
 *   1. Provider-native search (OpenAI, ChatGPT, OpenRouter, Google) — best quality
 *   2. DuckDuckGo — universal fallback, no API key required
 *
 * To add a new Responses API-compatible provider:
 *   1. Add a case here with the provider name and apiBase URL
 *   2. The ResponsesApiSearchProvider handles the rest
 */

import type { WebSearchProvider } from './types.ts';
import { ResponsesApiSearchProvider } from './providers/openai.ts';
import { ChatGPTBackendSearchProvider, extractChatGptAccountId } from './providers/chatgpt.ts';
import { GoogleSearchProvider } from './providers/google.ts';
import { DDGSearchProvider } from './providers/ddg.ts';

export type SearchProviderCredential =
  | { type: 'api_key'; key: string }
  | { type: 'oauth'; access: string; refresh: string; expires: number }
  | { type: string; key?: string; access?: string };

export interface SearchProviderAuthConfig {
  provider?: string;
  credential?: SearchProviderCredential;
}

function getApiKey(piAuth?: SearchProviderAuthConfig): string | undefined {
  if (piAuth?.credential?.type !== 'api_key') return undefined;
  return typeof piAuth.credential.key === 'string' && piAuth.credential.key.length > 0
    ? piAuth.credential.key
    : undefined;
}

function getOAuthAccess(piAuth?: SearchProviderAuthConfig): string | undefined {
  if (piAuth?.credential?.type !== 'oauth') return undefined;
  const access = (piAuth.credential as { access?: string }).access;
  return typeof access === 'string' && access.length > 0 ? access : undefined;
}

/**
 * openai-codex tokens may arrive as either:
 *  - oauth.access (legacy/explicit oauth shape), or
 *  - api_key.key (current runtime shape for ChatGPT Plus OAuth bearer token)
 */
function getOpenAiCodexAccessToken(piAuth?: SearchProviderAuthConfig): string | undefined {
  if (piAuth?.provider !== 'openai-codex') return undefined;
  return getOAuthAccess(piAuth) ?? getApiKey(piAuth);
}

/**
 * @param activeModel Bare (no `pi/` prefix) model ID of the active session/connection. Used
 *   by the ChatGPT backend provider to search with a model the account actually supports,
 *   instead of a hardcoded one that may have been retired (craft-agents-oss#1023).
 * @param isCustomEndpoint True when the session runs against a user-hosted custom endpoint
 *   (`pi_compat` with a `customEndpoint` + `baseUrl`). Such connections route chat through a
 *   local gateway/proxy, but their `piAuthProvider` may still be reported as `openai` (derived
 *   from `customEndpoint.api === 'openai-completions'`). Routing search through the provider's
 *   real endpoint (e.g. hardcoded `api.openai.com`) with the gateway's own key would 401, so
 *   custom endpoints always fall back to DuckDuckGo (they have no provider-native search).
 */
export function resolveSearchProvider(
  piAuth?: SearchProviderAuthConfig,
  activeModel?: string,
  isCustomEndpoint = false,
): WebSearchProvider {
  // Custom endpoints point at a local gateway/proxy, not the provider's real API. The gateway
  // key is meaningless against api.openai.com (or any other provider's native search endpoint),
  // so do not attempt provider-native search at all — fall straight through to DDG.
  if (isCustomEndpoint) {
    return new DDGSearchProvider();
  }

  const provider = piAuth?.provider;
  const apiKey = getApiKey(piAuth);
  const openAiCodexAccess = getOpenAiCodexAccessToken(piAuth);

  // OpenAI with API key → standard Responses API
  if (provider === 'openai' && apiKey) {
    return new ResponsesApiSearchProvider({
      apiBase: 'https://api.openai.com/v1',
      apiKey,
    });
  }

  // ChatGPT Plus (OpenAI OAuth bearer token) → ChatGPT backend endpoint
  // Supports both oauth.access and api_key.key token shapes.
  if (provider === 'openai-codex' && openAiCodexAccess) {
    const accountId = extractChatGptAccountId(openAiCodexAccess);
    if (accountId) {
      return new ChatGPTBackendSearchProvider(
        openAiCodexAccess,
        accountId,
        activeModel ? { model: activeModel } : undefined,
      );
    }
    // Can't extract accountId (malformed/non-JWT token) → fall through to DDG
  }

  // OpenRouter → same Responses API format, different base URL
  if (provider === 'openrouter' && apiKey) {
    return new ResponsesApiSearchProvider({
      apiBase: 'https://openrouter.ai/api/v1',
      apiKey,
      model: 'openai/gpt-4o-mini',
    });
  }

  // Google → Gemini API with native Google Search grounding
  if (provider === 'google' && apiKey) {
    return new GoogleSearchProvider(apiKey);
  }

  // Vercel AI Gateway is currently not wired to provider-native search routing.
  // It intentionally falls back to DDG until we add an explicit Responses API mapping.

  // Universal fallback — no API key required
  return new DDGSearchProvider();
}
