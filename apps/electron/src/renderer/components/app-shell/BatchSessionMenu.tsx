/**
 * BatchSessionMenu - Context menu content for batch operations on multi-selected sessions.
 *
 * Self-contained component that uses hooks to access selection state, session metadata,
 * and mutation callbacks. Renders polymorphic menu items via useMenuComponents() so it
 * works in both DropdownMenu and ContextMenu scenarios.
 *
 * Mirrors the actions from MultiSelectPanel (Archive) with additions
 * for Flag and Delete that make sense in a context menu.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useCallback, useMemo } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Archive, Flag, FlagOff, Trash2, Send } from 'lucide-react'
import { toast } from 'sonner'
import { useMenuComponents } from '@/components/ui/menu-context'
import { useSelectedIds } from '@/hooks/useSession'
import { useSessionSelection } from '@/hooks/useSession'
import { sessionMetaMapAtom, sendToWorkspaceAtom, type SessionMeta } from '@/atoms/sessions'
import { useAppShellContext } from '@/context/AppShellContext'
import { hasTransferTargets } from './transfer-targets'

export interface BatchSessionMenuProps {
  /** Callback to open Send to Workspace dialog for the selected sessions */
  onSendToWorkspace?: () => void
}

export function BatchSessionMenu({ onSendToWorkspace }: BatchSessionMenuProps = {}) {
  const { t } = useTranslation()
  const { MenuItem, Separator, Sub, SubTrigger, SubContent } = useMenuComponents()

  const selectedIds = useSelectedIds()
  const setSendToWorkspace = useSetAtom(sendToWorkspaceAtom)
  const { clearMultiSelect } = useSessionSelection()
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)

  const {
    onArchiveSession,
    onUnarchiveSession,
    onDeleteSession,
    workspaces,
  } = useAppShellContext()

  const canSendToWorkspace = hasTransferTargets(workspaces)

  // Hydrate selected session metadata
  const selectedMetas = useMemo(() => {
    const metas: SessionMeta[] = []
    selectedIds.forEach((id) => {
      const meta = sessionMetaMap.get(id)
      if (meta) metas.push(meta)
    })
    return metas
  }, [selectedIds, sessionMetaMap])

  // Batch status/flag changes are gone: folders own grouping now.

  // Batch archive
  const handleBatchArchive = useCallback(() => {
    selectedIds.forEach(id => onArchiveSession(id))
    clearMultiSelect()
    toast(`${selectedIds.size} ${selectedIds.size === 1 ? 'session' : 'sessions'} archived`)
  }, [selectedIds, onArchiveSession, clearMultiSelect])

  // Batch send to workspace
  const handleSendToWorkspace = useCallback(() => {
    if (onSendToWorkspace) {
      onSendToWorkspace()
    } else {
      setSendToWorkspace([...selectedIds])
    }
  }, [onSendToWorkspace, selectedIds, setSendToWorkspace])

  // Batch delete
  const handleBatchDelete = useCallback(async () => {
    const count = selectedIds.size
    const ids = [...selectedIds]
    // Delete one-by-one (first shows confirmation, rest skip if first is confirmed)
    const firstDeleted = await onDeleteSession(ids[0])
    if (!firstDeleted) return // User cancelled
    for (let i = 1; i < ids.length; i++) {
      await onDeleteSession(ids[i], true) // skip confirmation for remaining
    }
    clearMultiSelect()
    toast(`${count} ${count === 1 ? 'session' : 'sessions'} deleted`)
  }, [selectedIds, onDeleteSession, clearMultiSelect])

  const count = selectedIds.size

  return (
    <>
      {/* Header showing selection count */}
      <div className="px-2 py-1.5 text-xs text-muted-foreground font-medium">
        {t('multiSelect.selected.session', { count })}
      </div>
      <Separator />

      {/* Archive */}
      <MenuItem onClick={handleBatchArchive}>
        <Archive className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sessionMenu.archive")}</span>
      </MenuItem>

      {/* Send to Workspace */}
      {canSendToWorkspace && (
        <MenuItem onClick={handleSendToWorkspace}>
          <Send className="h-3.5 w-3.5" />
          <span className="flex-1">{t("sessionMenu.sendToWorkspace")}</span>
        </MenuItem>
      )}

      <Separator />

      {/* Delete */}
      <MenuItem onClick={handleBatchDelete} variant="destructive">
        <Trash2 className="h-3.5 w-3.5" />
        <span className="flex-1">{t("common.delete")}</span>
      </MenuItem>
    </>
  )
}
