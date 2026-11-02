import * as React from 'react'
import { useTranslation } from "react-i18next"
import { Check, Globe, Copy, RefreshCw, Link2Off } from 'lucide-react'
import type { MenuComponents } from '@/components/ui/menu-context'

export interface ShareMenuItemsProps {
  /** Open the published share URL in the system browser. */
  onOpenInBrowser: () => void
  /** Copy the published share URL to the clipboard. */
  onCopyLink: () => void | Promise<void>
  /** Re-publish the share (bumps the snapshot). */
  onUpdateShare: () => void | Promise<void>
  /** Revoke the share. */
  onRevokeShare: () => void | Promise<void>
  menu: Pick<MenuComponents, 'MenuItem' | 'Separator'>
}

/**
 * Render-only — side effects come from `useSessionMenuActions`. Both the
 * desktop dropdown and the compact drawer wire the same hook callbacks
 * through this component (compact uses its own row primitives, but the
 * action set is identical).
 */
export function ShareMenuItems({
  onOpenInBrowser,
  onCopyLink,
  onUpdateShare,
  onRevokeShare,
  menu,
}: ShareMenuItemsProps) {
  const { t } = useTranslation()
  const { MenuItem, Separator } = menu

  return (
    <>
      <MenuItem onClick={onOpenInBrowser}>
        <Globe className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sessionMenu.openInBrowser")}</span>
      </MenuItem>
      <MenuItem onClick={onCopyLink}>
        <Copy className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sessionMenu.copyLink")}</span>
      </MenuItem>
      <MenuItem onClick={onUpdateShare}>
        <RefreshCw className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sessionMenu.updateShare")}</span>
      </MenuItem>
      <Separator />
      <MenuItem onClick={onRevokeShare} variant="destructive">
        <Link2Off className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sessionMenu.stopSharing")}</span>
      </MenuItem>
    </>
  )
}
