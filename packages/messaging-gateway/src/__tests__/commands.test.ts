import { afterEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Session } from '@craft-agent/shared/protocol'
import type { ISessionManager } from '@craft-agent/server-core/handlers'
import { BindingStore } from '../binding-store'
import { Commands } from '../commands'
import type { IncomingMessage, PlatformAdapter, SentMessage } from '../types'

function makeSession(id: string, name: string, lastMessageAt: number): Session {
  return {
    id,
    name,
    workspaceId: 'ws1',
    workspaceName: 'Workspace',
    messages: [],
    isProcessing: false,
    createdAt: lastMessageAt - 1000,
    updatedAt: lastMessageAt,
    lastMessageAt,
    isArchived: false,
  } as unknown as Session
}

function makeSessionManager(
  sessions: Session[],
  overrides: Partial<ISessionManager> = {},
): ISessionManager {
  return {
    getSessions: () => sessions,
    getSession: async (sessionId: string) => sessions.find((session) => session.id === sessionId) ?? null,
    createSession: async () => { throw new Error('not implemented') },
    sendMessage: async () => {},
    clearSessionMessages: async () => {},
    cancelProcessing: async () => {},
    respondToPermission: () => true,
    ...overrides,
  } as unknown as ISessionManager
}

function makeAdapter(platform: 'telegram' | 'whatsapp', inlineButtons: boolean): PlatformAdapter & { sent: string[] } {
  const sent: string[] = []
  return {
    platform,
    capabilities: {
      messageEditing: inlineButtons,
      inlineButtons,
      maxButtons: 10,
      maxMessageLength: 4096,
      markdown: platform === 'telegram' ? 'v2' : 'whatsapp',
      webhookSupport: false,
    },
    sent,
    async initialize() {},
    async destroy() {},
    isConnected() { return true },
    onMessage() {},
    onButtonPress() {},
    async sendText(_channelId: string, text: string): Promise<SentMessage> {
      sent.push(text)
      return { platform, channelId: 'chan-1', messageId: String(sent.length) }
    },
    async editMessage() {},
    async sendButtons(_channelId: string, text: string): Promise<SentMessage> {
      sent.push(text)
      return { platform, channelId: 'chan-1', messageId: String(sent.length) }
    },
    async sendTyping() {},
    async sendFile(): Promise<SentMessage> {
      return { platform, channelId: 'chan-1', messageId: String(sent.length + 1) }
    },
  }
}

