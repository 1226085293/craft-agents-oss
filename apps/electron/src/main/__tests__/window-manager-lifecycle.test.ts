import { beforeEach, describe, expect, it, mock } from 'bun:test'

let nextWebContentsId = 1
const createdWindows: any[] = []
const appQuit = mock(() => {})

function createMockWebContents() {
  const listeners: Record<string, Function[]> = {}
  const id = nextWebContentsId++
  return {
    id,
    mainFrame: {},
    isDestroyed: mock(() => false),
    send: mock(() => {}),
    getURL: mock(() => 'file:///mock/index.html?workspaceId=ws-1'),
    setWindowOpenHandler: mock(() => {}),
    on: (event: string, cb: Function) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(cb)
    },
    _emit: (event: string, ...args: any[]) => {
      for (const cb of listeners[event] || []) cb(...args)
    },
  }
}

function createMockWindow() {
  const listeners: Record<string, Function[]> = {}
  const webContents = createMockWebContents()
  let destroyed = false
  let visible = false

  const win = {
    webContents,
    once: (event: string, cb: Function) => {
      const wrapped = (...args: any[]) => {
        listeners[event] = (listeners[event] || []).filter(fn => fn !== wrapped)
        cb(...args)
      }
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(wrapped)
    },
    on: (event: string, cb: Function) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(cb)
    },
    _emit: (event: string, ...args: any[]) => {
      for (const cb of listeners[event] || []) cb(...args)
    },
    isDestroyed: mock(() => destroyed),
    isMinimized: mock(() => false),
    isVisible: mock(() => visible),
    restore: mock(() => {}),
    show: mock(() => { visible = true }),
    focus: mock(() => {}),
    loadFile: mock(() => Promise.resolve()),
    loadURL: mock(() => Promise.resolve()),
    getBounds: mock(() => ({ x: 0, y: 0, width: 1400, height: 900 })),
    close: mock(() => {
      const event = {
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true
        },
      }
      win._emit('close', event)
      if (!event.defaultPrevented) win.destroy()
    }),
    destroy: mock(() => {
      if (destroyed) return
      destroyed = true
      win._emit('closed')
    }),
  }

  createdWindows.push(win)
  return win
}

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    quit: appQuit,
  },
  BrowserWindow: class MockBrowserWindow {
    webContents: any
    constructor() {
      const win = createMockWindow()
      this.webContents = win.webContents
      Object.assign(this, win)
    }
    static getFocusedWindow() {
      return null
    }
  },
  Menu: {
    buildFromTemplate: mock(() => ({ popup: mock(() => {}) })),
  },
  nativeTheme: {
    shouldUseDarkColors: false,
    on: mock(() => {}),
    removeListener: mock(() => {}),
  },
  shell: {
    openExternal: mock(() => Promise.resolve()),
  },
}))

mock.module('../logger', () => {
  const stubLog = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
  return {
    windowLog: stubLog,
  }
})

const { WindowManager } = await import('../window-manager')

describe('WindowManager lifecycle', () => {
  beforeEach(() => {
    createdWindows.length = 0
    nextWebContentsId = 1
    appQuit.mockClear()
  })

  it('quits on Windows when the last managed window closes even if hidden auxiliary BrowserWindows still exist', () => {
    const manager = new WindowManager()
    const mainWindow = manager.createWindow({ workspaceId: 'ws-1' })

    mainWindow.destroy()

    expect(manager.hasWindows()).toBe(false)
    expect(appQuit).toHaveBeenCalledTimes(1)
  })
})
