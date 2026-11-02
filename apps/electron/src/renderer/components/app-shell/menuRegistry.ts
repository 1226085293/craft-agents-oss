/**
 * Exclusive menu registry
 *
 * Every context menu in the app registers here, so opening one closes whatever
 * was open before. Without it the sidebar's nav menu, the folder tree's menu and
 * the folder list's menu can all be on screen at once (they are separate React
 * trees with their own open state).
 *
 * Radix menus drive this through `open`/`onOpenChange`; hand-rolled portals call
 * `claimMenu` when they open and `releaseMenu` when they close.
 */

type Listener = (activeId: string | null) => void

let activeMenuId: string | null = null
const listeners = new Set<Listener>()

function emit(): void {
  for (const listener of listeners) listener(activeMenuId)
}

/** Marks `id` as the one open menu, closing every other registered menu. */
export function claimMenu(id: string): void {
  if (activeMenuId === id) return
  activeMenuId = id
  emit()
}

/** Clears the claim, but only if `id` still owns it. */
export function releaseMenu(id: string): void {
  if (activeMenuId !== id) return
  activeMenuId = null
  emit()
}

export function getActiveMenuId(): string | null {
  return activeMenuId
}

export function subscribeMenu(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
