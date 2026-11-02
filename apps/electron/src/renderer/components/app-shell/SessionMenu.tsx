/**
 * SessionMenu - Shared menu content for session actions
 *
 * Used by:
 * - SessionList (dropdown via "..." button, context menu via right-click)
 * - ChatPage (title dropdown menu, desktop only — compact mode uses
 *   `CompactSessionMenu` which renders these same actions in a Drawer)
 *
 * Renders menu items via `useMenuComponents()` so the same content works
 * inside DropdownMenu or ContextMenu primitives. Side-effect handlers and
 * optimistic state come from `useSessionMenuActions`, shared with
 * the compact-mode drawer to keep behaviour in one place.
 */

import * as React from 'react'
import { useTranslation } from "react-i18next"
import {
  Archive,
  ArchiveRestore,
  Trash2,
  Pencil,
  Flag,
  FlagOff,
  MailOpen,
  FolderOpen,
  Copy,
  AppWindow,
  Columns2,
  CloudUpload,
  RefreshCw,
  Send,
  FolderKanban,
  Check,
} from 'lucide-react'
import { useMenuComponents } from '@/components/ui/menu-context'
import { ShareMenuItems } from './SessionMenuParts'
import { getFileManagerName } from '@/lib/platform'
import type { SessionMeta } from '@/atoms/sessions'
import { hasUnreadMeta, hasMessagesMeta } from '@/utils/session'
import { MessagingSessionMenuItem } from '@/components/messaging/MessagingSessionMenuItem'
import { useSessionMenuActions } from '@/hooks/useSessionMenuActions'

export interface SessionMenuProjectOption {
  id: string
  slug: string
  name: string
}

export interface SessionMenuProps {
  /** Session data — display state is derived from this */
  item: SessionMeta
  /** Whether multiple workspaces exist (enables "Send to Workspace" item) */
  hasTransferTargets?: boolean
  /** Workspace projects (omit to hide the submenu) */
  projects?: SessionMenuProjectOption[]
  /** Callback for binding/unbinding the session to a project. `null` = unbind. */
  onSetProjectId?: (projectId: string | null) => void
  /** Callbacks */
  onRename: () => void
  onArchive: () => void
  onUnarchive: () => void
  onMarkUnread: () => void
  onOpenInNewWindow: () => void
  onSendToWorkspace?: () => void
  onDelete: () => void
}

/**
 * SessionMenu - Renders the menu items for session actions
 * This is the content only, not wrapped in a DropdownMenu
 */
