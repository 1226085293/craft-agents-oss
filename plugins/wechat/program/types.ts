// Local copy of the platform-adapter contract. The shared gateway types
// were deleted with the gateway (7bb262ae); every plugin now carries
// its own copy of the interfaces it implements, by design.
export type PlatformType = string

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface MessagingLogContext {
  component?: string
  workspaceId?: string
  sessionId?: string
  platform?: string
  channelId?: string
  bindingId?: string
  event?: string
}

export type MessagingLogMeta = Record<string, unknown>

/**
 * Structured logger used by the messaging stack.
 *
 * Implementations should write structured logs and preserve contextual fields
 * added via `child(...)`.
 */
export interface MessagingLogger {
  info(message: string, meta?: MessagingLogMeta): void
  warn(message: string, meta?: MessagingLogMeta): void
  error(message: string, meta?: MessagingLogMeta): void
  child(context: MessagingLogContext): MessagingLogger
}

// ---------------------------------------------------------------------------
// Runtime platform status
// ---------------------------------------------------------------------------

export type MessagingPlatformRuntimeState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnect_required'
  | 'error'

export interface MessagingPlatformRuntimeInfo {
  platform: PlatformType
  configured: boolean
  connected: boolean
  state: MessagingPlatformRuntimeState
  identity?: string
  lastError?: string
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Adapter capabilities
// ---------------------------------------------------------------------------

export interface AdapterCapabilities {
  messageEditing: boolean
  inlineButtons: boolean
  maxButtons: number
  maxMessageLength: number
  markdown: 'v2' | 'whatsapp' | 'lark-post'
  webhookSupport: boolean
  /**
   * The platform can report whether the user actually viewed our message.
   *
   * When true the adapter emits `ReadReceipt`s via `onReadReceipt`, and the
   * gateway clears the desktop unread badge on that signal. When false (the
   * default for Telegram/WeChat/QQ, which expose no read receipt), the
   * gateway instead clears the badge when a NEW inbound message arrives from
   * the bound chat — a strong proxy that the user is looking at the
   * conversation. Either way, the badge is also cleared when the user opens
   * the session on the desktop client.
   */
  readReceipts?: boolean
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface IncomingMessage {
  platform: PlatformType
  channelId: string
  /**
   * Telegram supergroup forum topic id (`message_thread_id`). Undefined for
   * DMs, the General topic, and non-forum chats. Only Telegram populates this.
   */
  threadId?: number
  messageId: string
  senderId: string
  senderName?: string
  /**
   * Platform-native username if the user has one set. Telegram supplies this
   * via `from.username`; WhatsApp/Lark may leave it undefined. Used by the
   * access-control layer to render friendlier "pending requests" rows in the
   * Settings UI without forcing the operator to read raw user_ids.
   */
  senderUsername?: string
  /**
   * `true` when the platform marks the sender as a bot (Telegram `from.is_bot`).
   * Adapters use this to silently drop bot-to-bot traffic before it reaches
   * the router; surfaces in `IncomingMessage` so access-control can audit.
   */
  senderIsBot?: boolean
  text: string
  /**
   * Kind of chat this message originated from. `'group'` for supergroups /
   * forum topics / QQ groups; `'private'` for DMs / C2C. Used by the gateway
   * to enforce that group-chat commands must @-mention the bot.
   */
  chatKind?: 'private' | 'group'
  /**
   * Group-chat mention state. `'at'` — the bot was explicitly @-mentioned
   * (must reply); `'none'` — a plain group message the bot MAY choose to
   * reply to or ignore. Undefined for DMs / platforms that don't have
   * mentions. Used by the router's group-chat decision gate.
   */
  mentionKind?: 'at' | 'none'
  attachments?: IncomingAttachment[]
  replyToMessageId?: string
  timestamp: number
  raw: unknown
}

export interface IncomingAttachment {
  type: 'photo' | 'document' | 'voice' | 'video' | 'audio' | 'animation' | 'video_note' | 'sticker'
  fileId: string
  fileName?: string
  mimeType?: string
  fileSize?: number
  /**
   * Absolute path on local disk where the adapter has already downloaded the
   * blob. When set, the router wraps it with `readFileAttachment()` and
   * forwards it as a `FileAttachment` to the session. Adapters that emit
   * attachments MUST populate this — attachments without `localPath` are
   * dropped by the router.
   */
  localPath?: string
}

export interface SentMessage {
  platform: PlatformType
  channelId: string
  messageId: string
}

export interface InlineButton {
  id: string
  label: string
  data?: string
}

export interface ButtonPress {
  platform: PlatformType
  channelId: string
  /** Forum topic id of the message the button was attached to (Telegram). */
  threadId?: number
  messageId: string
  senderId: string
  /** Optional sender display name (Telegram first name). For UI / pending list. */
  senderName?: string
  /** Optional sender username (Telegram @username, no `@`). For UI / pending list. */
  senderUsername?: string
  /** True when the platform marks the sender as a bot. Access control silent-drops these. */
  senderIsBot?: boolean
  buttonId: string
  data?: string
}

/**
 * A "the user actually read our message" signal from a platform that reports
 * read receipts (e.g. WhatsApp via Baileys `messages.read`; Lark read events).
 *
 * Platforms without read receipts (Telegram Bot API, WeChat, QQ) cannot emit
 * this — for those the gateway falls back to treating a NEW inbound message
 * from the bound chat as the "user is looking at it" signal instead.
 */
export interface ReadReceipt {
  platform: PlatformType
  channelId: string
  /** Forum topic id (Telegram). Undefined for DMs / non-Telegram. */
  threadId?: number
  /** Platform-native id of the message that was read, if available. */
  messageId?: string
}

/**
 * Per-call options for outbound adapter operations. Currently only Telegram
 * uses `threadId` (forum topic posting); other adapters ignore extra fields.
 */
export interface SendOptions {
  /** Telegram forum topic to post into. Undefined → DM or General topic. */
  threadId?: number
  /** Telegram only: send without push notification sound/banner. */
  silent?: boolean
}

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

export interface PlatformConfig {
  token?: string
  webhookUrl?: string
  webhookSecretToken?: string
  /**
   * Telegram only: a configured supergroup chatId. When set, the adapter
   * accepts messages from that chat (in addition to DMs); when unset,
   * the adapter is DM-only as before.
   */
  acceptedSupergroupChatId?: string
  /** Optional logger for adapter-level diagnostics. */
  logger?: MessagingLogger
  [key: string]: unknown
}

export interface PlatformAdapter {
  readonly platform: PlatformType
  readonly capabilities: AdapterCapabilities

