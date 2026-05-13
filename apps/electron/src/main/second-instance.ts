interface ActivatableWindow {
  isMinimized(): boolean
  restore(): void
  isVisible(): boolean
  show(): void
  focus(): void
}

interface ManagedWindowLike {
  window: ActivatableWindow
}

interface WindowManagerLike {
  getAllWindows(): ManagedWindowLike[]
  createWindow(options: { workspaceId: string }): unknown
}

interface WorkspaceLike {
  id: string
}

export function focusOrCreateWindowForSecondInstance({
  windowManager,
  getWorkspaces,
}: {
  windowManager: WindowManagerLike
  getWorkspaces: () => WorkspaceLike[]
}): void {
  const windows = windowManager.getAllWindows()
  if (windows.length > 0) {
    const win = windows[0].window
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.focus()
    return
  }

  const workspace = getWorkspaces()[0]
  if (workspace) {
    windowManager.createWindow({ workspaceId: workspace.id })
  }
}