export function SessionMenu({
  item,
  onRename,
  onArchive,
  onUnarchive,
  onMarkUnread,
  onOpenInNewWindow,
  onSendToWorkspace,
  onDelete,
  hasTransferTargets,
  projects = [],
  onSetProjectId,
}: SessionMenuProps) {
  const { t } = useTranslation()

  const sessionId = item.id
  const isArchived = item.isArchived ?? false
  const sharedUrl = item.sharedUrl
  const _hasMessages = hasMessagesMeta(item)
  const _hasUnread = hasUnreadMeta(item)

  const actions = useSessionMenuActions({ item })

  // Get menu components from context (works with both DropdownMenu and ContextMenu)
  const { MenuItem, Separator, Sub, SubTrigger, SubContent } = useMenuComponents()

  return (
    <>
      {/* Share/Shared based on shared state */}
      {!sharedUrl ? (
        <MenuItem onClick={actions.share}>
          <CloudUpload className="h-3.5 w-3.5" />
          <span className="flex-1">{t("sessionMenu.share")}</span>
        </MenuItem>
      ) : (
        <Sub>
          <SubTrigger className="pr-2">
            <CloudUpload className="h-3.5 w-3.5" />
            <span className="flex-1">{t("sessionMenu.shared")}</span>
          </SubTrigger>
          <SubContent>
            <ShareMenuItems
              onOpenInBrowser={actions.openSharedInBrowser}
              onCopyLink={actions.copySharedLink}
              onUpdateShare={actions.updateShare}
              onRevokeShare={actions.revokeShare}
              menu={{ MenuItem, Separator }}
            />
          </SubContent>
        </Sub>
      )}

      {/* Send to Workspace — visible when at least one other workspace exists */}
      {hasTransferTargets && onSendToWorkspace && (
        <MenuItem onClick={onSendToWorkspace}>
          <Send className="h-3.5 w-3.5" />
          <span className="flex-1">{t("sessionMenu.sendToWorkspace")}</span>
        </MenuItem>
      )}

      {/* Connect to Messaging — pairing code flow */}
      <MessagingSessionMenuItem sessionId={sessionId} />

      <Separator />

      {/* Projects submenu - workspace projects + "No project" to clear binding */}
      {projects.length > 0 && onSetProjectId && (
        <Sub>
          <SubTrigger className="pr-2">
            <FolderKanban className="h-3.5 w-3.5" />
            <span className="flex-1">{t("sessionMenu.projects")}</span>
          </SubTrigger>
          <SubContent>
            <MenuItem onClick={() => onSetProjectId(null)}>
              {!item.projectId && <Check className="h-3.5 w-3.5" />}
              <span className={item.projectId ? 'flex-1 ml-[18px]' : 'flex-1'}>
                {t("sessionMenu.noProject")}
              </span>
            </MenuItem>
            <Separator />
            {projects.map((p) => {
              const isBound = item.projectId === p.id
              return (
                <MenuItem key={p.id} onClick={() => onSetProjectId(p.id)}>
                  {isBound && <Check className="h-3.5 w-3.5" />}
                  <span className={isBound ? 'flex-1' : 'flex-1 ml-[18px]'}>{p.name}</span>
                </MenuItem>
              )
            })}
          </SubContent>
        </Sub>
      )}


      {/* Archive/Unarchive */}
      {!isArchived ? (
        <MenuItem onClick={onArchive}>
          <Archive className="h-3.5 w-3.5" />
          <span className="flex-1">{t("sessionMenu.archive")}</span>
        </MenuItem>
      ) : (
        <MenuItem onClick={onUnarchive}>
          <ArchiveRestore className="h-3.5 w-3.5" />
          <span className="flex-1">{t("sessionMenu.unarchive")}</span>
        </MenuItem>
      )}

      {/* Mark as Unread - only show if session has been read */}
      {!_hasUnread && _hasMessages && (
        <MenuItem onClick={onMarkUnread}>
          <MailOpen className="h-3.5 w-3.5" />
          <span className="flex-1">{t("sessionMenu.markAsUnread")}</span>
        </MenuItem>
      )}

      <Separator />

      {/* Rename */}
      <MenuItem onClick={onRename}>
        <Pencil className="h-3.5 w-3.5" />
        <span className="flex-1">{t("common.rename")}</span>
      </MenuItem>

      {/* Regenerate Title - AI-generate based on recent messages */}
      <MenuItem onClick={actions.refreshTitle}>
        <RefreshCw className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sessionMenu.regenerateTitle")}</span>
      </MenuItem>

      <Separator />

      {/* Open in New Panel */}
      <MenuItem onClick={actions.openInNewPanel}>
        <Columns2 className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sessionMenu.openInNewPanel")}</span>
      </MenuItem>

      {/* Open in New Window */}
      <MenuItem onClick={onOpenInNewWindow}>
        <AppWindow className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sessionMenu.openInNewWindow")}</span>
      </MenuItem>

      {/* Show in file manager */}
      <MenuItem onClick={actions.showInFinder}>
        <FolderOpen className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sessionMenu.showInFileManager", { fileManager: getFileManagerName() })}</span>
      </MenuItem>

      {/* Copy Path */}
      <MenuItem onClick={actions.copyPath}>
        <Copy className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sessionMenu.copyPath")}</span>
      </MenuItem>

      <Separator />

      {/* Delete */}
      <MenuItem onClick={onDelete} variant="destructive">
        <Trash2 className="h-3.5 w-3.5" />
        <span className="flex-1">{t("common.delete")}</span>
      </MenuItem>
    </>
  )
}
