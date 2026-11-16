/**
 * WhatsAppAdapter — out-of-process adapter that spawns the
 * `@craft-agent/messaging-whatsapp-worker` subprocess.
 *
 * WhatsApp has no official bot API usable by us. Baileys reimplements the
 * WA multi-device protocol — it runs in a child process so that:
 *   (a) a Baileys crash/segfault can't take down the Electron main process,
 *   (b) Baileys can run under Node even when the host runtime is Bun,
 *   (c) memory isolation: auth state, signal ratchets, etc.
 *
 * The worker contract lives in ./protocol.ts — a vendored copy of the
 * worker's IPC protocol, because an installed plugin copy runs in the user's
 * workspace where no @craft-agent package is resolvable.
 * This adapter owns the process lifecycle + translates events to the
 * PlatformAdapter interface.
 *
 * Unofficial API disclaimer: Baileys is not endorsed by WhatsApp/Meta and
 * may stop working at any time. Account bans are possible.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  encodeMessage,
  parseFrames,
  type WorkerCommand,
  type WorkerEvent,
} from './protocol.ts'
import type {
  PlatformAdapter,
  PlatformConfig,
  AdapterCapabilities,
  IncomingMessage,
  IncomingAttachment,
  SendOptions,
  SentMessage,
  InlineButton,
  ButtonPress,
  ReadReceipt,
  MessagingLogger,
} from '@craft-agent/messaging-gateway/types'

const NOOP_LOGGER: MessagingLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
}

/**
 * Hard ceiling for `sendText`/`sendFile` awaits. If the worker wedges
 * between command dispatch and `send_result` (Baileys deadlock, infinite
 * retry, stalled socket) we surface a real error to the caller instead
 * of letting the renderer's `text_complete` path hang indefinitely and
 * freeze the chat. Chosen to comfortably exceed the worst-case Baileys
 * round-trip on a slow network; shorter would starve legitimate sends.
 * Tests pass a much smaller value via `WhatsAppConfig.sendTimeoutMs`.
 */
const DEFAULT_SEND_TIMEOUT_MS = 30_000

/**
 * Kill worker processes left behind by a previous plugin process.
 *
 * The host stops a plugin with a hard kill, so `destroy()` — the only place
 * that would have waited for the worker to exit — never runs. The orphan keeps
 * the Baileys session alive and reconnects, so a fresh worker takes tens of
 * seconds to produce a QR, or never does. Matching on the worker's own entry
 * path is precise: only this plugin spawns that file.
 *
 * Best effort and synchronous-by-timeout: pairing must not be delayed by a
 * hostile process table, so failures are logged and ignored.
 */
