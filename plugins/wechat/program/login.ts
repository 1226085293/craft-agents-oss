/**
 * WeChat (ClawBot / iLink) QR sign-in.
 *
 * This is the platform half of the flow: talk to iLink, keep the attempt alive,
 * and report where it stands. It owns no UI and writes no files — the state it
 * returns is handed to Craft, which renders it and saves the credential into
 * this plugin's own config.
 *
 * Adapted from `scripts/wechat-login.ts`, with three changes that matter:
 *
 *   1. no `readline` — the short code the person reads off their phone arrives
 *      through `submit()`, because the UI is in another process;
 *   2. no terminal QR — the raw string goes to the caller, which encodes it;
 *   3. the 35 s long poll runs in a background loop, not inside a request, so
 *      `start()` returns as soon as there is something to show and a slow
 *      platform never stalls an RPC.
 *
 * Protocol (from the reference implementation):
 *   POST {base}/ilink/bot/get_bot_qrcode?bot_type=3   -> { qrcode, qrcode_img_content }
 *   GET  {base}/ilink/bot/get_qrcode_status?qrcode=…  -> { status, bot_token, … }
 *
 * Status values and what they mean here:
 *   wait                -> awaiting (keep polling)
 *   scaned              -> scanned (person scanned, phone confirmation pending)
 *   need_verifycode     -> need_code (platform wants the digits shown on the phone)
 *   expired             -> expired  (start again for a fresh code)
 *   scaned_but_redirect -> scanned, and subsequent polls go to the new host
 *   binded_redirect     -> failed   (this account already has live credentials)
 *   confirmed           -> connected, with `credentials.token` filled in
 */

import { randomBytes } from 'node:crypto'

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
const BOT_TYPE = '3'
const LONG_POLL_TIMEOUT_MS = 35_000
const POLL_INTERVAL_MS = 1_000
/** One attempt lives this long before it is reported expired. */
export const ATTEMPT_TTL_MS = 480_000
const MAX_QR_REFRESH = 3

export type WeChatAuthPhase =
  | 'idle'
  | 'awaiting'
  | 'scanned'
  | 'need_code'
  | 'connected'
  | 'expired'
  | 'failed'

export interface WeChatAuthState {
  phase: WeChatAuthPhase
  qr?: string
  expiresAt?: number
  detail?: string
  error?: string
  attempt?: number
  credentials?: Record<string, unknown>
}

interface QrCode {
  qrcode: string
  qrcode_img_content: string
}

interface QrStatus {
  status: string
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
  redirect_host?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The `X-WECHAT-UIN` header the platform expects: base64 of a random uint32. */
function randomUin(): string {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf-8').toString('base64')
}

function baseHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': '131590',
    'X-WECHAT-UIN': randomUin(),
  }
}

export class WeChatQrLogin {
  private snapshot: WeChatAuthState = { phase: 'idle' }

  /** Bumped on every start/cancel: a loop from an older attempt stops silently. */
  private generation = 0

  private attempt = 0

  private baseUrl = DEFAULT_BASE_URL

  private qrCode = ''

  private pendingVerifyCode: string | undefined

  private deadline = 0

  private refreshCount = 0

  constructor(
    private readonly baseUrlOverride?: string,
    private readonly log: (event: string, extra?: Record<string, unknown>) => void = () => {},
  ) {
    if (baseUrlOverride) this.baseUrl = baseUrlOverride
  }

  state(): WeChatAuthState {
    // An attempt that outlived its window reads as expired on read, so a UI
    // that polls after the loop died still gets a truthful answer.
    if (this.snapshot.phase === 'awaiting' || this.snapshot.phase === 'scanned' || this.snapshot.phase === 'need_code') {
      if (this.deadline > 0 && Date.now() > this.deadline) {
        this.snapshot = { phase: 'expired', attempt: this.attempt, error: '二维码已过期，请重新发起授权' }
      }
    }
    return this.snapshot
  }

  async start(): Promise<WeChatAuthState> {
    this.cancelInternal()
    const generation = ++this.generation
    this.attempt += 1
    this.deadline = Date.now() + ATTEMPT_TTL_MS
    this.refreshCount = 0
    this.pendingVerifyCode = undefined
    this.baseUrl = this.baseUrlOverride ?? DEFAULT_BASE_URL

    try {
      await this.refreshQr(generation)
    } catch (error) {
      this.snapshot = {
        phase: 'failed',
        attempt: this.attempt,
        error: error instanceof Error ? error.message : String(error),
      }
      return this.snapshot
    }

    void this.pollLoop(generation)
    return this.state()
  }

  async submit(code: string): Promise<WeChatAuthState> {
    const trimmed = code.trim()
    if (!trimmed) return this.state()
    if (this.snapshot.phase !== 'need_code') {
      // Nothing is waiting for a code. Say so instead of swallowing it: a stale
      // dialog would otherwise look like it accepted the digits.
      return {
        ...this.state(),
        error: '当前没有等待验证码的授权请求',
      }
    }
    this.pendingVerifyCode = trimmed
    // The loop picks it up on its next tick; report a neutral "still working"
    // so the UI keeps the input closed rather than flashing an error.
    return { ...this.state(), detail: '正在校验验证码…' }
  }

  async cancel(): Promise<WeChatAuthState> {
    this.cancelInternal()
    return this.state()
  }

  private cancelInternal(): void {
    this.generation += 1
    this.deadline = 0
    this.pendingVerifyCode = undefined
    this.snapshot = { phase: 'idle', attempt: this.attempt }
  }

