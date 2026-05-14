/**
 * Router tests — focused on attachment forwarding.
 *
 * Covers:
 *   - text-only messages forward to sessionManager.sendMessage unchanged
 *     (regression guard for the Phase-3 rewrite).
 *   - attachments with `localPath` are materialized to FileAttachment[]
 *     and forwarded.
 *   - attachments missing `localPath` are silently dropped.
 *   - caption-less attachments still produce a send with empty text.
 *   - unbound channels fall through to Commands.handle.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Router } from '../router'
import { BindingStore } from '../binding-store'
import type { Commands } from '../commands'
import type { IncomingMessage, PlatformAdapter } from '../types'

// Minimal 1×1 red PNG — small, valid, triggers image-type detection.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

let storeDir: string
let fileDir: string

beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), 'router-store-'))
  fileDir = mkdtempSync(join(tmpdir(), 'router-files-'))
})

afterEach(() => {
  rmSync(storeDir, { recursive: true, force: true })
  rmSync(fileDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeTinyPng(): string {
  const path = join(fileDir, 'tiny.png')
  writeFileSync(path, Buffer.from(TINY_PNG_B64, 'base64'))
  return path
}

function writeTinyMp4(): string {
  const path = join(fileDir, 'tiny.mp4')
  writeFileSync(path, Buffer.from([
    0x00, 0x00, 0x00, 0x18,
    0x66, 0x74, 0x79, 0x70,
    0x6d, 0x70, 0x34, 0x32,
    0x00, 0x00, 0x00, 0x00,
  ]))
  return path
}

function baseMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    platform: 'telegram',
    channelId: 'chat-1',
    messageId: '1',
    senderId: 'user-1',
    text: 'hello',
    timestamp: Date.now(),
    raw: {},
    ...overrides,
  }
}

function makeFakeAdapter(platform: 'telegram' | 'whatsapp' = 'telegram'): PlatformAdapter {
  // Only sendText is exercised by Router (for error/busy branches); rest are unused.
  const noop = async () => {
    throw new Error('unused')
  }
  return {
    platform,
    capabilities: {
      messageEditing: true,
      inlineButtons: true,
      maxButtons: 10,
      maxMessageLength: 4096,
      markdown: 'v2',
      webhookSupport: false,
    },
    initialize: noop,
    destroy: noop,
    isConnected: () => true,
    onMessage: () => {},
    onButtonPress: () => {},
    sendText: mock(async () => ({ platform, channelId: 'chat-1', messageId: 'm' })),
    editMessage: noop,
    sendButtons: noop,
    sendTyping: async () => {},
    sendFile: noop,
  } as unknown as PlatformAdapter
}

function makeFakeSessionManager(overrides: Record<string, unknown> = {}): {
  sendMessage: ReturnType<typeof mock>
  isSessionProcessing: ReturnType<typeof mock>
  decideBusyMessage?: ReturnType<typeof mock>
} {
  return {
    sendMessage: mock(async () => {}),
    isSessionProcessing: mock(() => false),
    ...overrides,
  }
}

function makeFakeCommands(): { handle: ReturnType<typeof mock> } {
  return { handle: mock(async () => {}) }
}

function makeRouter() {
  const store = new BindingStore(storeDir)
  store.bind('ws1', 'sess-A', 'telegram', 'chat-1')
  const sessionManager = makeFakeSessionManager()
  const commands = makeFakeCommands()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const router = new Router(sessionManager as any, store, commands as unknown as Commands)
  return { router, store, sessionManager, commands }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Router', () => {
  it('forwards a text-only bound message to sendMessage', async () => {
    const { router, sessionManager } = makeRouter()
    await router.route(makeFakeAdapter(), baseMsg({ text: 'hi there' }))
    expect(sessionManager.sendMessage).toHaveBeenCalledTimes(1)
    const args = sessionManager.sendMessage.mock.calls[0]!
    expect(args[0]).toBe('sess-A') // sessionId
    expect(args[1]).toBe('hi there') // message
    expect(args[2]).toBeUndefined() // fileAttachments
  })

  it('materializes a localPath attachment into FileAttachment[]', async () => {
    const { router, sessionManager } = makeRouter()
    const pngPath = writeTinyPng()
    await router.route(
      makeFakeAdapter(),
      baseMsg({
        text: 'what is this?',
        attachments: [
          {
            type: 'photo',
            fileId: 'abc',
            fileName: 'my-photo.png',
            mimeType: 'image/png',
            localPath: pngPath,
          },
        ],
      }),
    )
    expect(sessionManager.sendMessage).toHaveBeenCalledTimes(1)
    const args = sessionManager.sendMessage.mock.calls[0]!
    const fileAttachments = args[2] as Array<{
      type: string
      name: string
      base64?: string
    }>
    expect(fileAttachments).toHaveLength(1)
    const first = fileAttachments[0]!
    expect(first.type).toBe('image')
    expect(first.name).toBe('my-photo.png')
    expect(first.base64 && first.base64.length).toBeGreaterThan(0)
  })

  it('keeps binary video attachments as files instead of reading them as text', async () => {
    const { router, sessionManager } = makeRouter()
    const mp4Path = writeTinyMp4()
    await router.route(
      makeFakeAdapter(),
      baseMsg({
        text: '',
        attachments: [
          {
            type: 'video',
            fileId: 'gif-as-video',
            fileName: 'animated.gif.mp4',
            mimeType: 'video/mp4',
            localPath: mp4Path,
          },
        ],
      }),
    )
    expect(sessionManager.sendMessage).toHaveBeenCalledTimes(1)
    const args = sessionManager.sendMessage.mock.calls[0]!
    const fileAttachments = args[2] as Array<{
      type: string
      name: string
      mimeType?: string
      text?: string
    }>
    expect(fileAttachments).toHaveLength(1)
    expect(fileAttachments[0]!.type).toBe('unknown')
    expect(fileAttachments[0]!.name).toBe('animated.gif.mp4')
    expect(fileAttachments[0]!.mimeType).toBe('video/mp4')
    expect(fileAttachments[0]!.text).toBeUndefined()
  })

  it('drops attachments that have no localPath', async () => {
    const { router, sessionManager } = makeRouter()
    await router.route(
      makeFakeAdapter(),
      baseMsg({
        text: 'x',
        attachments: [{ type: 'photo', fileId: 'abc' }],
      }),
    )
    expect(sessionManager.sendMessage).toHaveBeenCalledTimes(1)
    const args = sessionManager.sendMessage.mock.calls[0]!
    expect(args[2]).toBeUndefined()
  })

  it('forwards caption-less attachments with empty text', async () => {
    const { router, sessionManager } = makeRouter()
    const pngPath = writeTinyPng()
    await router.route(
      makeFakeAdapter(),
      baseMsg({
        text: '',
        attachments: [
          { type: 'photo', fileId: 'abc', localPath: pngPath },
        ],
      }),
    )
    expect(sessionManager.sendMessage).toHaveBeenCalledTimes(1)
    const args = sessionManager.sendMessage.mock.calls[0]!
    expect(args[1]).toBe('')
    const fa = args[2] as unknown[]
    expect(fa).toHaveLength(1)
  })

  it('routes unbound channels to Commands.handle', async () => {
    const { router, sessionManager, commands } = makeRouter()
    await router.route(
      makeFakeAdapter(),
      baseMsg({ channelId: 'unbound-channel', text: '/help' }),
    )
    expect(sessionManager.sendMessage).not.toHaveBeenCalled()
    expect(commands.handle).toHaveBeenCalledTimes(1)
  })

  it('lets the agent decide and send an immediate Telegram busy reply without routing to the session', async () => {
    const store = new BindingStore(storeDir)
    store.bind('ws1', 'sess-A', 'telegram', 'chat-1')
    const sessionManager = makeFakeSessionManager({
      isSessionProcessing: mock(() => true),
      decideBusyMessage: mock(async () => ({ action: 'reply', replyText: '还没完成，仍在处理中。' })),
    })
    const commands = makeFakeCommands()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router = new Router(sessionManager as any, store, commands as unknown as Commands)
    const adapter = makeFakeAdapter('telegram')

    await router.route(adapter, baseMsg({ text: '中途问一下' }))

    expect(sessionManager.decideBusyMessage).toHaveBeenCalledTimes(1)
    expect(adapter.sendText).toHaveBeenCalledTimes(1)
    expect(adapter.sendText).toHaveBeenCalledWith('chat-1', '还没完成，仍在处理中。', { threadId: undefined })
    expect(sessionManager.sendMessage).not.toHaveBeenCalled()
  })

  it('lets the agent ignore a Telegram busy follow-up without adding another message', async () => {
    const store = new BindingStore(storeDir)
    store.bind('ws1', 'sess-A', 'telegram', 'chat-1')
    const sessionManager = makeFakeSessionManager({
      isSessionProcessing: mock(() => true),
      decideBusyMessage: mock(async () => ({ action: 'ignore' })),
    })
    const commands = makeFakeCommands()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router = new Router(sessionManager as any, store, commands as unknown as Commands)
    const adapter = makeFakeAdapter('telegram')

    await router.route(adapter, baseMsg({ text: '继续' }))

    expect(sessionManager.decideBusyMessage).toHaveBeenCalledTimes(1)
    expect(adapter.sendText).not.toHaveBeenCalled()
    expect(sessionManager.sendMessage).not.toHaveBeenCalled()
  })

  it('queues substantive busy follow-ups when the agent decision says queue', async () => {
    const store = new BindingStore(storeDir)
    store.bind('ws1', 'sess-A', 'telegram', 'chat-1')
    const sessionManager = makeFakeSessionManager({
      isSessionProcessing: mock(() => true),
      decideBusyMessage: mock(async () => ({ action: 'queue' })),
    })
    const commands = makeFakeCommands()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router = new Router(sessionManager as any, store, commands as unknown as Commands)

    await router.route(makeFakeAdapter('telegram'), baseMsg({ text: '顺便也检查企业微信' }))

    expect(sessionManager.decideBusyMessage).toHaveBeenCalledTimes(1)
    expect(sessionManager.sendMessage).toHaveBeenCalledTimes(1)
    expect(sessionManager.sendMessage.mock.calls[0]?.[4]).toEqual({ midStreamBehavior: 'queue' })
  })

  it('supports WhatsApp busy replies without introducing progress bubbles', async () => {
    const store = new BindingStore(storeDir)
    store.bind('ws1', 'sess-W', 'whatsapp', 'wa-chat')
    const sessionManager = makeFakeSessionManager({
      isSessionProcessing: mock(() => true),
      decideBusyMessage: mock(async () => ({ action: 'reply', replyText: 'Still working on it.' })),
    })
    const commands = makeFakeCommands()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router = new Router(sessionManager as any, store, commands as unknown as Commands)
    const adapter = makeFakeAdapter('whatsapp')

    await router.route(adapter, baseMsg({ platform: 'whatsapp', channelId: 'wa-chat', text: 'done?' }))

    expect(sessionManager.decideBusyMessage).toHaveBeenCalledTimes(1)
    expect(adapter.sendText).toHaveBeenCalledWith('wa-chat', 'Still working on it.', { threadId: undefined })
    expect(sessionManager.sendMessage).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Telegram supergroup forum topics — Phase A
  // -------------------------------------------------------------------------

  it('routes the same chatId + different threadIds to the per-topic session', async () => {
    // Two topics in the same supergroup → two distinct sessions
    const store = new BindingStore(storeDir)
    store.bind('ws1', 'sess-Topic5', 'telegram', '-1001', undefined, undefined, 5)
    store.bind('ws1', 'sess-Topic7', 'telegram', '-1001', undefined, undefined, 7)

    const sessionManager = makeFakeSessionManager()
    const commands = makeFakeCommands()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router = new Router(sessionManager as any, store, commands as unknown as Commands)
    const adapter = makeFakeAdapter()

    await router.route(adapter, baseMsg({ channelId: '-1001', threadId: 5, text: 'hi from t5' }))
    await router.route(adapter, baseMsg({ channelId: '-1001', threadId: 7, text: 'hi from t7' }))

    expect(sessionManager.sendMessage).toHaveBeenCalledTimes(2)
    expect(sessionManager.sendMessage.mock.calls[0]?.[0]).toBe('sess-Topic5')
    expect(sessionManager.sendMessage.mock.calls[1]?.[0]).toBe('sess-Topic7')
  })

  it('falls through to Commands when message lands in an unbound topic', async () => {
    const store = new BindingStore(storeDir)
    // Only topic 5 is bound; topic 7 inbound has no binding
    store.bind('ws1', 'sess-A', 'telegram', '-1001', undefined, undefined, 5)
    const sessionManager = makeFakeSessionManager()
    const commands = makeFakeCommands()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router = new Router(sessionManager as any, store, commands as unknown as Commands)

    await router.route(makeFakeAdapter(), baseMsg({ channelId: '-1001', threadId: 7, text: '/help' }))
    expect(sessionManager.sendMessage).not.toHaveBeenCalled()
    expect(commands.handle).toHaveBeenCalledTimes(1)
  })
})
