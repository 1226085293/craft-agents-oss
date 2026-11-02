/**
 * useSessionMenuActions
 *
 * Single source of truth for session-menu side effects (share / refresh title /
 * copy path / show in finder / open in new panel / share-submenu actions).
 * Consumed by both `SessionMenu` (desktop dropdown / context menu) and
 * `CompactSessionMenu` (compact-mode drawer) so a new session action only has
 * to be wired through one place.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { navigate, routes } from '@/lib/navigate'
import type { SessionMeta } from '@/atoms/sessions'

export interface UseSessionMenuActionsOptions {
  item: SessionMeta
}

export interface SessionMenuActions {
  share: () => Promise<void>
  showInFinder: () => void
  copyPath: () => Promise<void>
  refreshTitle: () => Promise<void>
  openInNewPanel: () => void
  /** Open the session's published share URL in the system browser (no-op if not shared). */
  openSharedInBrowser: () => void
  /** Copy the session's published share URL to the clipboard (no-op if not shared). */
  copySharedLink: () => Promise<void>
  /** Re-publish the share to bump the snapshot. */
  updateShare: () => Promise<void>
  /** Revoke the share. */
  revokeShare: () => Promise<void>
}

export function useSessionMenuActions({
  item,
}: UseSessionMenuActionsOptions): SessionMenuActions {
  const { t } = useTranslation()
  const sessionId = item.id
  const sharedUrl = item.sharedUrl

  const share = React.useCallback(async () => {
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'shareToViewer' }) as { success: boolean; url?: string; error?: string } | undefined
    if (result?.success && result.url) {
      await navigator.clipboard.writeText(result.url)
      toast.success(t('toast.linkCopied'), {
        description: result.url,
        action: {
          label: t('common.open'),
          onClick: () => window.electronAPI.openUrl(result.url!),
        },
      })
    } else {
      toast.error(t('toast.failedToShare'), { description: result?.error || t('toast.unknownError') })
    }
  }, [sessionId, t])

  const showInFinder = React.useCallback(() => {
    window.electronAPI.sessionCommand(sessionId, { type: 'showInFinder' })
  }, [sessionId])

  const copyPath = React.useCallback(async () => {
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'copyPath' }) as { success: boolean; path?: string } | undefined
    if (result?.success && result.path) {
      await navigator.clipboard.writeText(result.path)
      toast.success(t('toast.pathCopied'))
    }
  }, [sessionId, t])

  const refreshTitle = React.useCallback(async () => {
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'refreshTitle' }) as { success: boolean; title?: string; error?: string } | undefined
    if (result?.success) {
      toast.success(t('toast.titleRefreshed'), { description: result.title })
    } else {
      toast.error(t('toast.failedToRefreshTitle'), { description: result?.error || t('toast.unknownError') })
    }
  }, [sessionId, t])

  const openInNewPanel = React.useCallback(() => {
    navigate(routes.view.allSessions(sessionId), { newPanel: true })
  }, [sessionId])

  const openSharedInBrowser = React.useCallback(() => {
    if (!sharedUrl) return
    window.electronAPI.openUrl(sharedUrl)
  }, [sharedUrl])

  const copySharedLink = React.useCallback(async () => {
    if (!sharedUrl) return
    await navigator.clipboard.writeText(sharedUrl)
    toast.success(t('toast.linkCopied'))
  }, [sharedUrl, t])

  const updateShare = React.useCallback(async () => {
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'updateShare' })
    if (result && 'success' in result && result.success) {
      toast.success(t('chat.shareUpdated'))
    } else {
      const errorMsg = result && 'error' in result ? result.error : undefined
      toast.error(t('chat.failedToUpdateShare'), { description: errorMsg })
    }
  }, [sessionId, t])

  const revokeShare = React.useCallback(async () => {
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'revokeShare' })
    if (result && 'success' in result && result.success) {
      toast.success(t('chat.sharingStopped'))
    } else {
      const errorMsg = result && 'error' in result ? result.error : undefined
      toast.error(t('chat.failedToStopSharing'), { description: errorMsg })
    }
  }, [sessionId, t])

  return {
    share,
    showInFinder,
    copyPath,
    refreshTitle,
    openInNewPanel,
    openSharedInBrowser,
    copySharedLink,
    updateShare,
    revokeShare,
  }
}
