/**
 * TelegramAdapter — in-process adapter using grammY.
 *
 * Phase 1: polling mode, text-only, DM-only.
 */

import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Bot, InputFile, type Context } from 'grammy'
import type {
  PlatformAdapter,
  PlatformConfig,
  AdapterCapabilities,
  IncomingAttachment,
  IncomingMessage,
  SendOptions,
  SentMessage,
  InlineButton,
  ButtonPress,
  MessagingLogger,
} from '../../types'
import { formatForTelegram } from './format'

/**
 * Discriminated chat metadata returned by `getChatInfo`. Phase A's supergroup
 * pairing flow uses this to validate that the user typed `/pair` in an
 * actual forum supergroup before binding it as the workspace's supergroup.
 */
export type TelegramChatInfo =
  | { type: 'supergroup'; isForum: boolean; title: string }
  | { type: 'group' | 'channel' | 'private'; title?: string }

/**
 * Hard cap for downloaded attachment size. Matches `MAX_FILE_SIZE` in
 * `@craft-agent/shared/utils/files` — files larger than this would be
 * rejected by `readFileAttachment` anyway, so we fail fast in the adapter
 * with a user-visible reply instead of silently dropping.
 */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/**
 * Minimal mime → extension fallback used when Telegram's `file_path` is
 * missing or extension-less. Kept intentionally small — anything unknown
 * becomes `.bin` and `readFileAttachment` will classify it as 'unknown'.
 */
const MIME_EXT_FALLBACK: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'application/pdf': '.pdf',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
}

const NOOP_LOGGER: MessagingLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
}

/**
 * Race a promise against a timeout. If `ms` elapses before `p` settles, reject
 * with a labelled error. Used to surface grammY's silent-retry hangs on
 * `bot.init()` / `deleteWebhook()` as real, actionable errors.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`[telegram] ${label} timed out after ${ms}ms`)),
      ms,
    )
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/**
 * Unwrap an error for structured logging. grammY's HttpError wraps the real
 * fetch/undici cause in an `.error` field; electron-log's JSON serializer
 * otherwise sees an empty object because Error's own fields are non-enumerable.
 * Walks up to 3 levels of wrapping (HttpError -> cause -> cause).
 */
function describeError(err: unknown, depth = 0): Record<string, unknown> {
  if (depth > 3) return { truncated: true }
  if (err instanceof Error) {
    const out: Record<string, unknown> = {
      name: err.name,
      message: err.message,
    }
    const code = (err as { code?: unknown }).code
    if (code !== undefined) out.code = code
    const grammyInner = (err as { error?: unknown }).error
    if (grammyInner !== undefined) out.error = describeError(grammyInner, depth + 1)
    const cause = (err as { cause?: unknown }).cause
    if (cause !== undefined) out.cause = describeError(cause, depth + 1)
    if (err.stack) out.stack = err.stack.split('\n').slice(0, 4).join('\n')
    return out
  }
  if (err && typeof err === 'object') return { value: String(err), raw: err as object }
  return { value: String(err) }
}

/**
 * DM-only guard. Retained because tests use it directly; new code paths
 * should call `isAcceptedChat()` which also accepts the workspace's
 * configured supergroup chat (forum).
 */
export function isPrivateChat(ctx: Context): boolean {
  return ctx.chat?.type === 'private'
}

/**
 * Decide whether an inbound update should be processed.
 *
 * - DMs (`private` chats) are always accepted — same as Phase 1.
 * - When the workspace has a paired supergroup, that exact `chat.id` is
 *   also accepted (forum topics live inside it).
 * - Everything else (other groups, channels, basic groups the bot was
 *   added to without explicit configuration) is dropped.
 *
 * Sender-level authorization for groups/topics is intentionally NOT enforced
 * here — pairing the supergroup in Settings is the per-workspace consent
 * boundary, and topic-scoped bindings determine which session each topic
 * routes to.
 */