function reapStaleWorkers(workerEntry: string, log: MessagingLogger): void {
  if (process.platform !== 'win32') return
  try {
    // Escaping the path for a single-quoted PowerShell literal: only `'` matters.
    const target = workerEntry.replace(/'/g, "''")
    // Only ever kill a process that is the worker binary itself: a shell whose
    // command line merely mentions the path (a log grep, an editor) must not
    // match.
    const script = [
      `$me = ${process.pid}`,
      `$needle = '${target}'`,
      `$runtimes = @('node.exe', 'bun.exe', 'electron.exe')`,
      `Get-CimInstance Win32_Process |`,
      `  Where-Object { $runtimes -contains $_.Name -and $_.ProcessId -ne $me -and $_.ParentProcessId -ne $me -and $_.CommandLine -and $_.CommandLine.Contains($needle) } |`,
      `  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }`,
    ].join('\n')
    const result = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    let killed = ''
    result.stdout?.setEncoding('utf8')
    result.stdout?.on('data', (chunk: string) => {
      killed += chunk
    })
    result.on('error', () => undefined)
    result.on('exit', () => {
      const ids = killed.split(/\s+/).filter(Boolean)
      if (ids.length > 0) {
        log.warn('reaped stale WhatsApp workers', { event: 'whatsapp_stale_workers_reaped', pids: ids })
      }
    })
  } catch {
    // A failed sweep is not a reason to refuse to start.
  }
}

function inferMimeType(filename: string): string | undefined {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html'
  if (lower.endsWith('.json')) return 'application/json'
  if (lower.endsWith('.csv')) return 'text/csv'
  if (lower.endsWith('.txt') || lower.endsWith('.md')) return 'text/plain'
  return undefined
}

type PendingEntry = {
  resolve: (r: { ok: boolean; messageId?: string; error?: string }) => void
  timer: ReturnType<typeof setTimeout>
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface WhatsAppConfig extends PlatformConfig {
  /** Directory Baileys persists multi-file auth state into. Required. */
  authStateDir: string
  /** Absolute path to the worker entry script. Required. */
  workerEntry: string
  /** Node binary path. Defaults to 'node'. */
  nodeBin?: string
  /** Pairing flow: 'qr' (default) or 'code' (phone-number based 8-char code). */
  pairingMode?: 'qr' | 'code'
  /**
   * Accept messages sent from this account's other devices (phone/WA
   * Desktop/WA Web) in the self-chat. Agent echoes are filtered by
   * sent-ID tracking + the response prefix. See `WorkerCommand.StartCommand`
   * for mechanics.
   */
  selfChatMode?: boolean
  /** Prefix tagged onto outbound self-chat messages. Defaults to 🤖. */
  responsePrefix?: string
  /**
   * Override the default per-send timeout (30s). Used by tests; not
   * exposed through the registry or UI. Shorter values help surface
   * worker deadlocks faster but risk rejecting legitimate sends on
   * slow networks.
   */
  sendTimeoutMs?: number
}

// ---------------------------------------------------------------------------
// Event bus (adapter-level, surfaced via registry)
// ---------------------------------------------------------------------------

export type WhatsAppEvent =
  | { type: 'qr'; qr: string }
  | { type: 'pairing_code'; code: string }
  | { type: 'connected'; jid?: string; name?: string }
  | { type: 'disconnected'; loggedOut: boolean; reason?: string }
  | { type: 'unavailable'; reason: string; message: string }
  | { type: 'error'; message: string }

type EventHandler = (event: WhatsAppEvent) => void

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class WhatsAppAdapter implements PlatformAdapter {
  readonly platform = 'whatsapp' as const
  readonly capabilities: AdapterCapabilities = {
    messageEditing: false,
    inlineButtons: false,
    maxButtons: 0,
    maxMessageLength: 4096,
    markdown: 'whatsapp',
    webhookSupport: false,
    // Baileys reports read receipts for messages we send, so we can clear the
    // desktop unread badge on a real "the user read it" signal.
    readReceipts: true,
  }

  private proc: ChildProcess | null = null
  private stdoutBuffer = ''
  private connected = false
  private started = false
  private log: MessagingLogger = NOOP_LOGGER
  private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null
  private buttonHandler: ((press: ButtonPress) => Promise<void>) | null = null
  private readReceiptHandler: ((receipt: ReadReceipt) => void) | null = null
  private eventHandlers = new Set<EventHandler>()
  private pending = new Map<string, PendingEntry>()
  private nextCmdId = 1
  private sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS

  async initialize(config: PlatformConfig): Promise<void> {
    const cfg = config as WhatsAppConfig
    if (!cfg.workerEntry) throw new Error('WhatsApp: workerEntry path is required')
    if (!cfg.authStateDir) throw new Error('WhatsApp: authStateDir is required')

    if (this.proc) {
      throw new Error('WhatsApp adapter already initialized')
    }

    this.log = (cfg.logger ?? NOOP_LOGGER).child({
      component: 'whatsapp-adapter',
      platform: 'whatsapp',
    })

    if (cfg.sendTimeoutMs !== undefined && cfg.sendTimeoutMs > 0) {
      this.sendTimeoutMs = cfg.sendTimeoutMs
    }

    const nodeBin = cfg.nodeBin ?? process.execPath
    this.log.info('starting WhatsApp worker', {
      event: 'whatsapp_worker_starting',
      workerEntry: cfg.workerEntry,
      authStateDir: cfg.authStateDir,
      pairingMode: cfg.pairingMode ?? 'qr',
      nodeBin,
    })

    // Reap workers left behind by a previous plugin process. The host stops a
    // listener with a hard kill on Windows, so the SIGTERM path that would
    // have called destroy() never runs and the child survives, holding the same
    // WhatsApp session: the next worker then waits tens of seconds for a QR
    // while the stale one keeps reconnecting. Sweeping by the worker's own
    // entry path is safe — only this plugin spawns that file.
    reapStaleWorkers(cfg.workerEntry, this.log)

    this.proc = spawn(nodeBin, [cfg.workerEntry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })

    this.proc.stdout?.setEncoding('utf8')
    this.proc.stdout?.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk
      const { messages, rest } = parseFrames<WorkerEvent>(this.stdoutBuffer)
      this.stdoutBuffer = rest
      for (const ev of messages) this.onWorkerEvent(ev)
    })

    this.proc.stderr?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString('utf8').split('\n').filter(Boolean)
      for (const line of lines) {
        this.log.warn('WhatsApp worker stderr', {
          event: 'whatsapp_worker_stderr',
          line,
        })
      }
    })

    this.proc.on('exit', (code, signal) => {
      this.connected = false
      this.started = false
      this.proc = null
      this.drainPending(
        `worker exited with code ${code ?? 'null'}${signal ? ` (signal ${signal})` : ''}`,
      )
      this.log.warn('WhatsApp worker exited', {
        event: 'whatsapp_worker_exited',
        code,
        signal,
      })
      if (code !== 0) {
        this.fireEvent({
          type: 'error',
          message: `Worker exited with code ${code ?? 'null'}`,
        })
      }
    })

    const startCmd: WorkerCommand = {
      type: 'start',
      authStateDir: cfg.authStateDir,
      pairingMode: cfg.pairingMode ?? 'qr',
      selfChatMode: cfg.selfChatMode ?? false,
      responsePrefix: cfg.responsePrefix,
    }
    this.sendCommand(startCmd)
    this.started = true
  }

  async destroy(): Promise<void> {
    if (!this.proc) return
    this.log.info('shutting down WhatsApp worker', { event: 'whatsapp_worker_shutdown' })
    try {
      this.sendCommand({ type: 'shutdown' })
    } catch (err) {
      this.log.warn('failed to send shutdown to WhatsApp worker', {
        event: 'whatsapp_worker_shutdown_signal_failed',
        error: err,
      })
    }
    const proc = this.proc
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {
          // ignore
        }
        resolve()
      }, 2000)
      proc.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    // Defensive: `proc.on('exit')` normally drains first, but if the exit
    // event is delayed or was set up after a race, the promise above can
    // resolve via the SIGKILL timer before `exit` fires. Drain again here
    // so no caller is left hanging.
    this.drainPending('adapter destroyed')
    this.proc = null
    this.started = false
    this.connected = false
  }

  /** Whether the worker process is currently running (before it connects). */
  get running(): boolean {
    return this.proc !== null
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

  onReadReceipt(handler: (receipt: ReadReceipt) => void): void {
    this.readReceiptHandler = handler
  }

  /** Subscribe to adapter-level events (QR, pairing code, unavailable, errors). */
  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  /** Submit a phone number to obtain an 8-char pairing code (pairingMode=code). */
  async requestPairingCode(phoneNumber: string): Promise<void> {
    if (!this.started) throw new Error('WhatsApp adapter not started')
    this.log.info('requesting WhatsApp pairing code', {
      event: 'whatsapp_pairing_code_requested',
    })
    this.sendCommand({ type: 'submit_pairing_phone', phoneNumber })
  }

  async sendText(channelId: string, text: string, _opts?: SendOptions): Promise<SentMessage> {
    // _opts (threadId) is Telegram-specific; ignored on WhatsApp.
    const id = String(this.nextCmdId++)
    const result = await this.sendWithResult({ id, type: 'send_text', channelId, text })
    if (!result.ok) throw new Error(result.error ?? 'Send failed')
    return {
      platform: 'whatsapp',
      channelId,
      messageId: result.messageId ?? id,
    }
  }

  async editMessage(
    _channelId: string,
    _messageId: string,
    _text: string,
    _opts?: SendOptions,
  ): Promise<void> {
    throw new Error('WhatsApp edit not supported in this adapter')
  }

  async sendButtons(
    channelId: string,
    text: string,
    buttons: InlineButton[],
    _opts?: SendOptions,
  ): Promise<SentMessage> {
    const numbered = buttons
      .map((b, i) => `${i + 1}. ${b.label}`)
      .join('\n')
    const combined = numbered ? `${text}\n\n${numbered}` : text
    return this.sendText(channelId, combined)
  }

  async sendTyping(_channelId: string, _opts?: SendOptions): Promise<void> {
    // No-op — omitting "typing" presence updates avoids an extra round-trip
    // through the worker; UX remains acceptable without it.
  }

  async sendFile(
    channelId: string,
    file: Buffer,
    filename: string,
    caption?: string,
    _opts?: SendOptions,
  ): Promise<SentMessage> {
    const id = String(this.nextCmdId++)
    const result = await this.sendWithResult({
      id,
      type: 'send_file',
      channelId,
      dataBase64: file.toString('base64'),
      filename,
      caption,
      mimeType: inferMimeType(filename),
    })
    if (!result.ok) throw new Error(result.error ?? 'Send failed')
    return {
      platform: 'whatsapp',
      channelId,
      messageId: result.messageId ?? id,
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private sendCommand(cmd: WorkerCommand): void {
    if (!this.proc || !this.proc.stdin?.writable) {
      throw new Error('WhatsApp worker is not running')
    }
    this.proc.stdin.write(encodeMessage(cmd))
  }

  private sendWithResult(
    cmd: Extract<WorkerCommand, { id: string }>,
  ): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // `delete` returns false if `send_result` already arrived and cleared
        // the entry; in that race we've already resolved and must not do it
        // again.
        if (this.pending.delete(cmd.id)) {
          this.log.warn('WhatsApp send timed out', {
            event: 'whatsapp_send_timeout',
            commandId: cmd.id,
            commandType: cmd.type,
            timeoutMs: this.sendTimeoutMs,
          })
          resolve({ ok: false, error: `send timed out after ${this.sendTimeoutMs}ms` })
        }
      }, this.sendTimeoutMs)
      this.pending.set(cmd.id, { resolve, timer })
      try {
        this.sendCommand(cmd)
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(cmd.id)
        this.log.error('failed to send command to WhatsApp worker', {
          event: 'whatsapp_worker_command_failed',
          commandType: cmd.type,
          error: err,
        })
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    })
  }

  /**
   * Resolve all pending sends with a failure. Called from `proc.on('exit')`
   * (worker crashed/quit) and from `destroy()` (orderly shutdown) so callers
   * never hang waiting for a worker that will never respond.
   */
  private drainPending(reason: string): void {
    if (this.pending.size === 0) return
    this.log.warn('draining pending WhatsApp sends', {
      event: 'whatsapp_pending_drain',
      count: this.pending.size,
      reason,
    })
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.resolve({ ok: false, error: reason })
    }
    this.pending.clear()
  }

  private fireEvent(event: WhatsAppEvent): void {
    for (const h of this.eventHandlers) {
      try {
        h(event)
      } catch {
        // isolate handler errors
      }
    }
  }

  private onWorkerEvent(ev: WorkerEvent): void {
    switch (ev.type) {
      case 'ready':
        this.log.info('WhatsApp worker ready', {
          event: 'whatsapp_worker_ready',
          baileysVersion: ev.baileysVersion,
          buildId: ev.buildId,
          gitSha: ev.gitSha,
        })
        return
      case 'qr':
        this.log.info('WhatsApp QR received', { event: 'whatsapp_qr_received' })
        this.fireEvent({ type: 'qr', qr: ev.qr })
        return
      case 'pairing_code':
        this.log.info('WhatsApp pairing code received', { event: 'whatsapp_pairing_code_received' })
        this.fireEvent({ type: 'pairing_code', code: ev.code })
        return
      case 'connected':
        this.connected = true
        this.log.info('WhatsApp connected', {
          event: 'whatsapp_connected',
          jid: ev.jid,
          name: ev.name,
        })
        this.fireEvent({ type: 'connected', jid: ev.jid, name: ev.name })
        return
      case 'disconnected':
        this.connected = false
        this.log.warn('WhatsApp disconnected', {
          event: 'whatsapp_disconnected',
          loggedOut: ev.loggedOut,
          reason: ev.reason,
        })
        this.fireEvent({ type: 'disconnected', loggedOut: ev.loggedOut, reason: ev.reason })
        return
      case 'read':
        if (this.readReceiptHandler) {
          this.readReceiptHandler({ platform: 'whatsapp', channelId: ev.channelId })
        }
        return
      case 'incoming':
        if (this.messageHandler) {
          // WhatsApp has no separate file_id like Telegram; reuse messageId
          // for traceability. The worker has already written the bytes to
          // `localPath`, so the router can wrap each attachment via
          // `readFileAttachment()` directly.
          const attachments: IncomingAttachment[] | undefined = ev.attachments?.map((a) => ({
            type: a.type,
            fileId: ev.messageId,
            fileName: a.fileName,
            mimeType: a.mimeType,
            fileSize: a.fileSize,
            localPath: a.localPath,
          }))
          const msg: IncomingMessage = {
            platform: 'whatsapp',
            channelId: ev.channelId,
            messageId: ev.messageId,
            senderId: ev.senderId,
            senderName: ev.senderName,
            text: ev.text,
            attachments,
            timestamp: ev.timestamp,
            raw: ev,
          }
          void this.messageHandler(msg)
        }
        return
      case 'send_result': {
        const entry = this.pending.get(ev.id)
        if (entry) {
          clearTimeout(entry.timer)
          this.pending.delete(ev.id)
          entry.resolve({ ok: ev.ok, messageId: ev.messageId, error: ev.error })
        }
        if (!ev.ok) {
          this.log.error('WhatsApp send failed', {
            event: 'whatsapp_send_failed',
            commandId: ev.id,
            error: ev.error,
          })
        }
        return
      }
      case 'error':
        this.log.error('WhatsApp worker reported error', {
          event: 'whatsapp_worker_error',
          error: ev.message,
        })
        this.fireEvent({ type: 'error', message: ev.message })
        return
      case 'unavailable':
        this.log.error('WhatsApp unavailable', {
          event: 'whatsapp_unavailable',
          reason: ev.reason,
          error: ev.message,
        })
        this.fireEvent({ type: 'unavailable', reason: ev.reason, message: ev.message })
        return
    }
  }
}

