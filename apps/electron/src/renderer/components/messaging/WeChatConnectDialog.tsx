/**
 * WeChatConnectDialog — WeChat (ClawBot) connect flow.
 *
 * WeChat uses a QR-scan auth flow (personal WeChat account as the bot host).
 * The scan + token exchange is performed by a CLI helper that writes the
 * resulting credentials straight into the encrypted credential store; this
 * dialog lets the operator paste those credentials (or re-enter them) to
 * (re)initialize the WeChat adapter.
 *
 * Credential shape (JSON): { botToken, baseUrl?, botId?, userId? }
 */

import * as React from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@craft-agent/ui'

interface WeChatConnectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** When true, treat the flow as "replace existing credentials". */
  reconfigure?: boolean
  onSaved?: () => void
}

export function WeChatConnectDialog({
  open,
  onOpenChange,
  reconfigure = false,
  onSaved,
}: WeChatConnectDialogProps) {
  const { t } = useTranslation()
  const [credsJson, setCredsJson] = React.useState('')
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (!open) {
      setCredsJson('')
      setSaving(false)
    }
  }, [open])

  /** Parse the pasted JSON; returns parsed creds or throws with a friendly message. */
  const parseCreds = (): { botToken: string; baseUrl?: string; botId?: string; userId?: string } => {
    const raw = credsJson.trim()
    if (!raw) throw new Error(t('settings.messaging.wechat.empty'))
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(t('settings.messaging.wechat.invalidJson'))
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(t('settings.messaging.wechat.invalidJson'))
    }
    const obj = parsed as Record<string, unknown>
    if (typeof obj.botToken !== 'string' || obj.botToken.length === 0) {
      throw new Error(t('settings.messaging.wechat.missingToken'))
    }
    return {
      botToken: obj.botToken,
      baseUrl: typeof obj.baseUrl === 'string' ? obj.baseUrl : undefined,
      botId: typeof obj.botId === 'string' ? obj.botId : undefined,
      userId: typeof obj.userId === 'string' ? obj.userId : undefined,
    }
  }

  const handleSave = async () => {
    let creds: ReturnType<typeof parseCreds>
    try {
      creds = parseCreds()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.messaging.wechat.invalidJson'))
      return
    }
    setSaving(true)
    try {
      await window.electronAPI.saveWeChatCredentials(creds)
      toast.success(t('settings.messaging.wechat.saved'))
      onSaved?.()
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.messaging.wechat.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const placeholder =
    '{\n  "botToken": "ilink_bot_token_xxx",\n  "baseUrl": "https://ilinkai.weixin.qq.com",\n  "botId": "ilink_bot_id",\n  "userId": "ilink_user_id"\n}'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>
            {reconfigure
              ? t('settings.messaging.wechat.reconfigureTitle')
              : t('settings.messaging.wechat.connectTitle')}
          </DialogTitle>
          <DialogDescription className="whitespace-pre-line">
            {t('settings.messaging.wechat.instructions')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div>
            <div className="mb-1.5 text-xs font-medium">
              {t('settings.messaging.wechat.credentialsLabel')}
            </div>
            <textarea
              className="h-36 w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
              value={credsJson}
              onChange={(e) => setCredsJson(e.target.value)}
              placeholder={placeholder}
              disabled={saving}
              spellCheck={false}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t('settings.messaging.wechat.credentialsHint')}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? <Spinner className="size-4" /> : t('settings.messaging.wechat.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}