export function isAcceptedChat(ctx: Context, supergroupChatId?: string): boolean {
  const chat = ctx.chat
  if (!chat) return false
  if (chat.type === 'private') return true
  if (!supergroupChatId) return false
  return String(chat.id) === supergroupChatId
}

export class TelegramAdapter implements PlatformAdapter {
  readonly platform = 'telegram' as const
  readonly capabilities: AdapterCapabilities = {
    messageEditing: true,
    inlineButtons: true,
    maxButtons: 10,
    maxMessageLength: 4096,
    markdown: 'v2',
    // This adapter uses polling (grammY Bot#start). A webhook path is not
    // wired through the Electron main process, so advertising webhookSupport
    // would mislead the headless server bootstrap. Keep false until a proper
    // webhook handler exists.
    webhookSupport: false,
  }

  /** Fetch bot profile (username, display name). Used for UI hints. */
  async getBotInfo(): Promise<{ id: number; username?: string; firstName?: string } | null> {
    if (!this.bot) return null
    try {
      const me = await this.bot.api.getMe()
      return { id: me.id, username: me.username, firstName: me.first_name }
    } catch {
      return null
    }
  }

  private bot: Bot | null = null
  private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null
  private buttonHandler: ((press: ButtonPress) => Promise<void>) | null = null
  private connected = false
  private destroyed = false
  private pollingRestartTimer: ReturnType<typeof setTimeout> | null = null
  private log: MessagingLogger = NOOP_LOGGER
  /**
   * The supergroup chatId this adapter accepts non-DM messages from.
   * Updated at runtime via `setAcceptedSupergroupChatId()` after the user
   * pairs/unpairs a supergroup in Settings, so polling doesn't need to
   * restart on reconfigure.
   */
  private supergroupChatId: string | undefined

  /**
   * Emit one structured log line per dropped non-accepted update. Deliberately
   * `info` (not `debug`) so a user who notices "bot isn't responding in my
   * group" can confirm via logs without toggling levels.
   */
  private logRejectedChat(handler: string, ctx: Context): void {
    this.log.info('[telegram] ignored non-accepted chat update', {
      event: 'telegram_chat_rejected',
      handler,
      chatType: ctx.chat?.type,
      chatId: ctx.chat?.id,
    })
  }

  /**
   * Dispatch inbound work without awaiting it from grammY's update handler.
   *
   * grammY long-polling processes update middleware in-order. If we await the
   * gateway route here, `SessionManager.sendMessage()` can keep the middleware
   * promise pending until an agent run completes. That serialises unrelated
   * Telegram chats/topics behind the first active session. WhatsApp already
   * uses fire-and-forget dispatch from its worker event loop; Telegram must do
   * the same so separate sessions remain independent.
   */
  private dispatchMessage(msg: IncomingMessage): void {
    const handler = this.messageHandler
    if (!handler) return
    setImmediate(() => {
      void handler(msg).catch((err) => {
        this.log.error('[telegram] async message handler failed:', describeError(err))
      })
    })
  }

  private dispatchButtonPress(press: ButtonPress): void {
    const handler = this.buttonHandler
    if (!handler) return
    setImmediate(() => {
      void handler(press).catch((err) => {
        this.log.error('[telegram] async button handler failed:', describeError(err))
      })
    })
  }

  /** Idempotent runtime reconfigure for the accepted supergroup chatId. */
  setAcceptedSupergroupChatId(chatId: string | undefined): void {
    this.supergroupChatId = chatId
    this.log.info('[telegram] accepted supergroup updated', {
      event: 'telegram_supergroup_set',
      supergroupChatId: chatId ?? null,
    })
  }

