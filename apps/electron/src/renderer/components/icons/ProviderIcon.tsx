import type { LlmConnection } from '@craft-agent/shared/config'
import { Bot, Settings, Brain, Cpu, Key } from 'lucide-react'

interface ProviderIconProps {
  connection: LlmConnection
  size?: number
  className?: string
}

/**
 * ProviderIcon — Visual indicator for LLM connection provider type.
 * Maps provider types to appropriate Lucide icons for the DeepChat-style UI.
 */
export function ProviderIcon({ connection, size = 20, className = '' }: ProviderIconProps) {
  // Handle both new providerType and legacy type field
  const provider = connection.providerType || connection.type
  
  // OAuth connections use a different icon style
  const isOAuth = connection.authType === 'oauth'
  
  switch (provider) {
    case 'anthropic':
      return (
        <Brain
          size={size}
          className={`${className} text-purple-500`}
          strokeWidth={1.5}
        />
      )
    case 'pi':
      return (
        <Bot
          size={size}
          className={`${className} text-blue-500`}
          strokeWidth={1.5}
        />
      )
    case 'pi_compat':
      return (
        <Settings
          size={size}
          className={`${className} text-gray-500`}
          strokeWidth={1.5}
        />
      )
    default:
      // Handle legacy types and custom providers
      return isOAuth ? (
        <Key size={size} className={`${className} text-amber-500`} strokeWidth={1.5} />
      ) : (
        <Cpu size={size} className={`${className} text-gray-500`} strokeWidth={1.5} />
      )
  }
}

export default ProviderIcon
