/**
 * QQAdapter — QQ Open Platform (v2) in-process adapter.
 *
 * Transport: WebSocket gateway + REST API, implemented directly against the
 * official protocol (no third-party SDK — `qq-guild-bot` only supports QQ
 * channels, not group chats or C2C DMs).
 *
 * Scope:
 *  - Group chats: `GROUP_AT_MESSAGE_CREATE` (@-mention of the bot only).
 *  - C2C DMs: `C2C_MESSAGE_CREATE`. When `mainQqOpenIds` is configured,
 *    ONLY those senders' DMs are forwarded (others are dropped with a log
 *    line); when unset, all C2C DMs are forwarded and access-control
 *    (owner-only by default) gates slash commands.
 *
 * Channel encoding:
 *  - Group chat  → `group:{group_openid}`
 *  - C2C DM      → `user:{user_openid}`
 * This keeps the two kinds distinct inside bindings and lets `sendText`
 * pick the right REST endpoint from the channel id alone.
 *
 * Auth: AppID + AppSecret → AccessToken (POST bots.qq.com/app/getAppAccessToken,
 * ~7200s TTL, cached + auto-refreshed) → WebSocket gateway with
 * `Authorization: QQBot <token>`.
 */

import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import type {
  PlatformAdapter,
  PlatformConfig,
  AdapterCapabilities,
  IncomingAttachment,
  IncomingMessage,
  InlineButton,
  ButtonPress,
  SentMessage,
  SendOptions,
  MessagingLogger,
} from '../../types'

/**
 * Hard cap for downloaded/uploaded attachment size. Matches Telegram's
 * MAX_ATTACHMENT_BYTES — larger files get dropped with a log line.
 */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

const NOOP_LOGGER: MessagingLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
}

const QQ_API_BASE = 'https://api.sgroup.qq.com'
const QQ_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'

// Gateway opcodes (shared with QQ guilds).
const OP_DISPATCH = 0
const OP_HEARTBEAT = 1
const OP_IDENTIFY = 2
const OP_RESUME = 6
const OP_RECONNECT = 7
const OP_INVALID_SESSION = 9
const OP_HELLO = 10
const OP_HEARTBEAT_ACK = 11

/** Group @-messages and C2C DMs share a single intent bit (1 << 25). */
const INTENT_GROUP_AND_C2C = 1 << 25

/** Reconnect delays for unexpected socket close (exponential, capped). */
const RECONNECT_DELAYS_MS = [5_000, 10_000, 30_000, 60_000, 5 * 60_000]

/** Credential payload stored in the `messaging_bearer` row (name `qq`). */
export interface QQCredentials {
  appId: string
  appSecret: string
}

/**
 * Parse the JSON-encoded credentials from `PlatformConfig.token`.
 * Throws with a clear message if malformed — surfaces as `state: 'error'`.
 */