  /**
   * Resolve a chat's metadata via Bot API. Returns `null` on any failure
   * (network, "chat not found", missing permissions, etc.). The caller is
   * expected to handle the null case explicitly — for the supergroup-pairing
   * flow that means refusing to bind, rather than guessing defaults.
   *
   * Forum supergroups are the only chat type that can host topics. The
   * `isForum` flag distinguishes a regular supergroup from one with topics
   * enabled, which is required for Phase B's `createForumTopic` to work.
   */
  async getChatInfo(chatId: string): Promise<TelegramChatInfo | null> {
    if (!this.bot) return null
    try {
      const chat = await this.bot.api.getChat(Number(chatId))
      if (chat.type === 'supergroup') {
        return {
          type: 'supergroup',
          isForum: Boolean((chat as { is_forum?: boolean }).is_forum),
          title: chat.title ?? `Group ${chatId}`,
        }
      }
      return {
        type: chat.type,
        title: 'title' in chat && typeof chat.title === 'string' ? chat.title : undefined,
      }
    } catch {
      return null
    }
  }

  /**
   * Telegram-specific helper: extract the optional `message_thread_id` from
   * an inbound update. Returns undefined for DMs and for the General topic
   * (Telegram omits the field there).
   */
  private extractThreadId(ctx: Context): number | undefined {
    const tid = ctx.message?.message_thread_id
    return typeof tid === 'number' ? tid : undefined
  }

