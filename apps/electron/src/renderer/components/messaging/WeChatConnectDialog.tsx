/**
 * WeChatConnectDialog — WeChat (ClawBot) QR-scan connect flow.
 *
 * Mirrors the WhatsApp pairing dialog: the renderer calls startWeChatConnect(),
 * the gateway fetches a bot QR code and broadcasts progress via onWeChatEvent
 * (qr → scanning → need_verifycode → connected | expired | error).
 */

import * as React from 'react'
import { Check } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@craft-agent/ui'
import { useActiveWorkspace } from '@/context/AppShellContext'
import type { WeChatUiEvent } from '../../../shared/types'

interface WeChatConnectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** When true, treat the flow as "replace existing credentials". */
  reconfigure?: boolean
  onSaved?: () => void
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'show_qr'; qr: string }
  | { kind: 'scanning'; qr: string }
  | { kind: 'need_verifycode'; qr: string }
  | { kind: 'connected'; botId?: string }
  | { kind: 'expired' }
  | { kind: 'error'; message: string }

export function WeChatConnectDialog({
  open,
  onOpenChange,
  reconfigure = false,
  onSaved,
}: WeChatConnectDialogProps) {
  const { t } = useTranslation()
  const activeWorkspace = useActiveWorkspace()
  const activeWorkspaceId = activeWorkspace?.id
  const [phase, setPhase] = React.useState<Phase>({ kind: 'idle' })
  const [verifyCode, setVerifyCode] = React.useState('')
  const [submittingCode, setSubmittingCode] = React.useState(false)

  React.useEffect(() => {
    if (!open || !activeWorkspaceId) return
    const off = window.electronAPI.onWeChatEvent(({ workspaceId, event }) => {
      if (workspaceId !== activeWorkspaceId) return
      handleEvent(event)
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeWorkspaceId])

  React.useEffect(() => {
    if (!open || phase.kind !== 'idle') return
    setPhase({ kind: 'starting' })
    setVerifyCode('')
    window.electronAPI
      .startWeChatConnect()
      .catch((err) => setPhase({ kind: 'error', message: errorMsg(err) }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  React.useEffect(() => {
    if (!open) {
      setPhase({ kind: 'idle' })
      setVerifyCode('')
      setSubmittingCode(false)
    }
  }, [open])

  const handleEvent = (event: WeChatUiEvent) => {
    switch (event.type) {
      case 'qr':
        setPhase({ kind: 'show_qr', qr: event.qr })
        setVerifyCode('')
        setSubmittingCode(false)
        return
      case 'scanning':
        setPhase((prev) =>
          prev.kind === 'show_qr' || prev.kind === 'need_verifycode' || prev.kind === 'scanning'
            ? { kind: 'scanning', qr: prev.qr }
            : prev,
        )
        return
      case 'need_verifycode':
        setPhase((prev) =>
          prev.kind === 'show_qr' || prev.kind === 'need_verifycode' || prev.kind === 'scanning'
            ? { kind: 'need_verifycode', qr: prev.qr }
            : prev,
        )
        return
      case 'connected':
        setPhase({ kind: 'connected', botId: event.botId })
        setTimeout(() => {
          onSaved?.()
          onOpenChange(false)
        }, 1200)
        return
      case 'expired':
        setPhase({ kind: 'expired' })
        return
      case 'error':
        setPhase({ kind: 'error', message: event.message })
        return
    }
  }

  const handleSubmitCode = async () => {
    if (!verifyCode.trim() || submittingCode) return
    setSubmittingCode(true)
    try {
      await window.electronAPI.submitWeChatVerifyCode(verifyCode)
      // The gateway emits `scanning` once the code is accepted; keep the
      // dialog showing the QR until then.
      setPhase((prev) => (prev.kind === 'need_verifycode' ? { kind: 'scanning', qr: prev.qr } : prev))
    } catch (err) {
      setPhase({ kind: 'error', message: errorMsg(err) })
    } finally {
      setSubmittingCode(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            {reconfigure
              ? t('settings.messaging.wechat.reconfigureTitle')
              : t('settings.messaging.wechat.connectTitle')}
          </DialogTitle>
          <DialogDescription>{t('settings.messaging.wechat.description')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          {phase.kind === 'starting' && (
            <StatusRow icon={<Spinner className="text-[16px]" />}>
              {t('settings.messaging.wechat.starting')}
            </StatusRow>
          )}

          {(phase.kind === 'show_qr' || phase.kind === 'need_verifycode') && (
            <div className="flex flex-col items-center gap-3">
              <div className="rounded-lg bg-white p-4">
                <QRCodeSVG value={phase.qr} size={240} level="M" />
              </div>

              {phase.kind === 'show_qr' && (
                <p className="whitespace-pre-line text-center text-sm text-muted-foreground">
                  {t('settings.messaging.wechat.qrInstructions')}
                </p>
              )}

              {phase.kind === 'need_verifycode' && (
                <div className="flex w-full max-w-[300px] flex-col gap-2">
                  <p className="text-center text-sm text-muted-foreground">
                    {t('settings.messaging.wechat.verifyCodeHint')}
                  </p>
                  <div className="flex gap-2">
                    <Input
                      value={verifyCode}
                      onChange={(e) => setVerifyCode(e.target.value)}
                      placeholder={t('settings.messaging.wechat.verifyCodePlaceholder')}
                      inputMode="numeric"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleSubmitCode()
                      }}
                    />
                    <Button onClick={handleSubmitCode} disabled={submittingCode || !verifyCode.trim()}>
                      {submittingCode ? (
                        <Spinner className="size-4" />
                      ) : (
                        t('settings.messaging.wechat.verifyCodeSubmit')
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {phase.kind === 'scanning' && (
            <div className="flex flex-col items-center gap-4 py-8">
              <Spinner className="size-10 text-primary" />
              <div className="flex flex-col items-center gap-1 text-center">
                <p className="text-sm font-medium">
                  {t('settings.messaging.wechat.connectingTitle')}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t('settings.messaging.wechat.scanned')}
                </p>
                <p className="max-w-[320px] text-xs text-muted-foreground">
                  {t('settings.messaging.wechat.connectingWait')}
                </p>
                <p className="max-w-[320px] text-xs text-muted-foreground">
                  {t('settings.messaging.wechat.scannedHint')}
                </p>
              </div>
            </div>
          )}

          {phase.kind === 'connected' && (
            <StatusRow icon={<Check className="h-4 w-4 text-emerald-500" />}>
              {t('settings.messaging.wechat.connected')}
            </StatusRow>
          )}

          {phase.kind === 'expired' && (
            <div className="flex flex-col items-center gap-3">
              <p className="text-sm text-muted-foreground">
                {t('settings.messaging.wechat.expired')}
              </p>
              <Button
                variant="outline"
                onClick={() => {
                  setPhase({ kind: 'starting' })
                  window.electronAPI
                    .startWeChatConnect()
                    .catch((err) => setPhase({ kind: 'error', message: errorMsg(err) }))
                }}
              >
                {t('settings.messaging.wechat.refresh')}
              </Button>
            </div>
          )}

          {phase.kind === 'error' && (
            <div className="flex flex-col gap-3">
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                {phase.message}
              </div>
              <Button
                variant="outline"
                onClick={() => {
                  setPhase({ kind: 'starting' })
                  window.electronAPI
                    .startWeChatConnect()
                    .catch((err) => setPhase({ kind: 'error', message: errorMsg(err) }))
                }}
              >
                {t('settings.messaging.wechat.retry')}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function StatusRow({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {icon}
      <span>{children}</span>
    </div>
  )
}

function errorMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
