/**
 * Types and mappings for the onboarding connection setup.
 *
 * These lived in `APISetupStep.tsx`, the wizard screen that offered a choice of connection
 * method. That screen is gone — the welcome page now opens Settings → LLM gateway instead of
 * collecting credentials itself — but the *type* is still the vocabulary `useOnboarding` uses
 * to describe which connection it is saving, and the mapping is still how a saved connection
 * gets its provider/auth pair. So the non-UI half moved here rather than dying with the screen.
 */

import type { CustomEndpointConfig, LlmAuthType, LlmProviderType } from '@craft-agent/shared/config/llm-connections'

/**
 * What the credential form submits.
 *
 * Declared here because the screen that collected it (`CredentialsStep`) and the input control
 * it wrapped (`ApiKeyInput`) are both gone; `useOnboarding` still describes a connection this
 * way when it saves one.
 */
export interface ApiKeySubmitData {
  apiKey: string
  baseUrl?: string
  connectionDefaultModel?: string
  models?: string[]
  piAuthProvider?: string
  modelSelectionMode?: 'automaticallySyncedFromProvider' | 'userDefined3Tier'
  /** Custom endpoint protocol — set when user configures an arbitrary API endpoint */
  customEndpoint?: CustomEndpointConfig
  iamCredentials?: {
    accessKeyId: string
    secretAccessKey: string
    sessionToken?: string
  }
  /** AWS region for Pi+Bedrock */
  awsRegion?: string
  /** Bedrock authentication method — determines auth type for Pi+Bedrock connections */
  // IAM was removed with the Bedrock provider capability.
  bedrockAuthMethod?: 'environment'
}

/** What the local-model form submits. */
export interface LocalModelSubmitData {
  baseUrl: string
  model: string
  models: string[]
}

/**
 * API setup method.
 * Maps to specific LlmProviderType + LlmAuthType combinations.
 *
 * - 'anthropic_api_key' → anthropic + api_key
 * - 'pi_api_key' → pi + api_key
 */
export type ApiSetupMethod =
  | 'anthropic_api_key'
  | 'pi_api_key'

/**
 * Map ApiSetupMethod to the underlying LLM connection types.
 */
export function apiSetupMethodToConnectionTypes(method: ApiSetupMethod): {
  providerType: LlmProviderType
  authType: LlmAuthType
} {
  // OAuth setup methods were removed with the OAuth connection types, so only
  // API-key methods remain.
  switch (method) {
    case 'anthropic_api_key':
    case 'pi_api_key':
      return { providerType: 'pi', authType: 'api_key' }
  }
}
