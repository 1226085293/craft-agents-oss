/**
 * WeChatAdapter — WeChat personal-account bot via ClawBot / OpenClaw iLink API.
 *
 * Protocol: JSON over HTTP (long-polling).
 *   - Receive:  POST {base}/ilink/bot/getupdates   (35s long-poll)
 *   - Send:     POST {base}/ilink/bot/sendmessage  (echo context_token)
 *   - Typing:   POST {base}/ilink/bot/sendtyping   (needs typing_ticket from getconfig)
 *   - Config:   POST {base}/ilink/bot/getconfig
 *   - Lifecycle:notifyStart / notifyStop
 *
 * Auth headers:
 *   Authorization:      Bearer <bot_token>            (issued at QR login)
 *   AuthorizationType:  ilink_bot_token
 *   X-WECHAT-UIN:       base64(random uint32)
 *   iLink-App-Id:       bot
 *   iLink-App-ClientVersion: 0x00020406 (2.4.6)
 *
 * Credentials (JSON in `config.token`):
 *   { "botToken": "...", "baseUrl": "https://ilinkai.weixin.qq.com", "botId": "...", "userId": "..." }
 */

import { randomBytes, randomUUID } from 'node:crypto'

/** Generate a client_id matching the official OpenClaw format. */
function generateClientId(): string {
  return `openclaw-weixin:${Date.now()}-${randomBytes(4).toString('hex')}`
}
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import type {
  AdapterCapabilities,
  IncomingMessage,
  PlatformAdapter,
  PlatformConfig,
  SendOptions,
  SentMessage,
  InlineButton,
  MessagingLogger,
} from '../../types'

const NOOP_LOGGER: MessagingLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
}

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
const CHANNEL_VERSION = '2.4.6'
const ILINK_APP_ID = 'bot'

// ---- Persistence (mirrors official @tencent-weixin/openclaw-weixin) ----
// context tokens + get_updates_buf survive gateway restarts so replies keep
// working after a restart without waiting for a fresh inbound message.
function wechatStateDir(): string {
  return path.join(homedir(), '.craft-agent', 'wechat-state')
}

function contextTokensFilePath(botId: string): string {
  return path.join(wechatStateDir(), `${botId}.context-tokens.json`)
}

function syncBufFilePath(botId: string): string {
  return path.join(wechatStateDir(), `${botId}.sync.json`)
}

function loadJsonFile<T>(filePath: string): T | undefined {
  try {
    if (!existsSync(filePath)) return undefined
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T
  } catch {
    return undefined
  }
}

function saveJsonFile(filePath: string, data: unknown): void {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true })
    writeFileSync(filePath, JSON.stringify(data), 'utf-8')
  } catch {
    // best-effort persistence
  }
}
// buildClientVersion('2.4.6'): (major<<16) | (minor<<8) | patch = (2<<16)|(4<<8)|6 = 132102 = 0x00020406
const ILINK_APP_CLIENT_VERSION = (2 << 16) | (4 << 8) | 6
const LONG_POLL_TIMEOUT_MS = 35_000
const API_TIMEOUT_MS = 15_000
const CONFIG_TIMEOUT_MS = 10_000

// MessageItemType
const ITEM_TEXT = 1
const ITEM_IMAGE = 2
const ITEM_VOICE = 3
const ITEM_FILE = 4
const ITEM_VIDEO = 5

// MessageType
const MSG_USER = 1
const MSG_BOT = 2

// MessageState
const STATE_FINISH = 2

// TypingStatus
const TYPING_TYPING = 1
const TYPING_CANCEL = 2

export interface WeChatCredentials {
  botToken: string
  baseUrl?: string
  botId?: string
  userId?: string
}

export function parseWeChatCredentials(raw: string): WeChatCredentials {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('WeChat credentials are malformed (expected JSON).')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('WeChat credentials are malformed (expected JSON object).')
  }
  const obj = parsed as Record<string, unknown>
  const botToken = typeof obj.botToken === 'string' ? obj.botToken.trim() : ''
  if (!botToken) throw new Error('WeChat botToken is missing.')
  const baseUrl = typeof obj.baseUrl === 'string' && obj.baseUrl.trim() ? obj.baseUrl.trim() : DEFAULT_BASE_URL
  const botId = typeof obj.botId === 'string' ? obj.botId : undefined
  const userId = typeof obj.userId === 'string' ? obj.userId : undefined
  return { botToken, baseUrl, botId, userId }
}