export function parseQQCredentials(token: string | undefined): QQCredentials {
  if (!token) throw new Error('QQ credentials are missing')
  let parsed: unknown
  try {
    parsed = JSON.parse(token)
  } catch {
    throw new Error('QQ credentials are not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('QQ credentials must be a JSON object')
  }
  const { appId, appSecret } = parsed as Record<string, unknown>
  if (typeof appId !== 'string' || appId.length === 0) {
    throw new Error('QQ credentials are missing `appId`')
  }
  if (typeof appSecret !== 'string' || appSecret.length === 0) {
    throw new Error('QQ credentials are missing `appSecret`')
  }
  return { appId, appSecret }
}

interface QQWsPayload {
  op: number
  s?: number
  t?: string
  d?: unknown
}

/** Inbound dispatch payloads we care about (group + C2C messages). */
interface QQMessageEvent {
  id?: string
  group_openid?: string
  author?: { member_openid?: string; user_openid?: string }
  content?: string
  timestamp?: string
  /** Rich-media attachments (images/files/video/audio) carried by the event. */
  attachments?: Array<{
    content_type?: string
    filename?: string
    height?: number
    size?: number
    url?: string
    width?: number
  }>
}

/** Decode the `data` of a WebSocket MessageEvent to text. */
function wsEventText(event: MessageEvent): string {
  const data = event.data
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  return ''
}

/** Parse a `group:` / `user:` prefixed channel id back into its parts. */
function parseChannel(channelId: string): { kind: 'group' | 'user'; id: string } {
  const sep = channelId.indexOf(':')
  if (sep > 0) {
    const kind = channelId.slice(0, sep)
    if (kind === 'group' || kind === 'user') {
      return { kind, id: channelId.slice(sep + 1) }
    }
  }
  // Unprefixed ids are treated as C2C user openids (back-compat with
  // bindings created before the prefix scheme existed).
  return { kind: 'user', id: channelId }
}

function isImageName(filename: string): boolean {
  return /\.(jpe?g|png|gif|webp|bmp)$/i.test(filename)
}

function isVideoName(filename: string): boolean {
  return /\.(mp4|mov|mkv|avi|webm)$/i.test(filename)
}

function isAudioName(filename: string): boolean {
  return /\.(mp3|aac|m4a|wav|ogg|flac)$/i.test(filename)
}

/**
 * Map a filename to QQ's rich-media `file_type`:
 * 1=image 2=video 3=audio 4=file.
 */
function qqFileType(filename: string): number {
  if (isImageName(filename)) return 1
  if (isVideoName(filename)) return 2
  if (isAudioName(filename)) return 3
  return 4
}

/** Map an inbound QQ attachment's MIME/filename to an `IncomingAttachment` type. */
function qqInboundAttachmentType(
  mimeType: string | undefined,
  filename: string | undefined,
): IncomingAttachment['type'] {
  if (mimeType) {
    if (mimeType.startsWith('image/')) return 'photo'
    if (mimeType.startsWith('video/')) return 'video'
    if (mimeType.startsWith('audio/')) return 'audio'
  }
  if (filename) {
    if (isImageName(filename)) return 'photo'
    if (isVideoName(filename)) return 'video'
    if (isAudioName(filename)) return 'audio'
  }
  return 'document'
}

/** Strip QQ's `<@!openid>` mention prefix (and inline mentions) from content. */
export function stripMentions(text: string): string {
  return text.replace(/<@!?[^>]*>/g, '').trim()
}

/** Extract all @-mention openids from QQ content (`<@!xxx>` or `<@xxx>`). */
export function extractAllMentions(text: string): string[] {
  const out: string[] = []
  const re = /<@!?([^>]+)>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const id = m[1]
    if (id) out.push(id)
  }
  return out
}

/** Extract the first @-mention openid from QQ content, or null. */
export function extractFirstMention(text: string): string | null {
  const m = /<@!?([^>]+)>/.exec(text)
  return m?.[1] ?? null
}

export class QQAdapter implements PlatformAdapter {
  readonly platform = 'qq' as const
  readonly capabilities: AdapterCapabilities = {
    messageEditing: false,
    inlineButtons: false,
    maxButtons: 0,
    maxMessageLength: 2000,
    markdown: 'v2',
    webhookSupport: false,
  }

  private creds: QQCredentials | null = null
  private ws: WebSocket | null = null
  private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null
  private connected = false
  private destroyed = false
  private log: MessagingLogger = NOOP_LOGGER

  // Auth state
  private accessToken: string | null = null
  private tokenExpiresAt = 0
  private tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null

  // Gateway state
  private sessionId: string | null = null
  private lastSeq: number | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatAckPending = false
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private gatewayUrl: string | null = null

  /**
   * OpenIDs allowed to DM the bot (C2C). Empty = forward all C2C DMs
   * (access-control still gates commands). Updated at runtime by the
   * registry via `setMainQqOpenIds()` without restarting the socket.
   */
  private mainQqOpenIds: string[] = []

  /**
   * The bot's own OpenID in group chats. Used to filter
   * GROUP_MESSAGE_CREATE events: only messages with an @-mention
   * matching this openid are forwarded. Learnt from the first
   * GROUP_AT_MESSAGE_CREATE event or from the first unambiguous
   * single @-mention in a GROUP_MESSAGE_CREATE event.
   * Can also be pre-configured via `config.botOpenId`.
   */
  private botOpenId: string | null = null

  // -------------------------------------------------------------------------
  // Token lifecycle
  // -------------------------------------------------------------------------

