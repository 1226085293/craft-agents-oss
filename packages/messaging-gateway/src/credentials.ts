/**
 * Credential shapes the host stores for platforms.
 *
 * These are data contracts, not platform behaviour: the host must be able to
 * persist and test a token without shipping an adapter. Whoever implements the
 * platform (a plugin program) has to agree on this shape, which is exactly why
 * it lives in the shared types rather than in the implementation.
 */

export interface QQCredentials {
  appId: string
  appSecret: string
  /** Senders allowed to DM the bot; empty = unrestricted. */
  mainQqOpenIds?: string[]
}

export interface LarkCredentials {
  appId: string
  appSecret: string
  /** Long-connection vs webhook mode. */
  mode?: 'websocket' | 'webhook'
  /** Regional API host (`open.feishu.cn` / `open.larksuite.com`). */
  domain?: string
}

export interface WeChatCredentials {
  token?: string
  encodingAesKey?: string
  baseUrl?: string
  /** Bot identity returned by the connect flow. */
  botId?: string
  userId?: string
}
