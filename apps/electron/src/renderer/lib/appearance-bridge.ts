/**
 * Appearance bridge (renderer side)
 *
 * Single read/write path to the unified appearance configuration
 * (~/.craft-agent/appearance.json) for all renderer consumers:
 * ThemeContext (mode/colorTheme/font), kanban atoms, workspace-avatar
 * colors, background-finished chip, project color treatment, diff viewer
 * and tool icon mappings.
 *
 * - Writes go through `updateAppearance()` (mutate cache → write file → notify).
 * - Cross-window changes arrive via the `appearance:changed` server event and
 *   refresh the cache + notify subscribers (the watcher in the server pushes
 *   the event when it sees the file change).
 * - Legacy localStorage appearance keys are migrated once into the file.
 */
import type { AppearanceConfig, AppearanceThemeSettings, AppearanceUiSettings, AppearanceBoardSettings } from '@craft-agent/shared/config'
import { KEYS as STORAGE_KEYS } from '@/lib/local-storage'

// Legacy localStorage keys migrated into appearance.json (read via the raw
// browser storage API — these keys predate the typed local-storage wrapper).
const LEGACY_KEYS = {
  theme: 'theme',
  kanbanColumnColors: 'craft-kanban-column-colors',
  kanbanLivePulse: 'craft-kanban-live-pulse',
  kanbanColumnStatus: 'craft-kanban-column-status',
  workspaceAvatarColors: 'craft-workspace-avatar-colors',
  backgroundFinishedChip: 'craft-show-background-finished-chip',
  projectColorTreatment: 'project-color-treatment',
} as const

const MIGRATION_FLAG = 'craft-appearance-migrated-v1'

function rawGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function rawRemove(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

function rawSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // ignore
  }
}

function rawGetJson<T>(key: string): T | null {
  const raw = rawGet(key)
  if (raw === null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

let cache: AppearanceConfig | null = null
let initPromise: Promise<void> | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

export function subscribeAppearance(callback: () => void): () => void {
  listeners.add(callback)
  return () => listeners.delete(callback)
}

/** Synchronous snapshot of the last known appearance config (null until init). */
export function getAppearanceCache(): AppearanceConfig | null {
  return cache
}

async function readFromDisk(): Promise<AppearanceConfig> {
  try {
    const { content } = await window.electronAPI.readAppearance()
    return JSON.parse(content || '{}') as AppearanceConfig
  } catch {
    return {}
  }
}

async function writeToDisk(): Promise<void> {
  await window.electronAPI.writeAppearance(JSON.stringify(cache ?? {}, null, 2))
}

/**
 * Initialize the bridge: load the file, migrate legacy localStorage keys once,
 * and subscribe to cross-window `appearance:changed` events. Idempotent.
 */
export function initAppearance(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      cache = await readFromDisk()
      const migrated = migrateLegacyLocalStorage(cache)
      if (migrated.dirty) {
        cache = migrated.config
        await writeToDisk()
      }
      window.electronAPI.onAppearanceChange?.(async () => {
        cache = await readFromDisk()
        notify()
      })
      notify()
    })()
  }
  return initPromise
}

/**
 * Mutate the appearance config and persist. In-memory cache + local
 * subscribers update immediately; other windows catch up via the file
 * watcher → `appearance:changed` event.
 */
export async function updateAppearance(mutator: (config: AppearanceConfig) => AppearanceConfig): Promise<void> {
  await initAppearance()
  cache = mutator(cache ?? {})
  await writeToDisk()
  notify()
}

// ---------------------------------------------------------------------------
// Legacy localStorage migration (one-time)
// ---------------------------------------------------------------------------

function migrateLegacyLocalStorage(config: AppearanceConfig): { config: AppearanceConfig; dirty: boolean } {
  if (rawGet(MIGRATION_FLAG) !== null) {
    return { config, dirty: false }
  }

  const next = structuredClone(config)
  let dirty = false

  // Theme mode/colorTheme/font (ThemeContext StoredTheme)
  const storedTheme = rawGetJson<{ mode?: string; colorTheme?: string; font?: string; isUserOverride?: boolean }>(LEGACY_KEYS.theme)
  if (storedTheme) {
    const theme: AppearanceThemeSettings = { ...next.theme }
    if (storedTheme.mode && !theme.mode) theme.mode = storedTheme.mode as AppearanceThemeSettings['mode']
    if (storedTheme.colorTheme && storedTheme.isUserOverride && !theme.colorTheme) theme.colorTheme = storedTheme.colorTheme
    if (storedTheme.font && !theme.font) theme.font = storedTheme.font
    if (Object.keys(theme).length > 0) next.theme = theme
    rawRemove(LEGACY_KEYS.theme)
    dirty = true
  }

  const ui: AppearanceUiSettings = { ...next.ui }
  const board: AppearanceBoardSettings = { ...next.board }

  // Kanban appearance
  const columnColors = rawGetJson<Record<string, string>>(LEGACY_KEYS.kanbanColumnColors)
  if (columnColors && typeof columnColors === 'object') {
    board.columnColors = { ...board.columnColors, ...columnColors }
    rawRemove(LEGACY_KEYS.kanbanColumnColors)
    dirty = true
  }
  const livePulse = rawGetJson<boolean | null>(LEGACY_KEYS.kanbanLivePulse)
  if (livePulse !== null && livePulse !== undefined) {
    board.livePulse = livePulse
    rawRemove(LEGACY_KEYS.kanbanLivePulse)
    dirty = true
  }
  const columnStatus = rawGetJson<Record<string, string>>(LEGACY_KEYS.kanbanColumnStatus)
  if (columnStatus && typeof columnStatus === 'object') {
    board.columnStatus = { ...board.columnStatus, ...columnStatus }
    rawRemove(LEGACY_KEYS.kanbanColumnStatus)
    dirty = true
  }

  // Workspace avatar colors
  const avatarColors = rawGetJson<Record<string, string>>(LEGACY_KEYS.workspaceAvatarColors)
  if (avatarColors && typeof avatarColors === 'object') {
    ui.workspaceAvatarColors = { ...ui.workspaceAvatarColors, ...avatarColors }
    rawRemove(LEGACY_KEYS.workspaceAvatarColors)
    dirty = true
  }

  // Background-finished chip
  const backgroundFinishedChip = rawGetJson<boolean | null>(LEGACY_KEYS.backgroundFinishedChip)
  if (backgroundFinishedChip !== null && backgroundFinishedChip !== undefined) {
    ui.backgroundFinishedChip = backgroundFinishedChip
    rawRemove(LEGACY_KEYS.backgroundFinishedChip)
    dirty = true
  }

  // Project color treatment (session list)
  const projectColorTreatment = rawGet(LEGACY_KEYS.projectColorTreatment)
  if (projectColorTreatment) {
    ui.projectColorTreatment = projectColorTreatment
    rawRemove(LEGACY_KEYS.projectColorTreatment)
    dirty = true
  }

  if (Object.keys(ui).length > 0) next.ui = ui
  if (Object.keys(board).length > 0) next.board = board

  rawSet(MIGRATION_FLAG, JSON.stringify({ version: 1 }))
  return { config: next, dirty }
}