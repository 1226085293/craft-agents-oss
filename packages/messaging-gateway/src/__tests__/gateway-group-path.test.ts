/**
 * Where a group message goes.
 *
 * Two paths exist and both are load bearing:
 *   bound group   → straight into that session (the user pointed this chat at
 *                   it); the router's decision gate handles un-mentioned text.
 *   unbound group → event center (via publishMessageEvent), never a session.
 *
 * This file pins the boundary. It is the guard most likely to be "simplified"
 * away later: the `!binding` condition looks redundant until you remove it and
 * every bound chat starts filing events about its own conversation.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { IncomingMessage, PlatformAdapter, SentMessage } from '../types'
import { MessagingGateway } from '../gateway'

const noopLogger: {
  info: () => void
  warn: () => void
  error: () => void
  debug: () => void
  child: () => typeof noopLogger
} = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
}

let storageDir: string

beforeEach(() => {
  storageDir = mkdtempSync(join(tmpdir(), 'craft-group-path-'))
})

function makeSessionManager() {
  return {
    sendMessage: mock(async () => 'msg-id'),
    noteMobileActivity: mock(async () => {}),
    isSessionProcessing: () => false,
    getSession: () => ({ id: 's1', name: 'S1' }),
    getSessions: () => [],
  }
}

function makeAdapter() {
  let messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null
  return {
    platform: 'qq',
    sentTexts: [] as string[],
    capabilities: {
      messageEditing: false,
      inlineButtons: false,
      maxButtons: 0,
      maxMessageLength: 4096,
      markdown: 'markdown',
      webhookSupport: false,
    },
    initialize: async () => {},
    destroy: async () => {},
    isConnected: () => true,
    onMessage: (handler: (msg: IncomingMessage) => Promise<void>) => {
      messageHandler = handler
    },
    onButtonPress: () => {},
    sendText: mock(async (channelId: string, text: string): Promise<SentMessage> => {
      ;(makeAdapter as unknown as { _sent?: string[] })._sent?.push(text)
      return { platform: 'qq', channelId, messageId: 'm' }
    }),
    editMessage: async () => {},
    sendButtons: async () => ({}) as SentMessage,
    sendTyping: async () => {},
    sendFile: async () => {},
    emit: async (msg: IncomingMessage) => {
      if (!messageHandler) throw new Error('message handler not wired')
      await messageHandler(msg)
    },
  } as unknown as PlatformAdapter & { emit(msg: IncomingMessage): Promise<void>; sentTexts: string[] }
}

function groupMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    platform: 'qq',
    channelId: 'group:g1',
    messageId: 'm1',
    senderId: 'u1',
    text: '你好',
    timestamp: Date.now(),
    chatKind: 'group',
    mentionKind: 'at',
    raw: {},
    ...overrides,
  } as IncomingMessage
}

describe('group message destination', () => {
  it('offers an unbound @-mention to the event center', async () => {
    const publishMessageEvent = mock(() => true)
    const sessionManager = makeSessionManager()
    const adapter = makeAdapter()

    const gateway = new MessagingGateway({
      sessionManager: sessionManager as never,
      workspaceId: 'ws1',
      storageDir,
      logger: noopLogger as never,
      publishMessageEvent: publishMessageEvent as never,
    })
    gateway.registerAdapter(adapter)
    await gateway.start()

    await adapter.emit(groupMessage())

    expect(publishMessageEvent).toHaveBeenCalledTimes(1)
    // Claimed by the event center: it must not also become a user turn.
    expect(sessionManager.sendMessage).not.toHaveBeenCalled()
  })

  it('routes a bound group message into its session, not the event center', async () => {
    const publishMessageEvent = mock(() => true)
    const sessionManager = makeSessionManager()
    const adapter = makeAdapter()

    const gateway = new MessagingGateway({
      sessionManager: sessionManager as never,
      workspaceId: 'ws1',
      storageDir,
      logger: noopLogger as never,
      publishMessageEvent: publishMessageEvent as never,
    })
    gateway.registerAdapter(adapter)
    await gateway.start()

    // Bind the chat to a session first.
    gateway.getBindingStore().bind('ws1', 's1', 'qq', 'group:g1', 'G1')

    await adapter.emit(groupMessage())

    // A bound chat is a conversation the user pointed at a session; turning it
    // into an event would make the supervisor comment on its own dialogue.
    expect(publishMessageEvent).not.toHaveBeenCalled()
  })

  it('leaves a DM alone even when it mentions the bot', async () => {
    const publishMessageEvent = mock(() => true)
    const adapter = makeAdapter()

    const gateway = new MessagingGateway({
      sessionManager: makeSessionManager() as never,
      workspaceId: 'ws1',
      storageDir,
      logger: noopLogger as never,
      publishMessageEvent: publishMessageEvent as never,
    })
    gateway.registerAdapter(adapter)
    await gateway.start()

    await adapter.emit(groupMessage({ chatKind: 'private', channelId: 'user:u1' }))

    expect(publishMessageEvent).not.toHaveBeenCalled()
  })
})