  async initialize(config: PlatformConfig): Promise<void> {
    if (!config.token) {
      throw new Error('Telegram bot token is required')
    }

    this.log = config.logger ?? NOOP_LOGGER
    this.destroyed = false
    this.clearPollingRestartTimer()
    this.bot = new Bot(config.token)
    if (config.acceptedSupergroupChatId) {
      this.supergroupChatId = config.acceptedSupergroupChatId
    }

    // Diagnostic middleware: log every Telegram message update before any
    // filter-specific handler runs. This is intentionally lightweight and
    // structured so production support can distinguish "Telegram never sent
    // the bot an update" from "Craft received it but dropped/misrouted it",
    // especially for forum topics where privacy settings and thread ids are
    // frequent sources of confusion.
    this.bot.use(async (ctx, next) => {
      if (ctx.message) {
        const text = 'text' in ctx.message && typeof ctx.message.text === 'string'
          ? ctx.message.text
          : undefined
        const caption = 'caption' in ctx.message && typeof ctx.message.caption === 'string'
          ? ctx.message.caption
          : undefined
        this.log.info('[telegram] inbound message update', {
          event: 'telegram_inbound_update',
          chatId: ctx.chat?.id,
          chatType: ctx.chat?.type,
          threadId: this.extractThreadId(ctx) ?? null,
          messageId: ctx.message.message_id,
          fromId: ctx.from?.id,
          fromIsBot: ctx.from?.is_bot ?? false,
          hasText: text !== undefined,
          hasCaption: caption !== undefined,
          textPreview: text?.slice(0, 80) ?? caption?.slice(0, 80) ?? null,
        })
      }
      await next()
    })

    // Handle incoming text messages.
    //
    // Narrow exception to `isAcceptedChat`: `/pair <code>` is allowed from
    // *any* chat, even if the workspace hasn't paired this chat yet. This is
    // the bootstrap mechanism that registers a supergroup — without this
    // exception, `/pair` typed in a fresh supergroup is silently dropped
    // (chicken-and-egg). Codes are workspace-scoped, single-use, 5-min TTL,
    // and rate-limited per-sender, so the exception is bounded.
    this.bot.on('message:text', async (ctx: Context) => {
      if (!this.messageHandler || !ctx.message || !ctx.chat) return
      const text = ctx.message.text ?? ''
      const isPairAttempt = /^\/pair(\s|$|@)/i.test(text)
      if (!isAcceptedChat(ctx, this.supergroupChatId) && !isPairAttempt) {
        this.logRejectedChat('message:text', ctx)
        return
      }

      const threadId = this.extractThreadId(ctx)
      this.log.info('[telegram] routing text update', {
        event: 'telegram_text_update_accepted',
        chatId: ctx.chat.id,
        chatType: ctx.chat.type,
        threadId: threadId ?? null,
        messageId: ctx.message.message_id,
        textPreview: text.slice(0, 80),
      })
      const msg: IncomingMessage = {
        platform: 'telegram',
        channelId: String(ctx.chat.id),
        ...(threadId !== undefined ? { threadId } : {}),
        messageId: String(ctx.message.message_id),
        senderId: String(ctx.from?.id ?? ''),
        senderName: ctx.from?.first_name ?? undefined,
        ...(ctx.from?.username ? { senderUsername: ctx.from.username } : {}),
        ...(ctx.from?.is_bot ? { senderIsBot: true } : {}),
        text: ctx.message.text ?? '',
        timestamp: ctx.message.date * 1000,
        raw: ctx.message,
      }

      this.dispatchMessage(msg)
    })

    // Attachment handlers — photos, documents, voice, video, audio,
    // animations/GIFs, video notes, and stickers. Each maps Telegram's
    // source field onto a single helper that downloads the blob to a temp
    // file, then emits one IncomingMessage with `attachments[0].localPath`
    // set. The router resolves the path via readFileAttachment() and
    // forwards a FileAttachment to the session.
    this.bot.on('message:photo', async (ctx: Context) => {
      if (!isAcceptedChat(ctx, this.supergroupChatId)) {
        this.logRejectedChat('message:photo', ctx)
        return
      }
      const photos = ctx.message?.photo
      // Telegram returns multiple sizes; last one is the largest original.
      const largest = photos?.[photos.length - 1]
      if (!largest) return
      await this.emitAttachmentMessage(ctx, {
        type: 'photo',
        fileId: largest.file_id,
        fileSize: largest.file_size,
        mimeType: 'image/jpeg', // Telegram re-encodes photos to JPEG
      })
    })

    this.bot.on('message:document', async (ctx: Context) => {
      if (!isAcceptedChat(ctx, this.supergroupChatId)) {
        this.logRejectedChat('message:document', ctx)
        return
      }
      const doc = ctx.message?.document
      if (!doc) return
      await this.emitAttachmentMessage(ctx, {
        type: 'document',
        fileId: doc.file_id,
        fileName: doc.file_name,
        fileSize: doc.file_size,
        mimeType: doc.mime_type,
      })
    })

    this.bot.on('message:voice', async (ctx: Context) => {
      if (!isAcceptedChat(ctx, this.supergroupChatId)) {
        this.logRejectedChat('message:voice', ctx)
        return
      }
      const voice = ctx.message?.voice
      if (!voice) return
      await this.emitAttachmentMessage(ctx, {
        type: 'voice',
        fileId: voice.file_id,
        fileSize: voice.file_size,
        mimeType: voice.mime_type ?? 'audio/ogg',
      })
    })

    this.bot.on('message:video', async (ctx: Context) => {
      if (!isAcceptedChat(ctx, this.supergroupChatId)) {
        this.logRejectedChat('message:video', ctx)
        return
      }
      const video = ctx.message?.video
      if (!video) return
      await this.emitAttachmentMessage(ctx, {
        type: 'video',
        fileId: video.file_id,
        fileName: video.file_name,
        fileSize: video.file_size,
        mimeType: video.mime_type ?? 'video/mp4',
      })
    })

    this.bot.on('message:audio', async (ctx: Context) => {
      if (!isAcceptedChat(ctx, this.supergroupChatId)) {
        this.logRejectedChat('message:audio', ctx)
        return
      }
      const audio = ctx.message?.audio
      if (!audio) return
      await this.emitAttachmentMessage(ctx, {
        type: 'audio',
        fileId: audio.file_id,
        fileName: audio.file_name,
        fileSize: audio.file_size,
        mimeType: audio.mime_type ?? 'audio/mpeg',
      })
    })

    this.bot.on('message:animation', async (ctx: Context) => {
      if (!isAcceptedChat(ctx, this.supergroupChatId)) {
        this.logRejectedChat('message:animation', ctx)
        return
      }
      const animation = ctx.message?.animation
      if (!animation) return
      await this.emitAttachmentMessage(ctx, {
        type: 'animation',
        fileId: animation.file_id,
        fileName: animation.file_name,
        fileSize: animation.file_size,
        mimeType: animation.mime_type ?? 'video/mp4',
      })
    })

    this.bot.on('message:video_note', async (ctx: Context) => {
      if (!isAcceptedChat(ctx, this.supergroupChatId)) {
        this.logRejectedChat('message:video_note', ctx)
        return
      }
      const videoNote = ctx.message?.video_note
      if (!videoNote) return
      await this.emitAttachmentMessage(ctx, {
        type: 'video_note',
        fileId: videoNote.file_id,
        fileName: `video-note-${ctx.message?.message_id ?? Date.now()}.mp4`,
        fileSize: videoNote.file_size,
        mimeType: 'video/mp4',
      })
    })

    this.bot.on('message:sticker', async (ctx: Context) => {
      if (!isAcceptedChat(ctx, this.supergroupChatId)) {
        this.logRejectedChat('message:sticker', ctx)
        return
      }
      const sticker = ctx.message?.sticker
      if (!sticker) return
      const mimeType = sticker.is_video
        ? 'video/webm'
        : sticker.is_animated
          ? 'application/x-tgsticker'
          : 'image/webp'
      await this.emitAttachmentMessage(ctx, {
        type: 'sticker',
        fileId: sticker.file_id,
        fileName: `sticker-${ctx.message?.message_id ?? Date.now()}${stickerFileExtension(sticker)}`,
        fileSize: sticker.file_size,
        mimeType,
      })
    })

    // Handle callback queries (button presses)
    this.bot.on('callback_query:data', async (ctx: Context) => {
      if (!this.buttonHandler || !ctx.callbackQuery) return
      if (!isAcceptedChat(ctx, this.supergroupChatId)) {
        this.logRejectedChat('callback_query:data', ctx)
        // Answer the callback so Telegram stops showing the spinner, but
        // don't route it — same rationale as message handlers.
        await ctx.answerCallbackQuery().catch(() => {})
        return
      }

      await ctx.answerCallbackQuery().catch(() => {})

      // The button is attached to a message; reading the message's thread id
      // ensures responses (allow/deny acks, plan accept confirmations) post
      // back into the same topic the prompt came from.
      const threadId = typeof ctx.callbackQuery.message?.message_thread_id === 'number'
        ? ctx.callbackQuery.message.message_thread_id
        : undefined

      const press: ButtonPress = {
        platform: 'telegram',
        channelId: String(ctx.chat?.id ?? ''),
        ...(threadId !== undefined ? { threadId } : {}),
        messageId: String(ctx.callbackQuery.message?.message_id ?? ''),
        senderId: String(ctx.from?.id ?? ''),
        ...(ctx.from?.first_name ? { senderName: ctx.from.first_name } : {}),
        ...(ctx.from?.username ? { senderUsername: ctx.from.username } : {}),
        ...(ctx.from?.is_bot ? { senderIsBot: true } : {}),
        buttonId: ctx.callbackQuery.data ?? '',
        data: ctx.callbackQuery.data ?? undefined,
      }

      this.dispatchButtonPress(press)
    })

    this.log.info('[telegram] initializing')

    // Clear any pre-existing webhook BEFORE bot.init(). grammY's Api client
    // works without init() (which only caches getMe), and if a webhook is set
    // (by a previous app run, another app, or BotFather), getUpdates returns
    // nothing and polling silently receives no messages. Doing this first
    // means even a slow/stuck init() can't prevent webhook cleanup.
    // drop_pending_updates=false preserves messages queued before the user
    // saved the token.
    try {
      await withTimeout(
        this.bot.api.deleteWebhook({ drop_pending_updates: false }),
        10_000,
        'deleteWebhook',
      )
      this.log.info('[telegram] deleteWebhook ok')
    } catch (err) {
      this.log.warn('[telegram] deleteWebhook failed (non-fatal):', describeError(err))
    }

    // Surface token/network errors up-front (getMe). Without the timeout,
    // grammY retries transient errors indefinitely with no logs, which looks
    // identical to a deadlock from the outside.
    try {
      await withTimeout(this.bot.init(), 10_000, 'bot.init')
      this.log.info('[telegram] bot.init ok', {
        username: this.bot.botInfo?.username,
      })
    } catch (err) {
      this.log.error('[telegram] bot.init failed:', describeError(err))
      throw err
    }

    this.startPolling()
    // Do NOT set this.connected = true here — wait for onStart.
  }

