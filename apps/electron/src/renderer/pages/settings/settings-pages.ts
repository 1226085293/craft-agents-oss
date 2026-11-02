/**
 * Settings Page Components Registry
 *
 * Maps settings subpage IDs to their React components.
 * TypeScript enforces that all pages defined in settings-registry have a component here.
 *
 * To add a new settings page:
 * 1. Add to SETTINGS_PAGES in shared/settings-registry.ts
 * 2. Create the page component (e.g., NewSettingsPage.tsx)
 * 3. Add to SETTINGS_PAGE_COMPONENTS below
 * 4. Add icon to SETTINGS_ICONS in components/icons/SettingsIcons.tsx
 */

import type { ComponentType } from 'react'
import type { SettingsSubpage } from '../../../shared/settings-registry'

import AppSettingsPage from './AppSettingsPage'
import LlmSettingsPage from './LlmSettingsPage'
import AppearanceSettingsPage from './AppearanceSettingsPage'
import InputSettingsPage from './InputSettingsPage'
import WorkspaceSettingsPage from './WorkspaceSettingsPage'
import PermissionsSettingsPage from './PermissionsSettingsPage'
import MessagingSettingsPage from './MessagingSettingsPage'
import ServerSettingsPage from './ServerSettingsPage'
import ShortcutsPage from './ShortcutsPage'

/**
 * Map of settings subpage IDs to their page components.
 * TypeScript will error if a page from SETTINGS_PAGES is missing here.
 */
export const SETTINGS_PAGE_COMPONENTS: Record<SettingsSubpage, ComponentType> = {
  app: AppSettingsPage,
  llm: LlmSettingsPage,
  appearance: AppearanceSettingsPage,
  input: InputSettingsPage,
  workspace: WorkspaceSettingsPage,
  permissions: PermissionsSettingsPage,
  messaging: MessagingSettingsPage,
  server: ServerSettingsPage,
  shortcuts: ShortcutsPage,
}

/**
 * Get the component for a settings subpage
 */
export function getSettingsPageComponent(subpage: SettingsSubpage): ComponentType {
  return SETTINGS_PAGE_COMPONENTS[subpage]
}
