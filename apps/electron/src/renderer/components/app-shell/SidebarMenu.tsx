/**
 * SidebarMenu - Shared menu content for sidebar navigation items
 *
 * Used by:
 * - LeftSidebar (context menu via right-click on nav items)
 * - AppShell (context menu for New Chat button)
 *
 * Uses MenuComponents context to render with either DropdownMenu or ContextMenu
 * primitives, allowing the same component to work in both scenarios.
 *
 * Provides actions based on the sidebar item type:
 * - "Add Source" (for sources) - triggers EditPopover callback
 * - "Add Skill" (for skills) - triggers EditPopover callback
 * - "New Folder" / "Mark All Read" (for allSessions)
 * - "Add Project" (for projects); project entries get details/rename/delete
 * - "Open in New Window" (for newSession only) - uses deep link
 */

import * as React from 'react'
import { useTranslation } from "react-i18next"
import {
  AppWindow,
  CheckCheck,
  Info,
  Pencil,
  Plus,
  ExternalLink,
  FolderPlus,
  Trash2,
} from 'lucide-react'
import { useMenuComponents } from '@/components/ui/menu-context'
import { getDocUrl, type DocFeature } from '@craft-agent/shared/docs/doc-links'

export type SidebarMenuType = 'allSessions' | 'sources' | 'skills' | 'projects' | 'project' | 'newSession'

export interface SidebarMenuProps {
  /** Type of sidebar item (determines available menu items) */
  type: SidebarMenuType
  /** Handler for "Mark All Read" action - only for allSessions type */
  onMarkAllRead?: () => void
  /** Handler for "New Folder" action - only for allSessions type (the folder tree lives there) */
  onNewFolder?: () => void
  /** Handler for "Add Source" action - only for sources type */
  onAddSource?: () => void
  /** Handler for "Add Skill" action - only for skills type */
  onAddSkill?: () => void
  /** Handler for "Add Project" action - only for projects type */
  onAddProject?: () => void
  /** Handler for "View Project Details" action - only for project type */
  onViewDetails?: () => void
  /** Handler for "Rename" action - only for project type */
  onRename?: () => void
  /** Handler for "Delete" action - only for project type */
  onDelete?: () => void
  /** Source type filter for "Learn More" link - determines which docs page to open */
  sourceType?: 'api' | 'mcp' | 'local'
}

/**
 * SidebarMenu - Renders the menu items for sidebar navigation actions
 * This is the content only, not wrapped in a DropdownMenu or ContextMenu
 */
export function SidebarMenu({
  type,
  onMarkAllRead,
  onNewFolder,
  onAddSource,
  onAddSkill,
  onAddProject,
  onViewDetails,
  onRename,
  onDelete,
  sourceType,
}: SidebarMenuProps) {
  const { t } = useTranslation()

  // Get menu components from context (works with both DropdownMenu and ContextMenu)
  const { MenuItem, Separator } = useMenuComponents()

  // New Session: only shows "Open in New Window"
  if (type === 'newSession') {
    return (
      <MenuItem onClick={() => window.electronAPI.openUrl('craftagents://action/new-session?window=focused')}>
        <AppWindow className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sidebarMenu.openInNewWindow")}</span>
      </MenuItem>
    )
  }

  // All Sessions: "New Folder" (the folder tree lives under this item) + "Mark All Read"
  if (type === 'allSessions') {
    return (
      <>
        {onNewFolder && (
          <MenuItem onClick={onNewFolder}>
            <FolderPlus className="h-3.5 w-3.5" />
            <span className="flex-1">{t("folders.new")}</span>
          </MenuItem>
        )}
        {onMarkAllRead && (
          <MenuItem onClick={onMarkAllRead}>
            <CheckCheck className="h-3.5 w-3.5" />
            <span className="flex-1">{t("sidebarMenu.markAllRead")}</span>
          </MenuItem>
        )}
      </>
    )
  }

  // Sources: show "Add Source" and "Learn More"
  if (type === 'sources') {
    // Determine which docs page to open based on source type filter
    const docFeature: DocFeature = sourceType
      ? `sources-${sourceType}` as DocFeature
      : 'sources'

    // Display label varies by source type
    const learnMoreLabel = sourceType === 'api'
      ? t('sidebarMenu.learnMoreApis')
      : sourceType === 'mcp'
        ? t('sidebarMenu.learnMoreMcp')
        : sourceType === 'local'
          ? t('sidebarMenu.learnMoreLocalFolders')
          : t('sidebarMenu.learnMoreSources')

    return (
      <>
        {onAddSource && (
          <MenuItem onClick={onAddSource}>
            <Plus className="h-3.5 w-3.5" />
            <span className="flex-1">{t("sidebarMenu.addSource")}</span>
          </MenuItem>
        )}
        <Separator />
        <MenuItem onClick={() => window.electronAPI.openUrl(getDocUrl(docFeature))}>
          <ExternalLink className="h-3.5 w-3.5" />
          <span className="flex-1">{learnMoreLabel}</span>
        </MenuItem>
      </>
    )
  }

  // Skills: show "Add Skill"
  if (type === 'skills' && onAddSkill) {
    return (
      <MenuItem onClick={onAddSkill}>
        <Plus className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sidebarMenu.addSkill")}</span>
      </MenuItem>
    )
  }

  // Projects: show "Add Project"
  if (type === 'projects') {
    return (
      <>
        {onAddProject && (
          <MenuItem onClick={onAddProject}>
            <Plus className="h-3.5 w-3.5" />
            <span className="flex-1">{t("sidebarMenu.addProject")}</span>
          </MenuItem>
        )}
      </>
    )
  }

  // One project entry: details / rename / delete — shaped like the session menu.
  if (type === 'project') {
    return (
      <>
        {onViewDetails && (
          <MenuItem onClick={onViewDetails}>
            <Info className="h-3.5 w-3.5" />
            <span className="flex-1">{t("sidebarMenu.viewProjectDetails")}</span>
          </MenuItem>
        )}
        {onRename && (
          <MenuItem onClick={onRename}>
            <Pencil className="h-3.5 w-3.5" />
            <span className="flex-1">{t("common.rename")}</span>
          </MenuItem>
        )}
        {onViewDetails && (onRename || onDelete) && <Separator />}
        {onDelete && (
          <MenuItem onClick={onDelete} variant="destructive">
            <Trash2 className="h-3.5 w-3.5" />
            <span className="flex-1">{t("common.delete")}</span>
          </MenuItem>
        )}
      </>
    )
  }

  // Fallback: return null if no handler provided (shouldn't happen)
  return null
}