  initialize(config: PlatformConfig): Promise<void>
  destroy(): Promise<void>
  isConnected(): boolean

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void
  onButtonPress(handler: (press: ButtonPress) => Promise<void>): void
  /**
   * Subscribe to "user read our message" signals. Optional because only
   * platforms with read receipts (WhatsApp, Lark, ...) emit it; the gateway
   * also clears the unread badge when a NEW inbound message arrives from the
   * bound chat, which covers platforms without read receipts (Telegram, …).
   */
  onReadReceipt?(handler: (receipt: ReadReceipt) => void): void

  sendText(channelId: string, text: string, opts?: SendOptions): Promise<SentMessage>
  editMessage(channelId: string, messageId: string, text: string, opts?: SendOptions): Promise<void>
  sendButtons(channelId: string, text: string, buttons: InlineButton[], opts?: SendOptions): Promise<SentMessage>
  sendTyping(channelId: string, opts?: SendOptions): Promise<void>
  sendFile(channelId: string, file: Buffer, filename: string, caption?: string, opts?: SendOptions): Promise<SentMessage>

  /**
   * Delete a previously-sent message. Optional because not every platform or
   * bot integration can remove messages. Renderers use this only for transient
   * progress/status messages; failure must not prevent final delivery.
   */
  deleteMessage?(channelId: string, messageId: string, opts?: SendOptions): Promise<void>

  /**
   * Clear the inline keyboard on a previously-sent message. Optional because
   * only platforms with inline-button support (currently Telegram) need it.
   * Errors are the caller's concern — most implementations should swallow
   * "message can't be edited" since it's non-fatal.
   */
  clearButtons?(channelId: string, messageId: string, opts?: SendOptions): Promise<void>

  /**
   * Update the set of chats the adapter accepts inbound messages from at
   * runtime, without restarting the polling loop. Telegram uses this to
   * (de)authorise a supergroup chatId after the user pairs/unpairs it in
   * Settings. Adapters that don't have a configurable filter can implement
   * this as a no-op.
   */
  setAcceptedSupergroupChatId?(chatId: string | undefined): void

  /**
   * Telegram-only: create a new forum topic in a supergroup. Used by
   * automation integrations that auto-spawn topics per session. Other
   * platforms throw or omit the method.
   */
  createForumTopic?(chatId: string, name: string): Promise<{ threadId: number; name: string }>

  /** Webhook handler for headless server (Telegram only). */
  handleWebhook?(request: Request): Promise<Response>
}