/**
 * Entry point the host loads. The adapter lives here, in the plugin — Craft only
 * knows the filename and this export name.
 *
 * `options.config` is the plugin's own saved config (`<dataDir>/config.json`).
 * Two of its values are paths the plugin cannot invent for itself:
 *
 *   workerEntry   the built Baileys worker (a .cjs bundle run by node)
 *   authStateDir  where Baileys keeps its multi-file auth state
 *
 * Leaving them to be passed in is what broke this adapter: `createAdapter()`
 * used to take no arguments, so both were always undefined and `initialize`
 * threw on every start — the plugin sat in `degraded` forever with `/health`
 * pinned at 503 and no way to show a QR. They are now filled from `options`
 * with defaults derived from the plugin's own data dir, so a fresh install can
 * pair without the person editing JSON first.
 */
let mainAdapterRef: WhatsAppAdapter | null = null

/**
 * The newest QR the main worker has emitted, kept so a page opened AFTER the
 * worker already showed a code can still pick it up: Baileys re-emits on
 * expiry, and the main worker runs the whole time the plugin process lives.
 */
let latestMainQr: { qr: string; at: number } | null = null

export function createAdapter(options?: Record<string, unknown>): WhatsAppAdapter {
  const adapter = withInjectedConfig(new WhatsAppAdapter(), options)
  mainAdapterRef = adapter
  adapter.onEvent((event) => {
    if (event.type === 'qr') latestMainQr = { qr: event.qr, at: Date.now() }
  })
  return adapter
}

