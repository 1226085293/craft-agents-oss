/**
 * Jotai storage backend for appearance atoms.
 *
 * Replaces the old localStorage (`atomWithStorage`) persistence of the kanban /
 * avatar / chip atoms with the unified appearance configuration file
 * (appearance.json). The backend reads from the in-memory bridge cache
 * (synchronously, for first render), persists through `updateAppearance`, and
 * subscribes to cross-window `appearance:changed` events so other windows
 * follow along.
 */
import type { AppearanceConfig } from '@craft-agent/shared/config'
import { getAppearanceCache, subscribeAppearance, updateAppearance } from '@/lib/appearance-bridge'

/** Shape-compatible with jotai's SyncStorage, typed locally to avoid deep imports. */
interface AppearanceAtomStorage<Value> {
  getItem: (key: string, initialValue: Value) => Value
  setItem: (key: string, newValue: Value) => void
  removeItem: (key: string) => void
  subscribe?: (key: string, callback: (value: Value) => void, initialValue: Value) => (() => void) | undefined
}

type Editor = (config: AppearanceConfig, value: unknown) => AppearanceConfig

const editors: Record<string, Editor> = {
  'craft-kanban-column-colors': (c, v) => ({ ...c, board: { ...c.board, columnColors: v as Record<string, string> } }),
  'craft-kanban-live-pulse': (c, v) => ({ ...c, board: { ...c.board, livePulse: v as boolean } }),
  'craft-kanban-column-status': (c, v) => ({ ...c, board: { ...c.board, columnStatus: v as Record<string, string> } }),
  'craft-show-background-finished-chip': (c, v) => ({ ...c, ui: { ...c.ui, backgroundFinishedChip: v as boolean } }),
  'craft-workspace-avatar-colors': (c, v) => ({ ...c, ui: { ...c.ui, workspaceAvatarColors: v as Record<string, string> } }),
}

const removers: Record<string, (config: AppearanceConfig) => AppearanceConfig> = {
  'craft-kanban-column-colors': (c) => {
    const board = { ...c.board }
    delete board.columnColors
    return { ...c, board }
  },
  'craft-kanban-live-pulse': (c) => {
    const board = { ...c.board }
    delete board.livePulse
    return { ...c, board }
  },
  'craft-kanban-column-status': (c) => {
    const board = { ...c.board }
    delete board.columnStatus
    return { ...c, board }
  },
  'craft-show-background-finished-chip': (c) => {
    const ui = { ...c.ui }
    delete ui.backgroundFinishedChip
    return { ...c, ui }
  },
  'craft-workspace-avatar-colors': (c) => {
    const ui = { ...c.ui }
    delete ui.workspaceAvatarColors
    return { ...c, ui }
  },
}

function extract(config: AppearanceConfig | null, key: string): unknown {
  if (!config) return undefined
  switch (key) {
    case 'craft-kanban-column-colors': return config.board?.columnColors
    case 'craft-kanban-live-pulse': return config.board?.livePulse
    case 'craft-kanban-column-status': return config.board?.columnStatus
    case 'craft-show-background-finished-chip': return config.ui?.backgroundFinishedChip
    case 'craft-workspace-avatar-colors': return config.ui?.workspaceAvatarColors
    default: return undefined
  }
}

export function createAppearanceAtomStorage<Value>(): AppearanceAtomStorage<Value> {
  return {
    getItem: (key, initialValue) =>
      (extract(getAppearanceCache(), key) as Value | undefined) ?? initialValue,
    setItem: (key, newValue) => {
      const editor = editors[key]
      if (editor) void updateAppearance((config) => editor(config, newValue))
    },
    removeItem: (key) => {
      const remover = removers[key]
      if (remover) void updateAppearance((config) => remover(config))
    },
    subscribe: (key, callback) =>
      subscribeAppearance(() => {
        const value = extract(getAppearanceCache(), key)
        if (value !== undefined && value !== null) callback(value as Value)
      }),
  }
}