  private async refreshQr(generation: number): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`,
      {
        method: 'POST',
        headers: baseHeaders(),
        body: JSON.stringify({ local_token_list: [] }),
        signal: AbortSignal.timeout(20_000),
      },
    )
    if (!response.ok) {
      throw new Error(`get_bot_qrcode HTTP ${response.status}`)
    }
    const qr = (await response.json()) as QrCode
    if (!qr?.qrcode) throw new Error('get_bot_qrcode returned no qrcode')
    if (generation !== this.generation) return

    this.qrCode = qr.qrcode
    // `qrcode_img_content` is what the phone scans; the reference CLI renders
    // this one, and it is the value the platform accepts at get_qrcode_status.
    this.snapshot = {
      phase: 'awaiting',
      qr: qr.qrcode_img_content || qr.qrcode,
      expiresAt: this.deadline,
      attempt: this.attempt,
      detail: '请用手机微信扫描二维码',
    }
    this.log('wechat_qr_ready', { attempt: this.attempt })
  }

  private async fetchStatus(): Promise<QrStatus | null> {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(this.qrCode)}`
    if (this.pendingVerifyCode) {
      endpoint += `&verify_code=${encodeURIComponent(this.pendingVerifyCode)}`
    }
    try {
      const response = await fetch(`${this.baseUrl}/${endpoint}`, {
        method: 'GET',
        headers: {
          'iLink-App-Id': 'bot',
          'iLink-App-ClientVersion': '131590',
          'X-WECHAT-UIN': randomUin(),
        },
        signal: AbortSignal.timeout(LONG_POLL_TIMEOUT_MS),
      })
      if (!response.ok) return null
      return (await response.json()) as QrStatus
    } catch (error) {
      // A timeout is the platform's normal "nothing happened yet".
      const name = error instanceof Error ? error.name : ''
      if (name === 'TimeoutError' || name === 'AbortError') return { status: 'wait' }
      return null
    }
  }

  private async pollLoop(generation: number): Promise<void> {
    while (generation === this.generation && Date.now() < this.deadline) {
      const status = await this.fetchStatus()
      if (generation !== this.generation) return
      if (!status) {
        // One unreadable poll is not a verdict; keep trying until the window ends.
        await sleep(POLL_INTERVAL_MS)
        continue
      }

      switch (status.status) {
        case 'wait':
          break

        case 'scaned': {
          const hadCode = Boolean(this.pendingVerifyCode)
          this.pendingVerifyCode = undefined
          this.snapshot = {
            phase: 'scanned',
            attempt: this.attempt,
            expiresAt: this.deadline,
            detail: hadCode ? '验证码通过，等待手机确认' : '已扫码，请在手机上确认',
          }
          break
        }

        case 'need_verifycode':
          this.snapshot = {
            phase: 'need_code',
            attempt: this.attempt,
            expiresAt: this.deadline,
            detail: this.pendingVerifyCode
              ? '验证码不匹配，请重新输入微信显示的数字'
              : '请在手机上确认，然后输入微信显示的数字',
          }
          break

        case 'expired': {
          this.refreshCount += 1
          if (this.refreshCount > MAX_QR_REFRESH) {
            this.snapshot = {
              phase: 'expired',
              attempt: this.attempt,
              error: '二维码多次过期，请重新发起授权',
            }
            this.generation += 1
            return
          }
          try {
            await this.refreshQr(generation)
          } catch (error) {
            this.snapshot = {
              phase: 'failed',
              attempt: this.attempt,
              error: error instanceof Error ? error.message : String(error),
            }
            this.generation += 1
            return
          }
          break
        }

        case 'scaned_but_redirect':
          if (status.redirect_host) {
            this.baseUrl = `https://${status.redirect_host}`
          }
          this.snapshot = {
            phase: 'scanned',
            attempt: this.attempt,
            expiresAt: this.deadline,
            detail: '已扫码，正在切换登录节点',
          }
          break

        case 'binded_redirect':
          this.snapshot = {
            phase: 'failed',
            attempt: this.attempt,
            error: '这个微信号已经绑定过机器人；如需更换，请先在插件配置里清除旧凭据',
          }
          this.generation += 1
          return

        case 'confirmed': {
          const botToken = status.bot_token
          const botId = status.ilink_bot_id
          if (!botToken || !botId) {
            this.snapshot = {
              phase: 'failed',
              attempt: this.attempt,
              error: '登录确认失败：平台没有返回 bot_token 或 ilink_bot_id',
            }
            this.generation += 1
            return
          }
          const credentials = {
            botToken,
            baseUrl: status.baseurl || this.baseUrl,
            botId,
            ...(status.ilink_user_id ? { userId: status.ilink_user_id } : {}),
          }
          this.snapshot = {
            phase: 'connected',
            attempt: this.attempt,
            detail: '登录成功',
            // Exactly the shape this plugin's own `parseCredentials` expects:
            // a JSON string under `token`, in its own config.
            credentials: { token: JSON.stringify(credentials) },
          }
          this.log('wechat_qr_confirmed', { attempt: this.attempt, botId })
          this.generation += 1
          return
        }

        default:
          break
      }

      await sleep(POLL_INTERVAL_MS)
    }

    if (generation !== this.generation) return
    if (this.snapshot.phase === 'awaiting' || this.snapshot.phase === 'scanned' || this.snapshot.phase === 'need_code') {
      this.snapshot = {
        phase: 'expired',
        attempt: this.attempt,
        error: '授权超时，请重新发起',
      }
    }
  }
}