/**
 * The config a plugin start will actually use.
 *
 * Exported because it is the whole fix for "initialize always throws": the two
 * required keys are resolved here, from the plugin's own data dir, instead of
 * being expected from a caller that never had them.
 */
export function resolveWhatsAppConfig(options?: Record<string, unknown>): WhatsAppConfig {
  const config = (options?.config ?? {}) as Record<string, unknown>
  const dataDir = typeof options?.dataDir === 'string' ? options.dataDir : ''
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined

  return {
    ...config,
    // Baileys state belongs beside the plugin's own data, never in the repo.
    authStateDir: str(config.authStateDir) ?? (dataDir ? join(dataDir, 'wa-auth') : ''),
    workerEntry: str(config.workerEntry) ?? defaultWorkerEntry() ?? '',
    nodeBin: str(config.nodeBin) ?? defaultNodeBin(),
  } as WhatsAppConfig
}

/**
 * Fill in the two paths from the plugin's own data dir, without changing the
 * adapter's own contract: `initialize(config)` still receives a complete
 * `WhatsAppConfig`, it just no longer arrives with the required keys missing.
 */
function withInjectedConfig(
  adapter: WhatsAppAdapter,
  options?: Record<string, unknown>,
): WhatsAppAdapter {
  const resolved = resolveWhatsAppConfig(options)

  const original = adapter.initialize.bind(adapter)
  adapter.initialize = async (incoming: PlatformConfig): Promise<void> =>
    original({ ...resolved, ...incoming, ...pickMissing(incoming, resolved) })
  return adapter
}