  /**
   * Start Telegram long polling and keep it alive.
   *
   * grammY's `bot.start()` returns a promise that resolves when polling stops
   * normally and rejects on fatal polling errors. In production we observed a
   * state where outbound Bot API calls still worked, but inbound updates no
   * longer reached Craft because polling had silently stopped after startup.
   * Treat any stop while this adapter is still live as unexpected: log it,
   * mark the adapter disconnected, and restart polling after a short backoff.
   */
  private startPolling(): void {
    const bot = this.bot
    if (!bot || this.destroyed) return

    bot.start({
      onStart: () => {
        if (this.bot !== bot || this.destroyed) return
        this.connected = true
        this.log.info('[telegram] polling started', {
          event: 'telegram_polling_started',
        })
        // Diagnostic: confirm webhook is really gone + show backlog once.
        // Fire-and-forget; errors here are not fatal to polling.
        bot.api.getWebhookInfo().then(
          (info) => this.log.info('[telegram] webhook state after start:', {
            event: 'telegram_webhook_state',
            url: info.url || null,
            pending_update_count: info.pending_update_count,
          }),
          () => {},
        )
      },
    }).then(() => {
      if (this.bot !== bot || this.destroyed) return
      this.connected = false
      this.log.warn('[telegram] polling stopped unexpectedly; restarting', {
        event: 'telegram_polling_stopped_unexpectedly',
      })
      this.schedulePollingRestart()
    }).catch((err: unknown) => {
      if (this.bot !== bot || this.destroyed) return
      this.connected = false
      this.log.error('[telegram] polling stopped with error; restarting', {
        event: 'telegram_polling_stopped_error',
        error: describeError(err),
      })
      this.schedulePollingRestart()
    })
  }

