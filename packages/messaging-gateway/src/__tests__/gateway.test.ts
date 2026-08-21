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

describe('MessagingGateway — WhatsApp delivery recovery', () => {
  it('renders the original reply after a disconnected WhatsApp adapter recovers', async () => {
    const sessionManager = makeSessionManager()
    const recoveredAdapter = makeSlowWhatsAppAdapter(0)
    const disconnectedAdapter = {
      ...makeSlowWhatsAppAdapter(0),
      isConnected: () => false,
    }
    const recover = mock(async () => recoveredAdapter)
    const blocked = mock(() => {})
    const gateway = new MessagingGateway({
      sessionManager: sessionManager as any,
      workspaceId: 'ws1',
      storageDir,
      logger: noopLogger,
      onRecoverDelivery: recover,
      onDeliveryBlocked: blocked,
    })
    gateway.registerAdapter(disconnectedAdapter)
    await gateway.start()
    gateway.getBindingStore().bind('ws1', 'sess-A', 'whatsapp', 'chat-1', undefined, {
      responseMode: 'progress',
    })

    gateway.onSessionEvent(RPC_CHANNELS.sessions.EVENT, {} as any, {
      type: 'text_complete',
      sessionId: 'sess-A',
      text: 'Recovered normal reply.',
      isIntermediate: false,
    })
    gateway.onSessionEvent(RPC_CHANNELS.sessions.EVENT, {} as any, {
      type: 'complete',
      sessionId: 'sess-A',
    })

    await delay(80)

    expect(recover).toHaveBeenCalled()
    expect(blocked).not.toHaveBeenCalled()
    expect(recoveredAdapter.texts).toEqual(['Recovered normal reply.'])
  })
})

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

// ---------------------------------------------------------------------------
// Telegram pending-event queue — replies survive adapter outages
// ---------------------------------------------------------------------------

function makeTelegramAdapter(connected: boolean): PlatformAdapter & { texts: string[] } {
  const base = makeSlowWhatsAppAdapter(0)
  return {
    ...base,
    platform: 'telegram',
    isConnected: () => connected,
    sendText: mock(async (channelId: string, text: string): Promise<SentMessage> => {
      base.texts.push(text)
      return { platform: 'telegram', channelId, messageId: `t${base.texts.length}` }
    }),
  } as unknown as PlatformAdapter & { texts: string[] }
}

describe('MessagingGateway — Telegram pending queue', () => {
  it('holds final-form events while disconnected and flushes them after reconnect', async () => {
    const sessionManager = makeSessionManager()
    const blocked = mock(() => {})
    const gateway = new MessagingGateway({
      sessionManager: sessionManager as any,
      workspaceId: 'ws1',
      storageDir,
      logger: noopLogger,
      onDeliveryBlocked: blocked,
    })
    // Register a DISCONNECTED telegram adapter (restart window).
    gateway.registerAdapter(makeTelegramAdapter(false))
    await gateway.start()
    gateway.getBindingStore().bind('ws1', 'sess-T', 'telegram', 'chat-9', undefined, {
      responseMode: 'progress',
    })

    // Final-form event → held. Streaming delta → dropped silently.
    gateway.onSessionEvent(RPC_CHANNELS.sessions.EVENT, {} as any, {
      type: 'text_delta',
      sessionId: 'sess-T',
      delta: 'partial…',
    })
    gateway.onSessionEvent(RPC_CHANNELS.sessions.EVENT, {} as any, {
      type: 'text_complete',
      sessionId: 'sess-T',
      text: 'Reply that must survive the restart.',
      isIntermediate: false,
    })
    gateway.onSessionEvent(RPC_CHANNELS.sessions.EVENT, {} as any, {
      type: 'complete',
      sessionId: 'sess-T',
    })
    await delay(30)

    expect(blocked).not.toHaveBeenCalled()

    // Adapter "reconnects" → flush renders the held reply.
    const reconnected = makeTelegramAdapter(true)
    const flushed = gateway.flushPendingTelegramEvents(reconnected)
    await delay(30)

    expect(flushed).toBe(2)
    // progress mode: text_complete buffers, complete delivers the final text
    expect(reconnected.texts).toEqual(['Reply that must survive the restart.'])
  })

  it('drops held events older than the TTL instead of rendering stale output', async () => {
    const sessionManager = makeSessionManager()
    const gateway = new MessagingGateway({
      sessionManager: sessionManager as any,
      workspaceId: 'ws1',
      storageDir,
      logger: noopLogger,
    })
    gateway.registerAdapter(makeTelegramAdapter(false))
    await gateway.start()
    gateway.getBindingStore().bind('ws1', 'sess-U', 'telegram', 'chat-10', undefined, {
      responseMode: 'progress',
    })

    gateway.onSessionEvent(RPC_CHANNELS.sessions.EVENT, {} as any, {
      type: 'text_complete',
      sessionId: 'sess-U',
      text: 'Will expire.',
      isIntermediate: false,
    })

    // Force-expire by flushing with a fresh queue whose entries predate the TTL.
    const reconnected = makeTelegramAdapter(true)
    // Reach into internals is avoided; instead simulate expiry via time travel:
    const anyGateway = gateway as unknown as {
      pendingTelegramEvents: Map<string, Array<{ queuedAt: number }>>
    }
    for (const queue of anyGateway.pendingTelegramEvents.values()) {
      for (const entry of queue) entry.queuedAt -= 11 * 60 * 1000
    }
    const flushed = gateway.flushPendingTelegramEvents(reconnected)

    expect(flushed).toBe(0)
    expect(reconnected.texts).toEqual([])
  })
})