/**
 * Keep the adapter's own config precedence, but never let a key the caller left
 * out erase one we resolved: `initialize` is given `{...resolved, ...incoming}`,
 * and `incoming` may carry an explicit `workerEntry: undefined`.
 */
function pickMissing(incoming: PlatformConfig, resolved: WhatsAppConfig): Partial<WhatsAppConfig> {
  const out: Partial<WhatsAppConfig> = {}
  const source = incoming as Record<string, unknown>
  if (!source.authStateDir && resolved.authStateDir) out.authStateDir = resolved.authStateDir
  if (!source.workerEntry && resolved.workerEntry) out.workerEntry = resolved.workerEntry
  return out
}

/**
 * Which runtime owns the worker.
 *
 * The worker is a CommonJS bundle built for Node (Baileys' crypto deps depend on
 * Node's runtime). The plugin itself usually runs under Bun, and
 * `process.execPath` would then point at bun — which is not what the worker was
 * built for. Prefer `node` whenever we are hosted by Bun; fall back to the
 * current executable otherwise, so a plugin already running on Node keeps using
 * itself.
 */
function defaultNodeBin(): string {
  return process.versions.bun ? 'node' : process.execPath
}

/**
 * Locate the bundled worker the same way the app does.
 *
 * In-repo the worker is built to `packages/messaging-whatsapp-worker/dist/`;
 * a packaged app ships it next to the plugin. Returns undefined when neither
 * exists, which surfaces as a clear initialize error instead of a spawn ENOENT.
 */