  private schedulePollingRestart(): void {
    if (this.destroyed || !this.bot || this.pollingRestartTimer) return
    this.pollingRestartTimer = setTimeout(() => {
      this.pollingRestartTimer = null
      this.startPolling()
    }, 1_000)
  }

  private clearPollingRestartTimer(): void {
    if (!this.pollingRestartTimer) return
    clearTimeout(this.pollingRestartTimer)
    this.pollingRestartTimer = null
  }

  /**
   * Download a Telegram file to a temp path and invoke the message handler
   * with the resulting IncomingMessage. Centralised here so the five
   * `bot.on(...)` handlers only need to pick the right source fields.
   *
   * Failures (oversize, 404, network) are reported back to the sender via
   * `ctx.reply()` and logged. The message is NOT forwarded in that case —
   * the session should not be woken for an attachment we couldn't deliver.
   */
  private async emitAttachmentMessage(
    ctx: Context,
    meta: {
      type: IncomingAttachment['type']
      fileId: string
      fileName?: string
      fileSize?: number
      mimeType?: string
    },
  ): Promise<void> {
    if (!this.messageHandler || !ctx.message || !ctx.chat || !this.bot) return

    // Size guard BEFORE hitting the file API — avoids the round-trip when
    // Telegram already told us the size up-front.
    if (meta.fileSize !== undefined && meta.fileSize > MAX_ATTACHMENT_BYTES) {
      this.log.warn('[telegram] attachment too large, dropping', {
        type: meta.type,
        fileSize: meta.fileSize,
      })
      await ctx.reply(
        `Attachment too large (>${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB). Not forwarded.`,
      ).catch(() => {})
      return
    }

    let downloaded: { localPath: string; fileName: string; fileSize: number }
    try {
      downloaded = await this.downloadToTemp(
        meta.fileId,
        meta.fileName ?? `${meta.type}-${Date.now()}`,
        meta.mimeType,
      )
    } catch (err) {
      this.log.error('[telegram] attachment download failed:', describeError(err))
      await ctx.reply(
        'Failed to download your attachment. Please try again.',
      ).catch(() => {})
      return
    }

    const attachment: IncomingAttachment = {
      type: meta.type,
      fileId: meta.fileId,
      fileName: downloaded.fileName,
      mimeType: meta.mimeType,
      fileSize: downloaded.fileSize,
      localPath: downloaded.localPath,
    }

    const threadId = this.extractThreadId(ctx)
    const msg: IncomingMessage = {
      platform: 'telegram',
      channelId: String(ctx.chat.id),
      ...(threadId !== undefined ? { threadId } : {}),
      messageId: String(ctx.message.message_id),
      senderId: String(ctx.from?.id ?? ''),
      senderName: ctx.from?.first_name ?? undefined,
      ...(ctx.from?.username ? { senderUsername: ctx.from.username } : {}),
      ...(ctx.from?.is_bot ? { senderIsBot: true } : {}),
      text: ctx.message.caption ?? '',
      attachments: [attachment],
      timestamp: ctx.message.date * 1000,
      raw: ctx.message,
    }

    this.dispatchMessage(msg)
  }

