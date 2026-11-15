/**
 * Plugin sign-in — the「连接」entry in the detail page title bar plus the
 * dialog that carries the QR code.
 *
 * The plugin owns the sign-in conversation (it talks to WeChat / WhatsApp);
 * Craft only relays. Everything here is a view over `PluginAuthStateDto`:
 *
 *   1. Probe once when the plugin is running. `unsupported` (HTTP 404 from the
 *      plugin) hides the entry entirely — a plugin with no sign-in flow must
 *      not grow a dead button. `connected` shows the quiet「已连接」state.
 *   2. Opening the dialog starts a flow when nothing is in flight, then polls
 *      `getPluginAuthState` every 2 s while the flow is live.
 *
 * Why polling and not just events: `onPluginAuthEvent` only fires when the
 * host handles a call, and the plugin process cannot push to Craft. Without
 * the poll a successful scan would never reach the screen (step 4.1 recorded
 * this as a deliberate trade-off, not an omission).
 *
 * The QR string is raw (a WeChat URL or a 237-char Baileys blob); it is
 * encoded here with qrcode.react. It always sits on a white plate with a real
 * quiet zone — a dark-mode background would either invert the code or leave
 * pale-on-pale, both unscannable.
 */

import * as React from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Check, Loader2, PlugZap, RefreshCw, X } from 'lucide-react'
import type { PluginAuthStateDto } from '@craft-agent/shared/protocol/dto'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

type AuthState = PluginAuthStateDto
type AuthPhase = AuthState['phase']

const LIVE_PHASES: AuthPhase[] = ['awaiting', 'scanned', 'need_code']
const POLL_MS = 2000

/** Human sentence per phase; `detail` from the plugin wins when present. */
const PHASE_TEXT: Record<AuthPhase, string> = {
  idle: '还没有开始授权',
  awaiting: '请用手机扫码',
  scanned: '已扫码，请在手机上确认',
  need_code: '请输入手机上显示的验证码',
  connected: '已连接',
  expired: '二维码已过期',
  failed: '授权失败',
}

const ERROR_HINT: Record<string, string> = {
  unsupported: '这个插件没有提供扫码授权流程',
  'not-running': '请先启用插件，再点连接',
  timeout: '插件没有在时限内回应，稍后重试',
  'bad-payload': '插件版本过旧，返回了无法识别的状态',
  rejected: '插件拒绝了这次调用',
}

interface CallResult {
  ok: boolean
  state?: AuthState
  code?: string
  error?: string
}

export interface ListenerAuthControlProps {
  workspaceId: string
  listenerId: string
  /**
   * The plugin process is up and serving its control port, so a sign-in can be
   * handed to it. Not the same as `state === 'running'`: a plugin with no
   * credentials yet is up precisely so that it *can* be authorised, and that is
   * the state this flag exists to express.
   */
  signInReady: boolean
  /** Called once a flow reaches `connected`, so the page can re-read the plugin. */
  onConnected?: () => void
}

/**
 * Title-bar entry + dialog. Kept in one component so the entry can show the
 * connected state without the page holding auth state of its own.
 */
export function ListenerAuthButton({
  workspaceId,
  listenerId,
  signInReady,
  onConnected,
}: ListenerAuthControlProps): React.ReactElement | null {
  const [open, setOpen] = React.useState(false)
  const [supported, setSupported] = React.useState<boolean | null>(null)
  const [connected, setConnected] = React.useState(false)

  // Probe once per (plugin, liveness) so a connected plugin shows「已连接」and a
  // plugin without a sign-in flow shows nothing at all.
  React.useEffect(() => {
    let cancelled = false
    if (!signInReady) {
      setConnected(false)
      return
    }
    void window.electronAPI
      .getPluginAuthState(workspaceId, listenerId)
      .then((res: CallResult) => {
        if (cancelled) return
        if (res.ok) {
          setSupported(true)
          setConnected(res.state?.phase === 'connected')
        } else {
          setSupported(res.code !== 'unsupported')
          setConnected(false)
        }
      })
      .catch(() => {
        // A failed probe leaves the entry visible; the dialog explains why.
        if (!cancelled) setSupported(true)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, listenerId, signInReady])

  if (supported === false) return null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!signInReady}
        title={signInReady ? '扫码授权' : '请先启用插件'}
        className="h-7 px-2 shrink-0 inline-flex items-center gap-1.5 rounded-md border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-50"
      >
        {connected ? <Check className="h-3 w-3 text-primary" /> : <PlugZap className="h-3 w-3" />}
        {connected ? '已连接' : '连接'}
      </button>
      <ListenerAuthDialog
        open={open}
        onOpenChange={setOpen}
        workspaceId={workspaceId}
        listenerId={listenerId}
        signInReady={signInReady}
        onConnected={() => {
          setConnected(true)
          onConnected?.()
        }}
      />
    </>
  )
}