function defaultWorkerEntry(): string | undefined {
  const candidates = [
    join(process.cwd(), 'packages', 'messaging-whatsapp-worker', 'dist', 'worker.cjs'),
    join(process.cwd(), '..', '..', 'packages', 'messaging-whatsapp-worker', 'dist', 'worker.cjs'),
    join(process.cwd(), 'resources', 'wa-worker', 'worker.cjs'),
  ]
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // Unreadable path: try the next candidate.
    }
  }
  return undefined
}

/**
 * Host entry point for sign-in.
 *
 * WhatsApp pairing is driven by the worker inside the adapter: it emits `qr`
 * while pairing and `connected` once the phone confirms. This keeps the latest
 * one so Craft can ask at any time instead of having caught the event, because
 * the adapter may emit the QR before the UI has opened its dialog. When the
 * process's main adapter exists (it does in serve.ts), sign-in drives THAT one
 * instead of a second worker, so there is never a competing socket on the
 * same auth-state dir.
 */
export function createAuth(options?: Record<string, unknown>): WhatsAppAuth {
  const resolved = resolveWhatsAppConfig(options)
  return new WhatsAppAuth(
    () => new WhatsAppAdapter(),
    resolved,
    (event, extra) => console.log(JSON.stringify({ event, ...(extra ?? {}) })),
    mainAdapterRef,
  )
}

// ---------------------------------------------------------------------------
// Sign-in (pairing) surface for the host
// ---------------------------------------------------------------------------

/**
 * WhatsApp pairing, wrapped so Craft can drive it.
 *
 * The adapter already knows how to pair — it spawns the worker, which emits
 * `qr` and then `connected`. What was missing was a place to keep the latest QR:
 * the worker can emit it before the person opens the dialog, and an event that
 * only fires once is easy to miss. This holds the most recent state so
 * `state()` always answers, and keeps the adapter alive across the flow.
 */
export class WhatsAppAuth {
  private snapshot: WeChatLikeState = { phase: 'idle' }

  private adapter: WhatsAppAdapter | null = null

  /** False when the sign-in flow drives the process's main adapter. */
  private ownsAdapter = true

  private unsubscribe: (() => void) | null = null

  private attempt = 0

  constructor(
    private readonly makeAdapter: () => WhatsAppAdapter,
    private readonly adapterConfig: Record<string, unknown>,
    private readonly log: (event: string, extra?: Record<string, unknown>) => void = () => {},
    /**
     * The process's main adapter. Sign-in drives it when present instead of
     * opening a second worker for the same auth-state dir.
     */
    private readonly preferred?: WhatsAppAdapter | null,
  ) {}

  state(): WeChatLikeState {
    return this.snapshot
  }

