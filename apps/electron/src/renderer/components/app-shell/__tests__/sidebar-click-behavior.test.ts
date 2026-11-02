import { describe, expect, it } from 'bun:test'
import { dispatchSidebarClick, dispatchSidebarDoubleClick } from '../sidebar-click-behavior'

function createFakeTimers() {
  let nextId = 0
  const callbacks = new Map<number, () => void>()
  return {
    timers: {
      setTimeout(callback: () => void, _delay: number) {
        const id = ++nextId
        callbacks.set(id, callback)
        return id
      },
      clearTimeout(id: number) {
        callbacks.delete(id)
      },
    },
    runPending() {
      const pending = [...callbacks.values()]
      callbacks.clear()
      for (const callback of pending) callback()
    },
    get pendingCount() {
      return callbacks.size
    },
  }
}

describe('expandable sidebar click behavior', () => {
  it('preserves immediate single-click navigation for regular links', () => {
    const timers = createFakeTimers()
    const clickTimer = { current: null as number | null }
    let navigations = 0

    dispatchSidebarClick({ expandable: false, onClick: () => navigations++ }, clickTimer, { detail: 1 }, timers.timers)

    expect(navigations).toBe(1)
    expect(timers.pendingCount).toBe(0)
  })

  it('toggles on a single click without navigating', () => {
    const timers = createFakeTimers()
    const clickTimer = { current: null as number | null }
    let toggles = 0
    let navigations = 0
    const link = {
      expandable: true,
      clickTogglesExpand: true,
      onClick: () => navigations++,
      onToggle: () => toggles++,
    }

    dispatchSidebarClick(link, clickTimer, { detail: 1 }, timers.timers)
    expect(toggles).toBe(0)
    expect(navigations).toBe(0)
    expect(timers.pendingCount).toBe(1)

    timers.runPending()
    expect(toggles).toBe(1)
    expect(navigations).toBe(0)
    expect(clickTimer.current).toBeNull()
  })

  it('cancels the pending toggle and enters on a double click', () => {
    const timers = createFakeTimers()
    const clickTimer = { current: null as number | null }
    let toggles = 0
    let navigations = 0
    let doubleClickActions = 0
    let defaultPrevented = false
    const link = {
      expandable: true,
      clickTogglesExpand: true,
      onClick: () => navigations++,
      onToggle: () => toggles++,
      onDoubleClick: () => doubleClickActions++,
    }

    dispatchSidebarClick(link, clickTimer, { detail: 1 }, timers.timers)
    dispatchSidebarClick(link, clickTimer, { detail: 2 }, timers.timers)
    dispatchSidebarDoubleClick(link, clickTimer, {
      preventDefault: () => { defaultPrevented = true },
    }, timers.timers)
    timers.runPending()

    expect(defaultPrevented).toBe(true)
    expect(toggles).toBe(0)
    expect(navigations).toBe(1)
    expect(doubleClickActions).toBe(1)
    expect(timers.pendingCount).toBe(0)
    expect(clickTimer.current).toBeNull()
  })
})