function ListenerAuthDialog({
  open,
  onOpenChange,
  workspaceId,
  listenerId,
  signInReady,
  onConnected,
}: ListenerAuthControlProps & {
  open: boolean
  onOpenChange: (next: boolean) => void
}): React.ReactElement {
  const [state, setState] = React.useState<AuthState | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [code, setCode] = React.useState('')
  const attemptRef = React.useRef(0)
  // Ties the code image to the sentence that explains what to do with it.
  const instructionId = React.useId()
  // The actions swap as the phase moves (重新获取 disappears once the flow
  // ends). If one of them held focus, keep the keyboard inside the dialog
  // instead of dropping it to the document body.
  const closeRef = React.useRef<HTMLButtonElement | null>(null)

  const apply = React.useCallback((next: AuthState | null | undefined) => {
    if (!next) return
    // A newer attempt supersedes late answers from the old one.
    if (typeof next.attempt === 'number' && next.attempt < attemptRef.current) return
    if (typeof next.attempt === 'number') attemptRef.current = next.attempt
    setState(next)
    setError(null)
  }, [])

  const handle = React.useCallback(
    (res: CallResult) => {
      if (res.ok) {
        apply(res.state)
        if (res.state?.phase === 'connected') onConnected?.()
        return
      }
      setError(res.error ?? ERROR_HINT[res.code ?? ''] ?? '授权没有成功')
    },
    [apply, onConnected],
  )

  const start = React.useCallback(async () => {
    setBusy(true)
    try {
      handle(await window.electronAPI.startPluginAuth(workspaceId, listenerId))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [workspaceId, listenerId, handle])

  // Open: probe first (a flow may already be live), start one if there is none.
  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    setCode('')
    ;(async () => {
      try {
        const probe = await window.electronAPI.getPluginAuthState(workspaceId, listenerId)
        if (cancelled) return
        if (probe.ok && probe.state) {
          apply(probe.state)
          if (LIVE_PHASES.includes(probe.state.phase) || probe.state.phase === 'connected') return
        } else if (probe.code === 'unsupported') {
          setError(ERROR_HINT.unsupported)
          return
        }
        await start()
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, workspaceId, listenerId, apply, start])

  // Push events (when the host relays something) — faster than the poll.
  React.useEffect(() => {
    if (!open) return
    const off = window.electronAPI.onPluginAuthEvent((wsId: string, next: AuthState) => {
      if (wsId !== workspaceId || next.listenerId !== listenerId) return
      apply(next)
      if (next.phase === 'connected') onConnected?.()
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [open, workspaceId, listenerId, apply, onConnected])

  // The load-bearing poll: the plugin cannot push, so a scan only reaches the
  // screen through this.
  const phase = state?.phase
  React.useEffect(() => {
    if (!open || !phase || !LIVE_PHASES.includes(phase)) return
    const timer = setInterval(() => {
      void window.electronAPI
        .getPluginAuthState(workspaceId, listenerId)
        .then((res) => {
          if (res.ok) apply(res.state)
        })
        .catch(() => {
          /* keep the last state; the next tick retries */
        })
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [open, phase, workspaceId, listenerId, apply])

  // Closing releases the worker on the plugin side.
  const close = React.useCallback(
    (next: boolean) => {
      if (!next) {
        void window.electronAPI.cancelPluginAuth(workspaceId, listenerId).catch(() => {})
      }
      onOpenChange(next)
    },
    [workspaceId, listenerId, onOpenChange],
  )

  const submit = async () => {
    const trimmed = code.trim()
    if (!trimmed) return
    setBusy(true)
    try {
      handle(await window.electronAPI.submitPluginAuthCode(workspaceId, listenerId, trimmed))
      setCode('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  React.useEffect(() => {
    if (!open) return
    if (document.activeElement === document.body) closeRef.current?.focus()
  }, [open, phase])

  const showQr = Boolean(state?.qr) && phase !== 'connected' && phase !== 'failed'
  const live = phase ? LIVE_PHASES.includes(phase) : false
  const statusText = error ?? (phase ? state?.detail ?? PHASE_TEXT[phase] : '正在联系插件…')

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-sm">连接插件</DialogTitle>
          <DialogDescription className="text-[11px]">
            {signInReady ? '扫码过程由插件自己完成，Craft 只负责显示。' : '插件当前没有运行，请先启用。'}
          </DialogDescription>
        </DialogHeader>

        {/* Status is announced, not just coloured. */}
        <div aria-live="polite" className="text-xs text-foreground/80 min-h-4">
          {busy && live === false && !error ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" />
              {statusText}
            </span>
          ) : (
            statusText
          )}
        </div>

        {showQr && (
          <div className="flex flex-col items-center gap-2">
            {/* White plate + 4-module quiet zone: the code stays scannable in
                dark mode, where the page background would swallow it. */}
            <div className="rounded-md bg-white p-3 ring-1 ring-black/10">
              <QRCodeSVG
                value={state?.qr ?? ''}
                size={208}
                marginSize={4}
                bgColor="#ffffff"
                fgColor="#000000"
                level="M"
                role="img"
                aria-label="授权二维码"
                aria-describedby={instructionId}
                title="授权二维码"
              />
            </div>
            {state?.qr && /^https?:\/\//i.test(state.qr) && (
              <a
                href={state.qr}
                target="_blank"
                rel="noreferrer"
                className="max-w-full text-[11px] text-primary hover:underline truncate"
              >
                {state.qr}
              </a>
            )}
            <p id={instructionId} className="text-[11px] text-muted-foreground text-center">
              用手机扫描上方二维码。二维码失效后点「重新获取」。
              {state?.qr && !/^https?:\/\//i.test(state.qr)
                ? '若无法扫描，请在该插件里重新发起连接。'
                : null}
            </p>
          </div>
        )}

        {phase === 'need_code' && (
          <div className="flex items-center gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit()
              }}
              placeholder="验证码"
              aria-label="验证码"
              inputMode="numeric"
              className="flex-1 min-w-0 h-8 px-2 text-xs font-mono bg-muted/50 rounded border border-transparent focus:border-border focus:outline-none"
            />
            <button
              type="button"
              disabled={busy || code.trim() === ''}
              onClick={() => void submit()}
              className="h-8 px-2.5 rounded-md bg-primary text-primary-foreground text-xs disabled:opacity-50 shrink-0"
            >
              提交
            </button>
          </div>
        )}

        {phase === 'connected' && (
          <p className="text-[11px] text-muted-foreground">
            授权已完成，凭据已写入该插件的配置文件（config.json）。这里只显示结果，不会重复写入。
          </p>
        )}

        <div className="flex items-center justify-end gap-2">
          {(phase === 'expired' || phase === 'failed' || error) && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setError(null)
                void start()
              }}
              className="h-7 px-2.5 inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground text-xs disabled:opacity-50"
            >
              <RefreshCw className="h-3 w-3" />
              {phase === 'expired' ? '重新获取二维码' : '重试'}
            </button>
          )}
          {live && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void start()}
              className="h-7 px-2.5 inline-flex items-center gap-1.5 rounded-md border border-border text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw className="h-3 w-3" />
              重新获取
            </button>
          )}
          <button
            ref={closeRef}
            type="button"
            onClick={() => close(false)}
            className="h-7 px-2.5 inline-flex items-center gap-1.5 rounded-md border border-border text-xs text-muted-foreground hover:text-foreground"
          >
            {phase === 'connected' ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
            {phase === 'connected' ? '完成' : '取消'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