  async start(): Promise<WeChatLikeState> {
    // A live attempt already holds a QR (or is past the scan): return it as-is.
    // Resetting the snapshot here used to drop that QR and then sit in
    // waitForFirstSignal() until it timed out — Baileys only emits the next
    // code on rotation — so a second click on 开始授权 surfaced as a false
    // “授权失败” while the pairing was still running.
    if (
      this.adapter &&
      (this.snapshot.phase === 'awaiting' || this.snapshot.phase === 'scanned' || this.snapshot.phase === 'need_code')
    ) {
      return this.snapshot
    }

    this.attempt += 1
    this.snapshot = { phase: 'awaiting', attempt: this.attempt, detail: '正在启动 WhatsApp 配对…' }

    // Reuse a live adapter if one is already pairing; starting a second would
    // open a second socket for the same account.
    if (!this.adapter) {
      let chosen: WhatsAppAdapter | null = null
      let owns = true
      if (this.preferred) {
        if (this.preferred.running) {
          // The main worker is alive (pairing or about to connect): drive it.
          chosen = this.preferred
          owns = false
        } else {
          // The main worker died or never started: start it in place. Only a
          // broken start falls back to a dedicated worker.
          try {
            await this.preferred.initialize(this.adapterConfig as PlatformConfig)
            chosen = this.preferred
            owns = false
          } catch (error) {
            if (error instanceof Error && /already initialized/i.test(error.message)) {
              chosen = this.preferred
              owns = false
            }
          }
        }
      }
      const adapter = chosen ?? this.makeAdapter()
      this.ownsAdapter = owns
      this.unsubscribe = adapter.onEvent((event) => {
        switch (event.type) {
          case 'qr':
            this.snapshot = {
              phase: 'awaiting',
              qr: event.qr,
              attempt: this.attempt,
              detail: '请用手机 WhatsApp 扫描二维码配对',
            }
            this.log('whatsapp_qr_ready', { attempt: this.attempt })
            break
          case 'pairing_code':
            this.snapshot = {
              phase: 'awaiting',
              code: event.code,
              attempt: this.attempt,
              detail: '在手机上输入配对码',
            }
            break
          case 'connected':
            this.snapshot = {
              phase: 'connected',
              attempt: this.attempt,
              detail: event.name ? `已连接：${event.name}` : '已连接',
              // Baileys keeps its own auth state on disk; there is no token to
              // hand back. `connected` is therefore the whole credential for
              // this platform, which is why no `credentials` key is emitted.
            }
            this.log('whatsapp_connected', { attempt: this.attempt })
            break
          case 'disconnected': {
            // The worker emits this on every socket close, then reconnects for
            // anything that is not a logout — Baileys routinely drops the
            // socket right after handing out a QR (515 restart-required, or a
            // transient `statusCode=unknown`). Reporting `failed` there killed
            // a pairing that was still in progress: the QR vanished and the
            // dialog showed a failure while a fresh QR was about to arrive.
            // Only a logout, an exhausted reconnect, or a drop after we were
            // already connected is terminal.
            const pairing = this.snapshot.phase === 'awaiting' || this.snapshot.phase === 'scanned'
            if (!event.loggedOut && pairing) {
              this.snapshot = {
                ...this.snapshot,
                detail: '连接中断，正在重试…',
                error: undefined,
                attempt: this.attempt,
              }
              break
            }
            this.snapshot = {
              phase: event.loggedOut ? 'expired' : 'failed',
              attempt: this.attempt,
              error: event.reason ?? (event.loggedOut ? '已退出登录，请重新扫码' : '连接断开'),
            }
            break
          }
          case 'unavailable':
            this.snapshot = { phase: 'failed', attempt: this.attempt, error: event.message }
            break
          case 'error':
            this.snapshot = { phase: 'failed', attempt: this.attempt, error: event.message }
            break
          default:
            break
        }
      })
      this.adapter = adapter
    }

    try {
      await this.adapter.initialize(this.adapterConfig as PlatformConfig)
    } catch (error) {
      // "already initialized" means the chosen worker is already up and
      // pairing — keep going instead of reporting a failure.
      if (error instanceof Error && /already initialized/i.test(error.message)) {
        // fall through
      } else {
        this.snapshot = {
          phase: 'failed',
          attempt: this.attempt,
          error: error instanceof Error ? error.message : String(error),
        }
        return this.snapshot
      }
    }

    // initialize() only starts the worker; the QR (or a crash) arrives on an
    // event a moment later. Waiting a bounded time for that first signal means
    // a broken worker reports `failed` immediately instead of leaving the UI on
    // "启动中" until the person gives up.
    await this.waitForFirstSignal(FIRST_SIGNAL_TIMEOUT_MS)
    return this.snapshot
  }

  /** Resolve when the snapshot stops being the pre-QR placeholder, or on timeout. */
  private waitForFirstSignal(timeoutMs: number): Promise<void> {
    const startedAt = Date.now()
    const pendingPhase = this.snapshot.phase
    return new Promise((resolve) => {
      const tick = () => {
        const moved = this.snapshot.phase !== pendingPhase || Boolean(this.snapshot.qr)
        if (moved || Date.now() - startedAt >= timeoutMs) {
          resolve()
          return
        }
        setTimeout(tick, 100)
      }
      tick()
    })
  }