function makeMessage(text: string): IncomingMessage {
  return {
    platform: 'whatsapp',
    channelId: 'chan-1',
    messageId: 'm1',
    senderId: 'u1',
    senderName: 'Alice',
    text,
    timestamp: Date.now(),
    raw: {},
  }
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeStore(): BindingStore {
  const dir = mkdtempSync(join(tmpdir(), 'commands-bind-'))
  tempDirs.push(dir)
  return new BindingStore(dir)
}

describe('Commands', () => {
  it('binds by numbered recent-session index on non-inline platforms', async () => {
    const sessions = [
      makeSession('sess-1', 'Old', 100),
      makeSession('sess-2', 'Newest', 200),
    ]
    const store = makeStore()
    const commands = new Commands(makeSessionManager(sessions), store, 'ws1')
    const adapter = makeAdapter('whatsapp', false)

    await commands.handleCommand(adapter, makeMessage('/bind 1'))

    expect(store.findByChannel('whatsapp', 'chan-1')?.sessionId).toBe('sess-2')
    expect(adapter.sent.at(-1)).toContain('Newest')
  })

  it('lists numbered recent sessions with usable /bind instructions on WhatsApp', async () => {
    const sessions = [
      makeSession('sess-1', 'Alpha', 100),
      makeSession('sess-2', 'Beta', 200),
    ]
    const store = makeStore()
    const commands = new Commands(makeSessionManager(sessions), store, 'ws1')
    const adapter = makeAdapter('whatsapp', false)

    await commands.handleCommand(adapter, makeMessage('/bind'))

    expect(adapter.sent[0]).toContain('1. Beta (sess-2)')
    expect(adapter.sent[0]).toContain('/bind <number>')
  })

  it('compacts the currently bound session from chat', async () => {
    const sessions = [makeSession('sess-1', 'Alpha', 100)]
    const sendMessage = mock(async () => {})
    const store = makeStore()
    store.bind('ws1', 'sess-1', 'telegram', 'chan-1', 'Alice')
    const commands = new Commands(
      makeSessionManager(sessions, { sendMessage } as Partial<ISessionManager>),
      store,
      'ws1',
    )
    const adapter = makeAdapter('telegram', true)

    await commands.handleCommand(adapter, { ...makeMessage('/compact'), platform: 'telegram' })

    expect(sendMessage).toHaveBeenCalledWith('sess-1', '/compact')
    expect(adapter.sent.at(-1)).toContain('Compacting conversation context')
  })

  it('rejects /compact when the chat is not bound', async () => {
    const sessions = [makeSession('sess-1', 'Alpha', 100)]
    const sendMessage = mock(async () => {})
    const store = makeStore()
    const commands = new Commands(
      makeSessionManager(sessions, { sendMessage } as Partial<ISessionManager>),
      store,
      'ws1',
    )
    const adapter = makeAdapter('telegram', true)

    await commands.handleCommand(adapter, { ...makeMessage('/compact'), platform: 'telegram' })

    expect(sendMessage).not.toHaveBeenCalled()
    expect(adapter.sent.at(-1)).toBe('No session bound.')
  })

  it('does not compact while the bound session is processing', async () => {
    const session = makeSession('sess-1', 'Alpha', 100)
    session.isProcessing = true
    const sendMessage = mock(async () => {})
    const store = makeStore()
    store.bind('ws1', 'sess-1', 'telegram', 'chan-1', 'Alice')
    const commands = new Commands(
      makeSessionManager([session], { sendMessage } as Partial<ISessionManager>),
      store,
      'ws1',
    )
    const adapter = makeAdapter('telegram', true)

    await commands.handleCommand(adapter, { ...makeMessage('/compact'), platform: 'telegram' })

    expect(sendMessage).not.toHaveBeenCalled()
    expect(adapter.sent.at(-1)).toContain('Session is busy')
    expect(adapter.sent.at(-1)).toContain('/stop')
  })

  it('clears the currently bound session from chat', async () => {
    const sessions = [makeSession('sess-1', 'Alpha', 100)]
    const clearSessionMessages = mock(async () => {})
    const store = makeStore()
    store.bind('ws1', 'sess-1', 'telegram', 'chan-1', 'Alice')
    const commands = new Commands(
      makeSessionManager(sessions, { clearSessionMessages } as Partial<ISessionManager>),
      store,
      'ws1',
    )
    const adapter = makeAdapter('telegram', true)

    await commands.handleCommand(adapter, { ...makeMessage('/clear'), platform: 'telegram' })

    expect(clearSessionMessages).toHaveBeenCalledWith('sess-1')
    expect(adapter.sent.at(-1)).toContain('Context cleared')
  })

  it('does not clear while the bound session is processing', async () => {
    const session = makeSession('sess-1', 'Alpha', 100)
    session.isProcessing = true
    const clearSessionMessages = mock(async () => {})
    const store = makeStore()
    store.bind('ws1', 'sess-1', 'telegram', 'chan-1', 'Alice')
    const commands = new Commands(
      makeSessionManager([session], { clearSessionMessages } as Partial<ISessionManager>),
      store,
      'ws1',
    )
    const adapter = makeAdapter('telegram', true)

    await commands.handleCommand(adapter, { ...makeMessage('/clear'), platform: 'telegram' })

    expect(clearSessionMessages).not.toHaveBeenCalled()
    expect(adapter.sent.at(-1)).toContain('Session is busy')
    expect(adapter.sent.at(-1)).toContain('/stop')
  })
})