  /**
   * Resolve a Telegram `file_id` to a local path by calling `getFile()` to
   * obtain the remote path, then fetching the blob from the Bot API file
   * host and writing it to the OS temp dir. Enforces `MAX_ATTACHMENT_BYTES`
   * against the actual downloaded size in case `getFile` reported no size.
   */
  private async downloadToTemp(
    fileId: string,
    fallbackName: string,
    mimeType: string | undefined,
  ): Promise<{ localPath: string; fileName: string; fileSize: number }> {
    if (!this.bot) throw new Error('Telegram adapter not initialized')

    const file = await this.bot.api.getFile(fileId)
    if (!file.file_path) {
      throw new Error(`getFile returned no file_path for ${fileId}`)
    }
    if (file.file_size !== undefined && file.file_size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`file too large: ${file.file_size} bytes`)
    }

    // Extension: prefer whatever Telegram's file_path carries (it's normally
    // `photos/file_123.jpg` or similar), fall back to mime map, else `.bin`.
    let ext = extname(file.file_path)
    if (!ext && mimeType && MIME_EXT_FALLBACK[mimeType]) {
      ext = MIME_EXT_FALLBACK[mimeType]
    }
    if (!ext) ext = '.bin'

    // Normalise fileName — ensure it has the resolved extension so
    // readFileAttachment's extension-based type detection works.
    let fileName = fallbackName
    if (!extname(fileName)) fileName = `${fileName}${ext}`