  /**
   * Return a valid access token, fetching + caching a fresh one when the
   * cached token is missing or near expiry. QQ tokens live ~7200s; we
   * refresh 60s early to avoid mid-flight expiry.
   */
  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken
    }
    if (!this.creds) throw new Error('QQ adapter is not initialized')

    const res = await fetch(QQ_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'QQBot/1.0' },
      body: JSON.stringify({ appId: this.creds.appId, clientSecret: this.creds.appSecret }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      throw new Error(`QQ access token request failed: HTTP ${res.status}`)
    }
    const body = (await res.json()) as { access_token?: string; expires_in?: number; code?: number; message?: string }
    if (!body.access_token) {
      throw new Error(`QQ access token request failed: ${body.message ?? `code ${body.code ?? 'unknown'}`}`)
    }
    this.accessToken = body.access_token
    this.tokenExpiresAt = Date.now() + (body.expires_in ?? 7200) * 1000
    this.scheduleTokenRefresh()
    return this.accessToken
  }

  /** Pre-emptively refresh the token shortly before it expires. */
  private scheduleTokenRefresh(): void {
    if (this.tokenRefreshTimer) clearTimeout(this.tokenRefreshTimer)
    const msUntil = Math.max(this.tokenExpiresAt - Date.now() - 60_000, 1_000)
    this.tokenRefreshTimer = setTimeout(() => {
      this.tokenRefreshTimer = null
      this.getAccessToken().catch((err) => {
        this.log.warn('[qq] token refresh failed (will retry on next use)', {
          event: 'qq_token_refresh_failed',
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }, msUntil)
  }

  /** Resolve the gateway websocket URL (cached; refetched on reconnect). */
  private async getGatewayUrl(force = false): Promise<string> {
    if (!force && this.gatewayUrl) return this.gatewayUrl
    const token = await this.getAccessToken()
    const res = await fetch(`${QQ_API_BASE}/gateway/bot`, {
      headers: { Authorization: `QQBot ${token}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      throw new Error(`QQ gateway request failed: HTTP ${res.status}`)
    }
    const body = (await res.json()) as { url?: string; code?: number; message?: string }
    if (!body.url) {
      throw new Error(`QQ gateway request failed: ${body.message ?? `code ${body.code ?? 'unknown'}`}`)
    }
    this.gatewayUrl = body.url
    return this.gatewayUrl
  }

  // -------------------------------------------------------------------------
  // PlatformAdapter lifecycle
  // -------------------------------------------------------------------------

  /** Fetch bot identity for UI hints (QQ exposes no bot-profile API; appId serves). */
  async getBotInfo(): Promise<{ appId: string } | null> {
    return this.creds ? { appId: this.creds.appId } : null
  }

  async initialize(config: PlatformConfig): Promise<void> {
    this.log = config.logger ?? NOOP_LOGGER
    this.creds = parseQQCredentials(config.token)
    const mainQqOpenIds = Array.isArray(config.mainQqOpenIds)
      ? (config.mainQqOpenIds as string[]).filter((id): id is string => typeof id === 'string' && id.length > 0)
      : []
    this.mainQqOpenIds = mainQqOpenIds
    const configuredBotOpenId = (config as Record<string, unknown>).botOpenId
    this.botOpenId =
      typeof configuredBotOpenId === 'string' && configuredBotOpenId.length > 0 ? configuredBotOpenId : null

    this.destroyed = false
    this.reconnectAttempt = 0
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    // Validate credentials up-front by exchanging for a token; then fetch
    // the gateway URL and open the socket. Failures throw → registry marks
    // the platform `error` with a user-readable message.
    await this.getAccessToken()
    const url = await this.getGatewayUrl()
    this.openSocket(url)
  }

  /** Runtime update of the allowed main-QQ openids without reconnecting. */
  setMainQqOpenIds(openIds: string[] | undefined): void {
    this.mainQqOpenIds = Array.isArray(openIds)
      ? openIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : []
    this.log.info('[qq] main QQ openids updated', {
      event: 'qq_main_qq_updated',
      count: this.mainQqOpenIds.length,
    })
  }

  async destroy(): Promise<void> {
    this.destroyed = true
    this.connected = false
    this.clearHeartbeat()
    this.clearReconnect()
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer)
      this.tokenRefreshTimer = null
    }
    if (this.ws) {
      try {
        this.ws.onclose = null
        this.ws.close()
      } catch {
        // already closed
      }
      this.ws = null
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler
  }

  onButtonPress(_handler: (press: ButtonPress) => Promise<void>): void {
    // QQ has no inline buttons — nothing to deliver.
  }

  // -------------------------------------------------------------------------
  // WebSocket gateway
  // -------------------------------------------------------------------------

  private openSocket(url: string): void {
    if (this.destroyed) return
    if (this.ws) {
      try {
        this.ws.onclose = null
        this.ws.close()
      } catch {
        // ignore
      }
    }

    this.log.info('[qq] opening gateway socket', {
      event: 'qq_socket_open',
      url: url.replace(/^wss:\/\//, 'wss://'),
    })

    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch (err) {
      this.log.error('[qq] failed to construct WebSocket', {
        event: 'qq_socket_construct_failed',
        error: err instanceof Error ? err.message : String(err),
      })
      this.handleDisconnect('construct-failed')
      return
    }
    this.ws = ws

    ws.onopen = () => {
      this.log.info('[qq] gateway socket open', { event: 'qq_socket_opened' })
      // HELLO (op 10) arrives automatically; it carries the heartbeat interval.
    }

    ws.onmessage = (event: MessageEvent) => {
      let payload: QQWsPayload
      try {
        payload = JSON.parse(wsEventText(event)) as QQWsPayload
      } catch {
        this.log.warn('[qq] dropped non-JSON frame', { event: 'qq_frame_parse_failed' })
        return
      }
      this.handleFrame(payload)
    }

    ws.onclose = (event: CloseEvent) => {
      this.log.warn('[qq] gateway socket closed', {
        event: 'qq_socket_closed',
        code: event.code,
        reason: event.reason,
      })
      this.handleDisconnect(`close-${event.code}`)
    }

    ws.onerror = (event: Event) => {
      this.log.error('[qq] gateway socket error', {
        event: 'qq_socket_error',
        message: event instanceof ErrorEvent ? event.message : 'unknown',
      })
    }
  }

  private handleFrame(payload: QQWsPayload): void {
    switch (payload.op) {
      case OP_HELLO: {
        const hello = payload.d as { heartbeat_interval?: number }
        this.startHeartbeat(hello?.heartbeat_interval ?? 41_250)
        // Identify: always full identify on a fresh socket; resume is
        // attempted by reconnect() when we have a session id.
        this.sendPayload({ op: OP_IDENTIFY, d: this.buildIdentifyData() })
        break
      }
      case OP_HEARTBEAT_ACK: {
        this.heartbeatAckPending = false
        break
      }
      case OP_RECONNECT: {
        this.log.info('[qq] server requested reconnect', { event: 'qq_server_reconnect' })
        this.handleDisconnect('server-reconnect')
        break
      }
      case OP_INVALID_SESSION: {
        this.log.warn('[qq] invalid session', { event: 'qq_invalid_session' })
        this.sessionId = null
        this.clearHeartbeat()
        // Re-identify on a fresh socket after a short delay.
        this.handleDisconnect('invalid-session')
        break
      }
      case OP_DISPATCH: {
        if (payload.s !== undefined) this.lastSeq = payload.s
        this.handleDispatch(payload.t, payload.d)
        break
      }
      default:
        // Unknown opcodes are ignored per spec.
        break
    }
  }

  private buildIdentifyData(): Record<string, unknown> {
    const token = this.accessToken ?? ''
    return {
      token: `QQBot ${token}`,
      intents: INTENT_GROUP_AND_C2C,
      shard: [0, 1],
    }
  }

  private sendPayload(payload: QQWsPayload): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify(payload))
    } catch (err) {
      this.log.error('[qq] failed to send frame', {
        event: 'qq_frame_send_failed',
        op: payload.op,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // -------------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------------

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat()
    this.heartbeatAckPending = false
    this.heartbeatTimer = setInterval(() => {
      // If the previous heartbeat was never acked, the connection is stale.
      if (this.heartbeatAckPending) {
        this.log.warn('[qq] heartbeat timeout, closing socket', {
          event: 'qq_heartbeat_timeout',
        })
        this.handleDisconnect('heartbeat-timeout')
        return
      }
      this.heartbeatAckPending = true
      this.sendPayload({ op: OP_HEARTBEAT, d: this.lastSeq })
    }, intervalMs)
    // Don't keep the process alive just for the heartbeat.
    this.heartbeatTimer.unref?.()
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this.heartbeatAckPending = false
  }

  // -------------------------------------------------------------------------
  // Dispatch handling
  // -------------------------------------------------------------------------

  private handleDispatch(type: string | undefined, data: unknown): void {
    switch (type) {
      case 'READY': {
        const ready = data as { session_id?: string }
        this.sessionId = ready?.session_id ?? null
        this.reconnectAttempt = 0
        if (!this.connected) {
          this.connected = true
          this.log.info('[qq] ready — connected', {
            event: 'qq_ready',
            sessionId: this.sessionId ? `${this.sessionId.slice(0, 8)}…` : null,
            mainQqCount: this.mainQqOpenIds.length,
          })
        }
        break
      }
      case 'RESUMED': {
        this.reconnectAttempt = 0
        this.connected = true
        this.log.info('[qq] session resumed', { event: 'qq_resumed' })
        break
      }
      case 'GROUP_AT_MESSAGE_CREATE': {
        void this.handleMessageEvent(data as QQMessageEvent, 'group', true)
        break
      }
      case 'GROUP_MESSAGE_CREATE': {
        // Full group-message stream (needs the "read all group messages"
        // platform scope). Filtered in handleMessageEvent to only forward
        // messages that @-mention the bot.
        void this.handleMessageEvent(data as QQMessageEvent, 'group', false)
        break
      }
      case 'C2C_MESSAGE_CREATE': {
        void this.handleMessageEvent(data as QQMessageEvent, 'c2c')
        break
      }
      default:
        // Log unknown events at debug level so operators can diagnose
        // scope/permission issues (e.g. QQ pushing an event type the
        // adapter doesn't subscribe to yet).
        if (type) {
          this.log.info('[qq] ignoring unhandled event', {
            event: 'qq_unhandled_event',
            type,
          })
        }
        break
    }
  }

  private async handleMessageEvent(data: QQMessageEvent, kind: 'group' | 'c2c', isAtEvent = false): Promise<void> {
    const handler = this.messageHandler
    if (!handler) return

    const rawContent = data.content ?? ''
    const senderId = kind === 'group' ? data.author?.member_openid ?? '' : data.author?.user_openid ?? ''
    // Group-chat mention state. `'at'` = must reply; `'none'` = plain group
    // message the router MAY decide to reply to (like a real person).
    let mentionKind: 'at' | 'none' = 'none'

    if (kind === 'c2c') {
      // C2C filter: when main QQ openids are configured, only those senders
      // may DM the bot. Others are dropped with a visibility log line so
      // the operator can confirm the filter is working.
      if (this.mainQqOpenIds.length > 0 && !this.mainQqOpenIds.includes(senderId)) {
        this.log.info('[qq] dropped C2C message from non-main sender', {
          event: 'qq_c2c_dropped',
          senderId,
          messageId: data.id,
        })
        return
      }
    } else {
      // Group messages: route ALL messages through the bot. Explicit
      // @-mentions (and real @-events) are marked `mentionKind: 'at'`
      // (must reply); plain group messages are marked `mentionKind: 'none'`
      // so the router's decision gate can decide whether to reply — the
      // bot should behave like a real group member, not echo everything.
      // Mobile QQ sometimes does not emit the standard <@!openid> markup
      // for bot @-mentions in GROUP_MESSAGE_CREATE payloads, so owner
      // messages that arrive as real @-events (GROUP_AT_MESSAGE_CREATE)
      // are still treated as 'at'. Non-@ owner messages go through the
      // decision gate just like everyone else's.
      const mentions = extractAllMentions(rawContent)
      const candidates = mentions.filter((m) => m !== senderId)
      const isOwnerSender = this.mainQqOpenIds.includes(senderId)

      if (isOwnerSender) {
        // Owner group messages: a real @-event (GROUP_AT_MESSAGE_CREATE)
        // guarantees a bot @-mention → must reply. Also check for explicit
        // <@openid> markup in the content — Mobile QQ sometimes sends
        // @-mentions as plain markup in GROUP_MESSAGE_CREATE.
        const mentionsBot = this.botOpenId ? mentions.includes(this.botOpenId) : false
        if (isAtEvent || mentionsBot) {
          mentionKind = 'at'
          if (!this.botOpenId && candidates.length > 0) {
            this.botOpenId = candidates[0] ?? null
          }
        } else if (!this.botOpenId && candidates.length === 1) {
          // Single non-self mention on an owner message is likely the bot.
          this.botOpenId = candidates[0] ?? null
          mentionKind = 'at'
          this.log.info('[qq] learned bot openid from owner group message', {
            event: 'qq_bot_openid_learned',
            source: 'owner-group',
            botOpenId: this.botOpenId,
            groupOpenId: data.group_openid,
            messageId: data.id,
          })
        } else {
          mentionKind = 'none'
        }
        this.log.info('[qq] forwarding owner group message', {
          event: 'qq_owner_group_forward',
          groupOpenId: data.group_openid,
          senderId,
          messageId: data.id,
          mentionKind,
        })
      } else if (isAtEvent) {
        // GROUP_AT_MESSAGE_CREATE — guaranteed @-mention, must reply.
        mentionKind = 'at'
        if (!this.botOpenId && candidates.length > 0) {
          this.botOpenId = candidates[0] ?? null
          this.log.info('[qq] learned bot openid from GROUP_AT_MESSAGE_CREATE', {
            event: 'qq_bot_openid_learned',
            source: 'at-event',
            botOpenId: this.botOpenId,
          })
        }
      } else if (this.botOpenId) {
        // GROUP_MESSAGE_CREATE — explicit @-mention match drives the bot;
        // otherwise it's a plain group message for the decision gate.
        if (mentions.includes(this.botOpenId)) {
          mentionKind = 'at'
        } else {
          mentionKind = 'none'
          this.log.info('[qq] routing plain group message (decision gate)', {
            event: 'qq_group_plain',
            groupOpenId: data.group_openid,
            senderId,
            messageId: data.id,
            textPreview: stripMentions(rawContent).slice(0, 60),
          })
        }
      } else if (candidates.length === 1) {
        // Bot openid unknown — a single non-self @-mention is very
        // likely the bot (regular members don't @ themselves). Learn it
        // and forward this message.
        mentionKind = 'at'
        this.botOpenId = candidates[0] ?? null
        this.log.info('[qq] learned bot openid from GROUP_MESSAGE_CREATE mention', {
          event: 'qq_bot_openid_learned',
          source: 'group-message',
          botOpenId: this.botOpenId,
          groupOpenId: data.group_openid,
          messageId: data.id,
        })
      } else {
        // No bot openid known yet and no unambiguous mention — still route
        // the message as 'none' so the decision gate can observe the chat.
        mentionKind = 'none'
        this.log.info('[qq] routing plain group message (bot openid unknown)', {
          event: 'qq_group_plain',
          groupOpenId: data.group_openid,
          senderId,
          messageId: data.id,
          mentionCount: mentions.length,
        })
      }
    }

    const text = stripMentions(rawContent)
    const messageId = data.id ?? ''
    const channelId = kind === 'group' ? `group:${data.group_openid ?? ''}` : `user:${data.author?.user_openid ?? ''}`
    const timestamp = data.timestamp ? Date.parse(data.timestamp) : Date.now()

    if (!channelId || !senderId) {
      this.log.warn('[qq] message event missing ids, dropping', {
        event: 'qq_msg_missing_ids',
        kind,
        channelId,
        senderId,
        messageId,
      })
      return
    }

    this.log.info('[qq] routing message', {
      event: 'qq_message_routed',
      kind,
      channelId,
      senderId,
      messageId,
      hasText: text.length > 0,
      textPreview: text.slice(0, 80),
      attachmentCount: data.attachments?.length ?? 0,
    })

    // Download rich-media attachments (images/files/video/audio) so the
    // session receives a FileAttachment instead of an empty-text message.
    const attachments: IncomingAttachment[] = []
    if (data.attachments?.length) {
      for (let i = 0; i < data.attachments.length; i++) {
        const att = data.attachments[i]
        if (!att?.url) continue
        try {
          const localPath = await this.downloadAttachmentFromUrl(att.url, att.filename)
          const type = qqInboundAttachmentType(att.content_type, att.filename)
          attachments.push({
            type,
            fileId: att.url,
            fileName: att.filename,
            mimeType: att.content_type,
            fileSize: att.size,
            localPath,
          })
          this.log.info('[qq] attachment downloaded', {
            event: 'qq_attachment_downloaded',
            index: i,
            fileName: att.filename,
            type,
            localPath,
          })
        } catch (err) {
          this.log.warn('[qq] attachment download failed', {
            event: 'qq_attachment_download_failed',
            index: i,
            fileName: att.filename,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    const msg: IncomingMessage = {
      platform: 'qq',
      channelId,
      messageId,
      senderId,
      text,
      timestamp,
      raw: data,
      ...(kind === 'group' ? { chatKind: 'group' as const, mentionKind } : { chatKind: 'private' as const }),
      ...(attachments.length > 0 ? { attachments } : {}),
    }
    await handler(msg)
  }

  // -------------------------------------------------------------------------
  // Reconnect
  // -------------------------------------------------------------------------

  /** Clean up the current socket and schedule a reconnect with backoff. */
  private handleDisconnect(reason: string): void {
    const wasConnected = this.connected
    this.connected = false
    this.clearHeartbeat()

    if (this.ws) {
      try {
        this.ws.onclose = null
        this.ws.onmessage = null
        this.ws.onerror = null
        this.ws.close()
      } catch {
        // ignore
      }
      this.ws = null
    }

    if (this.destroyed) return
    this.scheduleReconnect(reason, wasConnected)
  }

  private scheduleReconnect(reason: string, wasConnected: boolean): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    const attempt = this.reconnectAttempt
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]
    this.reconnectAttempt += 1
    // Reset the counter after a successful long-lived connection.
    if (wasConnected && attempt === 0) this.reconnectAttempt = 0

    this.log.warn('[qq] scheduling reconnect', {
      event: 'qq_reconnect_scheduled',
      reason,
      attempt: this.reconnectAttempt,
      delayMs: delay,
    })

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.destroyed) return
      void this.doReconnect(reason)
    }, delay)
  }

  private async doReconnect(reason: string): Promise<void> {
    try {
      const url = await this.getGatewayUrl(true) // force-refresh: server may have rotated
      this.openSocket(url)
    } catch (err) {
      this.log.error('[qq] reconnect failed, retrying', {
        event: 'qq_reconnect_failed',
        reason,
        error: err instanceof Error ? err.message : String(err),
      })
      this.scheduleReconnect(reason, false)
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  // -------------------------------------------------------------------------
  // Outbound — sends
  // -------------------------------------------------------------------------

  /** `POST /v2/groups/{id}/messages` or `POST /v2/users/{id}/messages`. */
  private async postMessage(
    kind: 'group' | 'user',
    id: string,
    body: Record<string, unknown>,
  ): Promise<{ id?: string; message_audit?: { audit_id?: string } }> {
    const token = await this.getAccessToken()
    const url = kind === 'group'
      ? `${QQ_API_BASE}/v2/groups/${id}/messages`
      : `${QQ_API_BASE}/v2/users/${id}/messages`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `QQBot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      throw new Error(
        `QQ send failed: HTTP ${res.status} ${typeof data.message === 'string' ? data.message : JSON.stringify(data)}`,
      )
    }
    return data as { id?: string; message_audit?: { audit_id?: string } }
  }

  async sendText(channelId: string, text: string, _opts?: SendOptions): Promise<SentMessage> {
    const { kind, id } = parseChannel(channelId)
    const result = await this.postMessage(kind, id, { content: text, msg_type: 0 })
    // Message may be under audit; either way we have a correlation id.
    return { platform: 'qq', channelId, messageId: result.id ?? result.message_audit?.audit_id ?? '' }
  }

  async editMessage(_channelId: string, _messageId: string, _text: string, _opts?: SendOptions): Promise<void> {
    // QQ Open Platform has no message-edit API.
    throw new Error('QQ does not support message editing')
  }

  async sendButtons(
    _channelId: string,
    _text: string,
    _buttons: InlineButton[],
    _opts?: SendOptions,
  ): Promise<SentMessage> {
    throw new Error('QQ does not support inline buttons')
  }

  async sendTyping(_channelId: string, _opts?: SendOptions): Promise<void> {
    // QQ has no typing-indicator API. No-op.
  }

  async sendFile(
    channelId: string,
    file: Buffer,
    filename: string,
    caption?: string,
    _opts?: SendOptions,
  ): Promise<SentMessage> {
    const { kind, id } = parseChannel(channelId)
    if (file.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(`file exceeds ${MAX_ATTACHMENT_BYTES} bytes`)
    }

    // 1) Upload the rich media via chunked upload (preferred API as of 2026-07-22).
    const token = await this.getAccessToken()
    const fileType = qqFileType(filename)
    const baseUrl = `${QQ_API_BASE}/v2/${kind === 'group' ? 'groups' : 'users'}/${id}`

    // 1a) Compute checksums.
    const md5 = createHash('md5').update(file).digest('hex')
    const sha1 = createHash('sha1').update(file).digest('hex')
    const headSize = 10_002_432
    const head = file.subarray(0, headSize)
    const md5_10m = createHash('md5').update(head).digest('hex')

    // 1b) Upload prepare.
    const prepareRes = await fetch(`${baseUrl}/upload_prepare`, {
      method: 'POST',
      headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_type: fileType,
        file_size: String(file.byteLength),
        file_name: filename,
        md5,
        sha1,
        md5_10m,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    const prepareData = (await prepareRes.json().catch(() => ({}))) as {
      upload_id?: string
      block_size?: string
      parts?: Array<{ index: number; presigned_url: string; block_size?: string }>
    }
    if (!prepareRes.ok || !prepareData.upload_id || !prepareData.parts?.length) {
      throw new Error(
        `QQ upload prepare failed: HTTP ${prepareRes.status} ${JSON.stringify(prepareData).slice(0, 200)}`,
      )
    }

    // 1c) Upload each chunk via presigned URL + mark as finished.
    // NOTE: QQ's part index is 1-based; locate chunks sequentially by offset
    // rather than deriving position from `part.index * block_size`.
    let offset = 0
    for (const part of prepareData.parts) {
      const blockSize = Number(part.block_size ?? prepareData.block_size ?? 5_242_880)
      const chunk = file.subarray(offset, offset + blockSize)
      offset += blockSize

      // PUT chunk to presigned URL (retry up to 3 times).
      let putRes: Response | null = null
      for (let attempt = 1; attempt <= 3; attempt++) {
        putRes = await fetch(part.presigned_url, {
          method: 'PUT',
          body: chunk,
          signal: AbortSignal.timeout(30_000),
        })
        if (putRes.ok) break
        await new Promise((r) => setTimeout(r, 1000))
      }
      if (!putRes?.ok) {
        throw new Error(`QQ chunk PUT failed (part ${part.index}): HTTP ${putRes?.status}`)
      }

      // Notify part finished.
      const partMd5 = createHash('md5').update(chunk).digest('hex')
      const finishRes = await fetch(`${baseUrl}/upload_part_finish`, {
        method: 'POST',
        headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          upload_id: prepareData.upload_id,
          part_index: part.index,
          block_size: String(blockSize),
          md5: partMd5,
        }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!finishRes.ok) {
        throw new Error(`QQ part finish failed (part ${part.index}): HTTP ${finishRes.status}`)
      }
    }

    // 1d) Merge chunks → get file_info.
    const mergeRes = await fetch(`${baseUrl}/files`, {
      method: 'POST',
      headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_type: fileType,
        srv_send_msg: false,
        file_name: filename,
        upload_id: prepareData.upload_id,
      }),
      signal: AbortSignal.timeout(30_000),
    })
    const mergeData = (await mergeRes.json().catch(() => ({}))) as {
      file_info?: string
      message?: string
      code?: number
    }
    if (!mergeRes.ok || !mergeData.file_info) {
      throw new Error(
        `QQ file merge failed: HTTP ${mergeRes.status} ${mergeData.message ?? `code ${mergeData.code ?? 'unknown'}`}`,
      )
    }

    // 2) Send a media message (msg_type 7) referencing the uploaded file.
    const sent = await this.postMessage(kind, id, {
      msg_type: 7,
      content: '',
      media: { file_info: mergeData.file_info },
    })

    // 3) QQ can't combine caption + file; send the caption as a follow-up.
    if (caption) {
      this.sendText(channelId, caption).catch((err) => {
        this.log.warn('[qq] caption follow-up failed', {
          event: 'qq_caption_failed',
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }

    return {
      platform: 'qq',
      channelId,
      messageId: sent.id ?? sent.message_audit?.audit_id ?? '',
    }
  }

  // -------------------------------------------------------------------------
  // Optional interface methods — unsupported on QQ, throw for clear errors.
  // -------------------------------------------------------------------------

  async deleteMessage(channelId: string, messageId: string, _opts?: SendOptions): Promise<void> {
    // QQ v2 supports message recall (DELETE /v2/groups/{id}/messages/{msg_id}).
    const { kind, id } = parseChannel(channelId)
    const token = await this.getAccessToken()
    const url = kind === 'group'
      ? `${QQ_API_BASE}/v2/groups/${id}/messages/${messageId}`
      : `${QQ_API_BASE}/v2/users/${id}/messages/${messageId}`
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `QQBot ${token}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      this.log.warn('[qq] message recall failed (non-fatal)', {
        event: 'qq_recall_failed',
        channelId,
        messageId,
        status: res.status,
      })
    }
  }

  async clearButtons(_channelId: string, _messageId: string, _opts?: SendOptions): Promise<void> {
    // No inline buttons on QQ → nothing to clear.
  }

  /** Download an attachment referenced by a message to a temp file. */
  private async downloadAttachment(channelId: string, fileInfo: string, filename: string): Promise<string> {
    const { kind, id } = parseChannel(channelId)
    const token = await this.getAccessToken()
    const url = kind === 'group'
      ? `${QQ_API_BASE}/v2/groups/${id}/files/${fileInfo}`
      : `${QQ_API_BASE}/v2/users/${id}/files/${fileInfo}`
    const res = await fetch(url, { headers: { Authorization: `QQBot ${token}` } })
    if (!res.ok) {
      throw new Error(`QQ file download failed: HTTP ${res.status}`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(`file too large after download: ${buf.byteLength} bytes`)
    }
    const ext = join('x', filename).split('.').pop() || 'bin'
    const localPath = join(tmpdir(), `qq-${randomBytes(8).toString('hex')}.${ext}`)
    writeFileSync(localPath, buf)
    return localPath
  }

  /**
   * Download an inbound attachment from QQ's CDN URL (carried in the
   * message event's `attachments[].url`) to a temp file. Enforces
   * `MAX_ATTACHMENT_BYTES` against the actual downloaded size.
   */
  private async downloadAttachmentFromUrl(
    url: string,
    filename: string | undefined,
  ): Promise<string> {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) {
      throw new Error(`QQ attachment fetch failed: HTTP ${res.status}`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(`attachment too large after download: ${buf.byteLength} bytes`)
    }
    const ext = filename ? (join('x', filename).split('.').pop() || 'bin') : 'bin'
    const localPath = join(tmpdir(), `qq-in-${randomBytes(8).toString('hex')}.${ext}`)
    writeFileSync(localPath, buf)
    return localPath
  }
}
