export interface SidebarClickLink {
  expandable?: boolean
  clickTogglesExpand?: boolean
  onClick?: () => void
  onToggle?: () => void
  onDoubleClick?: () => void
}

export interface SidebarClickTimer<T> {
  current: T | null
}

export interface SidebarClickTimers<T> {
  setTimeout(callback: () => void, delay: number): T
  clearTimeout(timer: T): void
}

export interface SidebarDoubleClickEvent {
  preventDefault(): void
}

export const SIDEBAR_CLICK_DELAY_MS = 180

export function dispatchSidebarClick<T>(
  link: SidebarClickLink,
  timer: SidebarClickTimer<T>,
  event: { detail: number },
  timers: SidebarClickTimers<T>,
): void {
  if (link.clickTogglesExpand && link.expandable) {
    // A second click belongs to the pending double-click action.
    if (event.detail > 1) {
      if (timer.current !== null) {
        timers.clearTimeout(timer.current)
        timer.current = null
      }
      return
    }
    if (timer.current !== null) return
    timer.current = timers.setTimeout(() => {
      timer.current = null
      link.onToggle?.()
    }, SIDEBAR_CLICK_DELAY_MS)
    return
  }
  link.onClick?.()
}

export function dispatchSidebarDoubleClick<T>(
  link: SidebarClickLink,
  timer: SidebarClickTimer<T>,
  event: SidebarDoubleClickEvent,
  timers: SidebarClickTimers<T>,
): void {
  if (link.clickTogglesExpand) {
    event.preventDefault()
    if (timer.current !== null) {
      timers.clearTimeout(timer.current)
      timer.current = null
    }
    link.onClick?.()
  }
  link.onDoubleClick?.()
}
