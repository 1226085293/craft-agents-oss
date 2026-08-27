/**
 * MessagingGateway — group-chat slash commands must @-mention the bot.
 *
 * In shared groups (multiple bots coexist) an un-addressed /command is
 * ambiguous — this bot must not answer commands aimed at another bot.
 * Gate: group messages are only passed to `handleCommand` when
 * `mentionKind === 'at'`; un-addressed group commands are silently dropped
 * (never routed). DMs are always honored.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MessagingGateway } from '../gateway'
import type { IncomingMessage, PlatformAdapter, PlatformConfig, SentMessage } from '../types'

let storageDir: string

beforeEach(() => {
  storageDir = mkdtempSync(join(tmpdir(), 'gateway-groupcmd-'))
})

afterEach(() => {
  rmSync(storageDir, { recursive: true, force: true })
})

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
}

function makeSessionManager() {
  return {
    getSessionPath: () => undefined,
    getWorkspaces: () => [],
    getSession: mock(async (sessionId: string) => ({ id: sessionId, name: sessionId })),
    sendMessage: mock(async () => {}),
    respondToPermission: mock(() => {}),
    acceptPlan: mock(async () => {}),
  }
}

/**
 * Build a minimal adapter that exposes `onMessage` so the test can push
 * inbound messages through the gateway's wireAdapter, plus a spy on the
 * command handler result. Since `commands` is internal to the gateway,
 * we instead assert via the router: a dropped group command must produce
 * no outbound traffic, while a group command with @ (or a DM command)
 * reaches handleCommand.
 */
function makeTestAdapter(): PlatformAdapter & {
  emit(msg: IncomingMessage): Promise<void>
  sentTexts: string[]
} {
  let messageHandler: ((msg: IncomingMessage) => Promise<void>) | undefined
  const sentTexts: string[] = []
  return {
    platform: 'qq',
    sentTexts,
    capabilities: {
      messageEditing: false,
      inlineButtons: false,
      maxButtons: 0,
      maxMessageLength: 4096,
      markdown: 'markdown',
      webhookSupport: false,
    },
    initialize: async (_config: PlatformConfig) => {},
    destroy: async () => {},
    isConnected: () => true,
    onMessage: (handler: (msg: IncomingMessage) => Promise<void>) => {
      messageHandler = handler
    },
    onButtonPress: () => {},
    sendText: mock(async (channelId: string, text: string): Promise<SentMessage> => {
      sentTexts.push(text)
      return { platform: 'qq', channelId, messageId: 'm' }
    }),
    editMessage: async () => {},
    sendButtons: async () => ({} as SentMessage),
    sendTyping: async () => {},
    sendFile: async () => {},
    emit: async (msg: IncomingMessage) => {
      if (!messageHandler) throw new Error('message handler not wired')
      await messageHandler(msg)
    },
  } as unknown as PlatformAdapter & { emit(msg: IncomingMessage): Promise<void>; sentTexts: string[] }
}

describe('MessagingGateway — group commands require @-mention', () => {
  it('drops an un-addressed group command (mentionKind=none) without routing', async () => {
    const sessionManager = makeSessionManager()
    const adapter = makeTestAdapter()
    const gateway = new MessagingGateway({
      sessionManager: sessionManager as any,
      workspaceId: 'ws1',
      storageDir,
      logger: noopLogger,
    })
    gateway.registerAdapter(adapter)
    await gateway.start()

    await adapter.emit({
      platform: 'qq',
      channelId: 'group:g1',
      messageId: 'm1',
      senderId: 'u1',
      text: '/exec execute',
      timestamp: Date.now(),
      chatKind: 'group',
      mentionKind: 'none',
      raw: {},
    })

    // No outbound, no routing side effect. The command was dropped.
    expect(adapter.sentTexts).toEqual([])
    expect(sessionManager.sendMessage).not.toHaveBeenCalled()
  })

  it('drops an un-addressed group command when mentionKind is undefined', async () => {
    const sessionManager = makeSessionManager()
    const adapter = makeTestAdapter()
    const gateway = new MessagingGateway({
      sessionManager: sessionManager as any,
      workspaceId: 'ws1',
      storageDir,
      logger: noopLogger,
    })
    gateway.registerAdapter(adapter)
    await gateway.start()

    await adapter.emit({
      platform: 'telegram',
      channelId: '-100123',
      messageId: 'm2',
      senderId: 'u1',
      text: '/exec execute',
      timestamp: Date.now(),
      chatKind: 'group',
      raw: {},
    })

    expect(adapter.sentTexts).toEqual([])
    expect(sessionManager.sendMessage).not.toHaveBeenCalled()
  })

  it('honors a group command that @-mentions the bot (mentionKind=at)', async () => {
    const sessionManager = makeSessionManager()
    const adapter = makeTestAdapter()
    const gateway = new MessagingGateway({
      sessionManager: sessionManager as any,
      workspaceId: 'ws1',
      storageDir,
      logger: noopLogger,
    })
    gateway.registerAdapter(adapter)
    await gateway.start()

    // Bind a session so /exec can resolve; then a group command with @
    // should route (not be dropped). We assert by observing that the
    // message is NOT dropped — i.e. it reaches the router, which for an
    // unbound command would still produce no send; use /help which always
    // responds with text.
    await adapter.emit({
      platform: 'qq',
      channelId: 'group:g1',
      messageId: 'm3',
      senderId: 'u1',
      text: '/help',
      timestamp: Date.now(),
      chatKind: 'group',
      mentionKind: 'at',
      raw: {},
    })

    // /help is handled by commands (owner-only + ALWAYS_ALLOWED). It should
    // produce an outbound response rather than being silently dropped.
    expect(adapter.sentTexts.length).toBeGreaterThan(0)
  })

  it('honors a DM command regardless of mention state', async () => {
    const sessionManager = makeSessionManager()
    const adapter = makeTestAdapter()
    const gateway = new MessagingGateway({
      sessionManager: sessionManager as any,
      workspaceId: 'ws1',
      storageDir,
      logger: noopLogger,
    })
    gateway.registerAdapter(adapter)
    await gateway.start()

    await adapter.emit({
      platform: 'qq',
      channelId: 'user:u1',
      messageId: 'm4',
      senderId: 'u1',
      text: '/help',
      timestamp: Date.now(),
      chatKind: 'private',
      raw: {},
    })

    // DM command is always handled → outbound response.
    expect(adapter.sentTexts.length).toBeGreaterThan(0)
  })

  it('still routes non-command group messages through the decision gate', async () => {
    const sessionManager = makeSessionManager()
    const adapter = makeTestAdapter()
    const gateway = new MessagingGateway({
      sessionManager: sessionManager as any,
      workspaceId: 'ws1',
      storageDir,
      logger: noopLogger,
    })
    gateway.registerAdapter(adapter)
    await gateway.start()

    // Non-command group message — must NOT be dropped by the command gate;
    // it flows to the router (and access control). The access-control
    // rejection reply proves it reached the router instead of being
    // silently dropped by the command gate.
    await adapter.emit({
      platform: 'qq',
      channelId: 'group:g1',
      messageId: 'm5',
      senderId: 'u1',
      text: 'hello everyone',
      timestamp: Date.now(),
      chatKind: 'group',
      mentionKind: 'none',
      raw: {},
    })

    expect(adapter.sentTexts.length).toBeGreaterThan(0)
  })
})
