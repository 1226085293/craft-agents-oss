/**
 * MessagingGateway tests — outbound session event ordering.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { MessagingGateway } from '../gateway'
import type { IncomingMessage, PlatformAdapter, PlatformConfig, SentMessage } from '../types'

let storageDir: string

beforeEach(() => {
  storageDir = mkdtempSync(join(tmpdir(), 'gateway-store-'))
})

afterEach(() => {
  rmSync(storageDir, { recursive: true, force: true })
})

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

function makeSlowWhatsAppAdapter(sendDelayMs = 25): PlatformAdapter & { texts: string[] } {
  let messageHandler: ((msg: IncomingMessage) => Promise<void>) | undefined
  let nextId = 0
  const texts: string[] = []
  const unused = async () => {
    throw new Error('unused')
  }

  return {
    platform: 'whatsapp',
    texts,
    capabilities: {
      messageEditing: false,
      inlineButtons: false,
      maxButtons: 0,
      maxMessageLength: 4096,
      markdown: 'whatsapp',
      webhookSupport: false,
    },
    initialize: async (_config: PlatformConfig) => {},
    destroy: async () => {},
    isConnected: () => true,
    onMessage: (handler) => {
      messageHandler = handler
    },
    onButtonPress: () => {},
    sendText: mock(async (channelId: string, text: string): Promise<SentMessage> => {
      await delay(sendDelayMs)
      texts.push(text)
      nextId += 1
      return { platform: 'whatsapp', channelId, messageId: `m${nextId}` }
    }),
    editMessage: unused,
    sendButtons: unused,
    sendTyping: async () => {},
    sendFile: unused,
    emitMessage: async (msg: IncomingMessage) => {
      if (!messageHandler) throw new Error('message handler not wired')
      await messageHandler(msg)
    },
  } as PlatformAdapter & { texts: string[]; emitMessage(msg: IncomingMessage): Promise<void> }
}

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
}

describe('MessagingGateway — outbound ordering', () => {
  it('serializes session events per binding so final replies cannot overtake progress messages', async () => {
    const sessionManager = makeSessionManager()
    const gateway = new MessagingGateway({
      sessionManager: sessionManager as any,
      workspaceId: 'ws1',
      storageDir,
      logger: noopLogger,
    })
    const adapter = makeSlowWhatsAppAdapter()
    gateway.registerAdapter(adapter)
    await gateway.start()
    gateway.getBindingStore().bind('ws1', 'sess-A', 'whatsapp', 'chat-1', undefined, {
      responseMode: 'progress',
    })

    gateway.onSessionEvent(RPC_CHANNELS.sessions.EVENT, {} as any, {
      type: 'tool_start',
      sessionId: 'sess-A',
      toolName: 'read',
      toolDisplayName: 'Read',
    })
    gateway.onSessionEvent(RPC_CHANNELS.sessions.EVENT, {} as any, {
      type: 'text_complete',
      sessionId: 'sess-A',
      text: 'The answer is 42.',
      isIntermediate: false,
    })
    gateway.onSessionEvent(RPC_CHANNELS.sessions.EVENT, {} as any, {
      type: 'complete',
      sessionId: 'sess-A',
    })

    await delay(120)

    expect(adapter.texts).toEqual(['The answer is 42.'])
  })
})