    const url = `https://api.telegram.org/file/bot${this.bot.token}/${encodeTelegramFilePath(file.file_path)}`
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`download failed: ${res.status} ${res.statusText}`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(`file too large after download: ${buf.byteLength} bytes`)
    }

    const localPath = join(
      tmpdir(),
      `craft-agent-messaging-${randomBytes(8).toString('hex')}${ext}`,
    )
    writeFileSync(localPath, buf)
    return { localPath, fileName, fileSize: buf.byteLength }
  }

  async destroy(): Promise<void> {
    this.destroyed = true
    this.connected = false
    this.clearPollingRestartTimer()
    if (this.bot) {
      await this.bot.stop()
      this.bot = null
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler
  }

  onButtonPress(handler: (press: ButtonPress) => Promise<void>): void {
    this.buttonHandler = handler
  }

  async sendText(channelId: string, text: string, opts?: SendOptions): Promise<SentMessage> {
    if (!this.bot) throw new Error('Telegram adapter not initialized')
    const formatted = formatForTelegram(text)
    const sent = await this.bot.api.sendMessage(
      Number(channelId),
      formatted,
      threadParams(opts),
    )
    return {
      platform: 'telegram',
      channelId,
      messageId: String(sent.message_id),
    }
  }

  async editMessage(channelId: string, messageId: string, text: string, _opts?: SendOptions): Promise<void> {
    if (!this.bot) throw new Error('Telegram adapter not initialized')
    const formatted = formatForTelegram(text)
    // editMessageText is keyed by (chat_id, message_id) — Telegram does not
    // accept message_thread_id here. We accept the option for caller
    // uniformity but ignore it.
    await this.bot.api.editMessageText(Number(channelId), Number(messageId), formatted)
  }

  async sendButtons(channelId: string, text: string, buttons: InlineButton[], opts?: SendOptions): Promise<SentMessage> {
    if (!this.bot) throw new Error('Telegram adapter not initialized')

    const keyboard = {
      inline_keyboard: buttons.map((b) => [{
        text: b.label,
        callback_data: b.id,
      }]),
    }

    const sent = await this.bot.api.sendMessage(Number(channelId), text, {
      reply_markup: keyboard,
      ...threadParams(opts),
    })

    return {
      platform: 'telegram',
      channelId,
      messageId: String(sent.message_id),
    }
  }

  async sendTyping(channelId: string, opts?: SendOptions): Promise<void> {
    if (!this.bot) return
    await this.bot.api
      .sendChatAction(Number(channelId), 'typing', threadParams(opts))
      .catch(() => {})
  }

  async sendFile(channelId: string, file: Buffer, filename: string, caption?: string, opts?: SendOptions): Promise<SentMessage> {
    if (!this.bot) throw new Error('Telegram adapter not initialized')

    const inputFile = new InputFile(file, filename)
    const sent = await this.bot.api.sendDocument(
      Number(channelId),
      inputFile,
      { caption, ...threadParams(opts) },
    )

    return {
      platform: 'telegram',
      channelId,
      messageId: String(sent.message_id),
    }
  }

  async clearButtons(channelId: string, messageId: string, _opts?: SendOptions): Promise<void> {
    if (!this.bot) return
    try {
      // editMessageReplyMarkup is also keyed by (chat_id, message_id) only.
      await this.bot.api.editMessageReplyMarkup(Number(channelId), Number(messageId), {
        reply_markup: { inline_keyboard: [] },
      })
    } catch {
      // Non-fatal: message may have been deleted by the user or already cleared.
    }
  }

  /**
   * Phase B prep: create a new forum topic in a supergroup. Telegram returns
   * `{ message_thread_id, name, ... }`; we surface a normalised shape.
   *
   * Requires the bot to have "Manage Topics" admin permission in the
   * supergroup. If the call fails (privilege missing, chat is not a forum,
   * etc.), the error propagates so the caller can surface it.
   *
   * `iconColor` is intentionally omitted from this stub — grammY's typing
   * accepts only the six Telegram-defined palette ints. We'll plumb it
   * properly in Phase B when the automation feature actually picks colours.
   */
  async createForumTopic(
    chatId: string,
    name: string,
  ): Promise<{ threadId: number; name: string }> {
    if (!this.bot) throw new Error('Telegram adapter not initialized')
    const result = await this.bot.api.createForumTopic(Number(chatId), name)
    return { threadId: result.message_thread_id, name: result.name }
  }
}

/**
 * Build the `{ message_thread_id }` fragment passed to grammY API calls.
 * Returns an empty object when no thread is requested so the spread is a
 * no-op and Telegram receives no `message_thread_id` (which is what the
 * General topic / DM shapes expect).
 */
function threadParams(opts?: SendOptions): { message_thread_id?: number } {
  if (opts?.threadId === undefined) return {}
  return { message_thread_id: opts.threadId }
}

function encodeTelegramFilePath(filePath: string): string {
  return filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

function stickerFileExtension(sticker: { is_video?: boolean; is_animated?: boolean }): string {
  if (sticker.is_video) return '.webm'
  if (sticker.is_animated) return '.tgs'
  return '.webp'
}