  async submit(code: string): Promise<WeChatLikeState> {
    const trimmed = code.trim()
    if (!trimmed) return this.snapshot
    try {
      await this.adapter?.requestPairingCode(trimmed)
      return { ...this.snapshot, detail: '已提交手机号，等待配对码' }
    } catch (error) {
      return {
        ...this.snapshot,
        phase: 'failed',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async cancel(): Promise<WeChatLikeState> {
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.ownsAdapter && this.adapter) {
      try {
        await this.adapter.destroy()
      } catch {
        // Destroying a half-started adapter is best-effort.
      }
      this.adapter = null
    }
    // The main adapter (when the flow reused it) stays alive: its worker keeps
    // pairing in the background, so re-opening the page picks the same QR up
    // instead of forcing a fresh attempt.
    this.snapshot = { phase: 'idle', attempt: this.attempt }
    return this.snapshot
  }
}

/**
 * How long `start()` waits for the worker's first QR / failure signal.
 *
 * Must stay well under the host relay's own 10 s ceiling
 * (callPluginAction in server-core): when this wait outlived it, the page got
 * an abortive timeout and showed “授权失败” while the pairing was still running.
 */
const FIRST_SIGNAL_TIMEOUT_MS = 6_000

/** One snapshot shape, shared with the WeChat provider. */
interface WeChatLikeState {
  phase: 'idle' | 'awaiting' | 'scanned' | 'need_code' | 'connected' | 'expired' | 'failed'
  qr?: string
  code?: string
  expiresAt?: number
  detail?: string
  error?: string
  attempt?: number
  credentials?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Sign-in surface for the plugin's own page (and host relays)
// ---------------------------------------------------------------------------

/**
 * The auth options this process was started with, read from the same env the
 * host gave serve.ts. Keeps the sign-in flow self-contained in this module.
 */
function readAuthOptions(): Record<string, unknown> {
  const configPath = process.env.CRAFT_LISTENER_CONFIG
  let config: Record<string, unknown> = {}
  if (configPath) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    } catch {
      // A missing or unreadable config is the just-installed state.
    }
  }
  return { config, dataDir: process.env.CRAFT_LISTENER_DATA ?? '' }
}

let authSingleton: WhatsAppAuth | null = null

function getAuth(): WhatsAppAuth {
  if (!authSingleton) authSingleton = createAuth(readAuthOptions())
  return authSingleton
}

/**
 * Plugin-side action handler. Auth actions move the sign-in state machine and
 * answer with its full state as JSON in `message`; send actions go through the
 * main adapter. Anything else is an honest refusal.
 */
export function performAction(
  action: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; message?: string }> {
  switch (action) {
    case 'auth_start':
      return getAuth()
        .start()
        .then((st) => ({ ok: true, message: JSON.stringify(st) }))
    case 'auth_state': {
      // The running main worker is the source of truth first: it may be
      // connected, or holding a QR the page hasn't been shown yet.
      if (mainAdapterRef?.isConnected()) {
        return Promise.resolve({ ok: true, message: JSON.stringify({ phase: 'connected', detail: '已连接' }) })
      }
      const st = getAuth().state()
      if (st.phase === 'idle' && latestMainQr && Date.now() - latestMainQr.at < 90_000) {
        return Promise.resolve({
          ok: true,
          message: JSON.stringify({
            phase: 'awaiting',
            qr: latestMainQr.qr,
            detail: '请用手机 WhatsApp 扫描二维码配对',
          }),
        })
      }
      return Promise.resolve({ ok: true, message: JSON.stringify(st) })
    }
    case 'auth_submit':
      return getAuth()
        .submit(typeof args.code === 'string' ? args.code : '')
        .then((st) => ({ ok: true, message: JSON.stringify(st) }))
    case 'auth_cancel':
      return getAuth()
        .cancel()
        .then((st) => ({ ok: true, message: JSON.stringify(st) }))
    case 'send_message':
    case 'reply':
      return Promise.resolve().then(async () => {
        const text = typeof args.text === 'string' ? args.text.trim() : ''
        const channelId = typeof args.channelId === 'string' ? args.channelId : ''
        if (!text || !channelId) return { ok: false, message: 'text 与 channelId 必填' }
        if (!mainAdapterRef) return { ok: false, message: '适配器未就绪' }
        try {
          await mainAdapterRef.sendText(channelId, text)
          return { ok: true, message: `已发送到 ${channelId}` }
        } catch (err) {
          return { ok: false, message: err instanceof Error ? err.message : String(err) }
        }
      })
    default:
      return Promise.resolve({ ok: false, message: `插件不支持动作 ${action}` })
  }
}