interface WeixinMessage {
  seq?: number
  message_id?: number
  from_user_id?: string
  to_user_id?: string
  client_id?: string
  create_time_ms?: number
  session_id?: string
  group_id?: string
  message_type?: number
  message_state?: number
  item_list?: WeixinMessageItem[]
  context_token?: string
  run_id?: string
}

interface WeixinMessageItem {
  type?: number
  msg_id?: string
  ref_msg?: { title?: string; message_item?: WeixinMessageItem }
  text_item?: { text?: string }
  voice_item?: { text?: string; playtime?: number }
  image_item?: Record<string, unknown>
  file_item?: { file_name?: string; len?: string }
  video_item?: Record<string, unknown>
}

interface GetUpdatesResp {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WeixinMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

interface SendMessageResp {
  ret?: number
  errmsg?: string
}

interface GetConfigResp {
  ret?: number
  errmsg?: string
  typing_ticket?: string
}

// ---------------------------------------------------------------------------
// Channel parsing — WeChat peers
//   private:<from_user_id>   C2C direct message
//   group:<group_id>         group chat
// ---------------------------------------------------------------------------

export interface WeChatChannelRef {
  kind: 'private' | 'group'
  id: string
}

export function parseWeChatChannel(channelId: string): WeChatChannelRef {
  const sep = channelId.indexOf(':')
  if (sep === -1) return { kind: 'private', id: channelId }
  const kind = channelId.slice(0, sep)
  const id = channelId.slice(sep + 1)
  if (kind === 'group') return { kind: 'group', id }
  return { kind: 'private', id }
}

function channelIdOf(kind: 'private' | 'group', id: string): string {
  return `${kind}:${id}`
}

function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32), 'utf-8').toString('base64')
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class WeChatAdapter implements PlatformAdapter {
  readonly platform = 'wechat' as const
  readonly capabilities: AdapterCapabilities = {
    messageEditing: false,
    inlineButtons: false,
    maxButtons: 0,
    maxMessageLength: 4000,
    markdown: 'v2',
    webhookSupport: false,
  }

  private creds: WeChatCredentials | null = null
  private log: MessagingLogger = NOOP_LOGGER
  private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null
  private connected = false
  private destroyed = false

  // Long-poll state
  private updatesBuf = ''
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private pollLoopPromise: Promise<void> | null = null

  // context_token per sender (key: from_user_id), refreshed on every inbound msg
  // + persisted to disk so replies keep working after restarts (official behavior)
  private contextTokens = new Map<string, string>()
  private botIdForState = ''
  // typing_ticket cached from getconfig
  private typingTicket: string | undefined

  async initialize(config: PlatformConfig): Promise<void> {
    this.log = config.logger ?? NOOP_LOGGER
    const raw = typeof config.token === 'string' ? config.token : ''
    if (!raw) throw new Error('WeChat credentials are missing.')
    this.creds = parseWeChatCredentials(raw)

    // Restore persisted context tokens + get_updates_buf (official restart behavior)
    this.botIdForState = this.creds.botId ?? `wechat-${Buffer.from(this.creds.botToken).toString('hex').slice(0, 12)}`
    const storedTokens = loadJsonFile<Record<string, string>>(contextTokensFilePath(this.botIdForState))
    if (storedTokens) {
      for (const [k, v] of Object.entries(storedTokens)) {
        if (typeof v === 'string' && v) this.contextTokens.set(k, v)
      }
      this.log.info(`[wechat] restored ${this.contextTokens.size} context token(s) from disk`, {
        event: 'wechat_restored_context_tokens',
        count: this.contextTokens.size,
      })
    }
    const storedBuf = loadJsonFile<{ get_updates_buf?: string }>(syncBufFilePath(this.botIdForState))
    if (storedBuf?.get_updates_buf) {
      this.updatesBuf = storedBuf.get_updates_buf
      this.log.info(`[wechat] restored get_updates_buf (${this.updatesBuf.length} bytes) from disk`, {
        event: 'wechat_restored_sync_buf',
        bytes: this.updatesBuf.length,
      })
    }

    this.destroyed = false
    this.connected = true

    // Register with the server that this client is starting.
    await this.callApi('ilink/bot/msg/notifystart', {}, CONFIG_TIMEOUT_MS).catch((err) => {
      this.log.warn('[wechat] notifyStart failed (non-fatal)', {
        event: 'wechat_notify_start_failed',
        error: err instanceof Error ? err.message : String(err),
      })
    })

    // Kick off the long-poll loop (not awaited — runs in background).
    this.pollLoopPromise = this.pollLoop().catch((err) => {
      if (this.destroyed) return
      this.log.error('[wechat] poll loop crashed', {
        event: 'wechat_poll_crashed',
        error: err instanceof Error ? err.message : String(err),
      })
      this.connected = false
      // Single retry after 5s if not destroyed.
      if (!this.destroyed) {
        this.pollTimer = setTimeout(() => {
          this.pollTimer = null
          if (!this.destroyed) {
            this.connected = true
            this.pollLoopPromise = this.pollLoop().catch(() => {})
          }
        }, 5_000)
      }
    })
  }

  async destroy(): Promise<void> {
    this.destroyed = true
    this.connected = false
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    // Notify server we're stopping (best-effort, non-blocking).
    if (this.creds) {
      await this.callApi('ilink/bot/msg/notifystop', {}, CONFIG_TIMEOUT_MS).catch(() => {})
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler
  }

  onButtonPress(_handler: (press: never) => Promise<void>): void {
    // WeChat has no inline buttons — nothing to deliver.
  }

  // -------------------------------------------------------------------------
  // Long-poll receive loop
  // -------------------------------------------------------------------------

  private async pollLoop(): Promise<void> {
    while (!this.destroyed) {
      const resp = await this.getUpdatesOnce()
      if (this.destroyed) break
      if (resp.msgs?.length) {
        for (const msg of resp.msgs) {
          if (this.destroyed) break
          await this.handleInbound(msg)
        }
      }
      // Respect server-suggested timeout if any.
      if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
        await sleep(Math.min(resp.longpolling_timeout_ms, 5_000))
      }
    }
  }

  private async getUpdatesOnce(): Promise<GetUpdatesResp> {
    if (!this.creds) return { ret: 0, msgs: [], get_updates_buf: '' }
    try {
      const raw = await this.callApi(
        'ilink/bot/getupdates',
        {
          get_updates_buf: this.updatesBuf,
        },
        LONG_POLL_TIMEOUT_MS,
      )
      const resp = JSON.parse(raw) as GetUpdatesResp
      if (typeof resp.get_updates_buf === 'string' && resp.get_updates_buf.length > 0) {
        this.updatesBuf = resp.get_updates_buf
        saveJsonFile(syncBufFilePath(this.botIdForState), { get_updates_buf: this.updatesBuf })
      }
      return resp
    } catch (err) {
      // Long-poll timeout is normal control flow → just retry.
      if (this.destroyed) return { ret: 0, msgs: [], get_updates_buf: this.updatesBuf }
      const name = err instanceof Error ? err.name : ''
      if (name === 'AbortError' || (err instanceof Error && /timed?out|abort/i.test(err.message))) {
        return { ret: 0, msgs: [], get_updates_buf: this.updatesBuf }
      }
      this.log.warn('[wechat] getupdates failed (will retry)', {
        event: 'wechat_getupdates_failed',
        error: err instanceof Error ? err.message : String(err),
      })
      await sleep(2_000)
      return { ret: 0, msgs: [], get_updates_buf: this.updatesBuf }
    }
  }

  // -------------------------------------------------------------------------
  // Inbound conversion
  // -------------------------------------------------------------------------

  private async handleInbound(msg: WeixinMessage): Promise<void> {
    const from = msg.from_user_id ?? ''
    if (!from) return
    // Only treat USER messages as inbound; ignore bot-echoes / system messages.
    if (msg.message_type !== undefined && msg.message_type !== MSG_USER) return

    const groupId = msg.group_id
    const chatKind: 'private' | 'group' = groupId ? 'group' : 'private'

    this.log.info('[wechat] inbound raw msg', {
      event: 'wechat_inbound_raw',
      sender: from,
      seq: msg.seq ?? undefined,
      messageId: msg.message_id ?? undefined,
      sessionId: msg.session_id ?? undefined,
      groupId: msg.group_id ?? undefined,
      toUserId: msg.to_user_id ?? undefined,
      clientId: msg.client_id ?? undefined,
      messageType: msg.message_type ?? undefined,
      messageState: msg.message_state ?? undefined,
      contextToken: msg.context_token ? 'present' : 'none',
      itemTypes: msg.item_list?.map((i) => i.type).join(',') ?? 'none',
    })

    // Cache context_token for replying to this sender (persisted for restarts).
    if (msg.context_token) {
      this.contextTokens.set(from, msg.context_token)
      saveJsonFile(contextTokensFilePath(this.botIdForState), Object.fromEntries(this.contextTokens))
      this.log.info(`[wechat] cached context_token for ${from}`, {
        event: 'wechat_context_token_cached',
        sender: from,
      })
    } else {
      this.log.warn(`[wechat] inbound message WITHOUT context_token from ${from}`, {
        event: 'wechat_no_context_token',
        sender: from,
        messageId: String(msg.message_id ?? msg.client_id ?? ''),
      })
    }

    const text = extractBody(msg.item_list)
    const attachments = collectAttachments(msg)

    const incoming: IncomingMessage = {
      platform: 'wechat',
      channelId: chatKind === 'group' ? channelIdOf('group', groupId!) : channelIdOf('private', from),
      messageId: String(msg.message_id ?? msg.client_id ?? `${msg.seq ?? ''}:${Date.now()}`),
      senderId: from,
      senderName: from,
      text,
      chatKind,
      // ClawBot group chats only deliver @-mention / bot-directed messages,
      // so group inbound is treated as an explicit mention.
      mentionKind: chatKind === 'group' ? 'at' : undefined,
      attachments: attachments.length ? attachments : undefined,
      timestamp: msg.create_time_ms ?? Date.now(),
      raw: msg,
    }
    // Send a typing indicator immediately (fire-and-forget) so the WeChat
    // client activates/opens the bot conversation. The official plugin does
    // this on every inbound message; without it the client never surfaces
    // the bot chat and replies go unseen.
    this.sendTyping(incoming.channelId).catch(() => {})
    if (this.messageHandler) {
      await this.messageHandler(incoming)
    }
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  async sendText(channelId: string, text: string, _opts?: SendOptions): Promise<SentMessage> {
    const { kind, id } = parseWeChatChannel(channelId)
    const clientId = generateClientId()
    const msg: WeixinMessage = {
      from_user_id: '',
      to_user_id: id,
      client_id: clientId,
      message_type: MSG_BOT,
      message_state: STATE_FINISH,
      item_list: [{ type: ITEM_TEXT, text_item: { text } }],
      run_id: randomUUID(),
    }
    if (kind === 'group') msg.group_id = id
    const ctx = this.contextTokens.get(id)
    if (ctx) msg.context_token = ctx
    else this.log.warn(`[wechat] sendText: no context_token for ${id} — sending without context`, {
      event: 'wechat_send_no_context',
      to: id,
    })
    try {
      await this.sendMessageApi(msg)
    } catch (err) {
      this.log.error('[wechat] sendText failed', {
        event: 'wechat_send_failed',
        to: id,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
    this.log.info(`[wechat] sendText ok to=${id} contextToken=${ctx ? 'yes' : 'no'} textLen=${text.length}`, {
      event: 'wechat_send_ok',
      to: id,
      contextToken: ctx ? 'yes' : 'no',
      textLen: text.length,
    })
    return { platform: 'wechat', channelId, messageId: clientId }
  }

  async editMessage(_channelId: string, _messageId: string, _text: string, _opts?: SendOptions): Promise<void> {
    throw new Error('WeChat does not support message editing')
  }

  async sendButtons(
    _channelId: string,
    _text: string,
    _buttons: InlineButton[],
    _opts?: SendOptions,
  ): Promise<SentMessage> {
    throw new Error('WeChat does not support inline buttons')
  }

  async sendTyping(channelId: string, _opts?: SendOptions): Promise<void> {
    // Needs a typing_ticket fetched via getconfig per user.
    const { kind, id } = parseWeChatChannel(channelId)
    if (kind !== 'private') return // group typing unsupported
    if (!this.creds) return
    if (!this.typingTicket) {
      try {
        const raw = await this.callApi(
          'ilink/bot/getconfig',
          { ilink_user_id: id, context_token: this.contextTokens.get(id) },
          CONFIG_TIMEOUT_MS,
        )
        const cfg = JSON.parse(raw) as GetConfigResp
        this.typingTicket = cfg.typing_ticket
      } catch {
        return
      }
    }
    if (!this.typingTicket) return
    await this.callApi(
      'ilink/bot/sendtyping',
      { ilink_user_id: id, typing_ticket: this.typingTicket, status: TYPING_TYPING },
      CONFIG_TIMEOUT_MS,
    ).catch(() => {})
  }

  async sendFile(
    channelId: string,
    _file: Buffer,
    _filename: string,
    caption?: string,
    _opts?: SendOptions,
  ): Promise<SentMessage> {
    // File/photo send requires CDN upload (getuploadurl + AES-128-ECB encrypt).
    // Fallback: send caption as text so users aren't left hanging.
    const { kind, id } = parseWeChatChannel(channelId)
    const clientId = generateClientId()
    const msg: WeixinMessage = {
      from_user_id: '',
      to_user_id: id,
      client_id: clientId,
      message_type: MSG_BOT,
      message_state: STATE_FINISH,
      item_list: caption ? [{ type: ITEM_TEXT, text_item: { text: caption } }] : undefined,
      run_id: randomUUID(),
    }
    if (kind === 'group') msg.group_id = id
    const ctx = this.contextTokens.get(id)
    if (ctx) msg.context_token = ctx
    await this.sendMessageApi(msg)
    return { platform: 'wechat', channelId, messageId: clientId }
  }

  // -------------------------------------------------------------------------
  // HTTP helpers
  // -------------------------------------------------------------------------

  private async sendMessageApi(msg: WeixinMessage): Promise<void> {
    const raw = await this.callApi(
      'ilink/bot/sendmessage',
      { msg },
      API_TIMEOUT_MS,
    )
    const resp = JSON.parse(raw) as SendMessageResp
    this.log.info('sendMessage raw response', {
      event: 'wechat_sendmessage_raw',
      ret: resp.ret,
      errmsg: resp.errmsg,
      raw: raw.slice(0, 500),
    })
    if (resp.ret && resp.ret !== 0) {
      throw new Error(`sendMessage ret=${resp.ret} errmsg=${resp.errmsg ?? '(none)'}`)
    }
  }

  private async callApi(endpoint: string, body: Record<string, unknown>, timeoutMs: number): Promise<string> {
    if (!this.creds) throw new Error('WeChat adapter is not initialized')
    const base = this.creds.baseUrl ?? DEFAULT_BASE_URL
    const url = `${base.replace(/\/+$/, '')}/${endpoint}`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.creds.botToken}`,
        AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': randomWechatUin(),
        'iLink-App-Id': ILINK_APP_ID,
        'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
      },
      body: JSON.stringify({
        ...body,
        base_info: { channel_version: CHANNEL_VERSION, bot_agent: 'OpenClaw' },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const rawText = await res.text()
    if (!res.ok) {
      throw new Error(`${endpoint} HTTP ${res.status}: ${rawText.slice(0, 300)}`)
    }
    return rawText
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Extract text body from item_list (text items + voice auto-transcription). */
export function extractBody(itemList?: WeixinMessageItem[]): string {
  if (!itemList?.length) return ''
  for (const item of itemList) {
    if (item.type === ITEM_TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text)
      const ref = item.ref_msg
      if (!ref) return text
      const parts: string[] = []
      if (ref.title) parts.push(ref.title)
      if (ref.message_item) {
        const refBody = extractBody([ref.message_item])
        if (refBody) parts.push(refBody)
      }
      if (!parts.length) return text
      return `[引用: ${parts.join(' | ')}]\n${text}`
    }
    // Voice messages arrive with WeChat auto-transcription in voice_item.text.
    if (item.type === ITEM_VOICE && item.voice_item?.text) {
      return item.voice_item.text
    }
  }
  return ''
}

/** Describe media items as attachment metadata (download not yet implemented). */
export function collectAttachments(msg: WeixinMessage): Array<{ type: 'photo' | 'document' | 'voice' | 'video'; fileId: string; fileName?: string }> {
  const out: Array<{ type: 'photo' | 'document' | 'voice' | 'video'; fileId: string; fileName?: string }> = []
  for (const item of msg.item_list ?? []) {
    if (item.type === ITEM_IMAGE) {
      out.push({ type: 'photo', fileId: item.msg_id ?? `img:${msg.message_id ?? ''}` })
    } else if (item.type === ITEM_VIDEO) {
      out.push({ type: 'video', fileId: item.msg_id ?? `video:${msg.message_id ?? ''}` })
    } else if (item.type === ITEM_FILE) {
      out.push({
        type: 'document',
        fileId: item.msg_id ?? `file:${msg.message_id ?? ''}`,
        fileName: item.file_item?.file_name,
      })
    } else if (item.type === ITEM_VOICE) {
      out.push({ type: 'voice', fileId: item.msg_id ?? `voice:${msg.message_id ?? ''}` })
    }
  }
  return out
}
