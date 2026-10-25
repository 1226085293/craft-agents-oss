/**
 * Standalone Page windows (real OS windows) synced from the main process.
 *
 * The main window renders one chip per open page window in the top-right
 * shelf; `PageWindowInfo` is pushed via `page-window:state-changed` and
 * `page-window:removed` (same contract as browser panes).
 */

import { atom } from 'jotai'
import type { PageWindowInfo } from '../../shared/types'

export const pageWindowsMapAtom = atom<Map<string, PageWindowInfo>>(new Map())

export const pageWindowsAtom = atom<PageWindowInfo[]>((get) =>
  Array.from(get(pageWindowsMapAtom).values()),
)

export const setPageWindowsAtom = atom(null, (_get, set, items: PageWindowInfo[]) => {
  set(pageWindowsMapAtom, new Map(items.map(item => [item.id, item])))
})

export const updatePageWindowAtom = atom(null, (get, set, info: PageWindowInfo) => {
  const map = new Map(get(pageWindowsMapAtom))
  map.set(info.id, info)
  set(pageWindowsMapAtom, map)
})

export const removePageWindowAtom = atom(null, (get, set, id: string) => {
  const map = new Map(get(pageWindowsMapAtom))
  if (!map.delete(id)) return
  set(pageWindowsMapAtom, map)
})
