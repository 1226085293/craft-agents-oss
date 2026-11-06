/**
 * Structural views of the adapters the host drives.
 *
 * The host never imports a concrete adapter — it loads a plugin program and
 * only relies on the methods it needs. Narrow interfaces make that explicit:
 * a plugin can ship anything that satisfies them, and the compiler points at
 * the host when the contract drifts.
 */

import type { PlatformAdapter } from './types'
import type { WhatsAppEvent } from './whatsapp-event'

/**
 * Telegram adds supergroup pairing: the host must read chat metadata before
 * binding a forum, and create the topic after.
 */
export type TelegramAdapterLike = PlatformAdapter & {
  getBotInfo: () => Promise<{ username?: string; id?: number } | null>
  getChatInfo: (chatId: string) => Promise<{ type?: string; isForum?: boolean; title?: string } | null>
  createForumTopic?: (chatId: string, name: string) => Promise<{ threadId: number } | null>
  /** Restrict inbound to one supergroup (undefined clears the restriction). */
  setAcceptedSupergroupChatId: (chatId: string | undefined) => void
}

export type QQAdapterLike = PlatformAdapter & {
  readonly mainQqOpenIds: string[]
  setMainQqOpenIds(ids: string[]): void
}

export type LarkAdapterLike = PlatformAdapter & {
  readonly mode?: 'websocket' | 'webhook'
  getBotInfo: () => Promise<{ name?: string; openId?: string } | null>
}

export type WeChatAdapterLike = PlatformAdapter & {
  connect: (input: { token: string; encodingAesKey?: string }) => Promise<void>
}

export type WhatsAppAdapterLike = PlatformAdapter & {
  connect: (options?: Record<string, unknown>) => Promise<void>
  logout: () => Promise<void>
  /** Phone-number pairing alternative to scanning the QR. */
  requestPairingCode: (phoneNumber: string) => Promise<void>
  onEvent: (handler: (event: WhatsAppEvent) => void) => () => void
}
