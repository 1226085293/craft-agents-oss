import { afterEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Session } from '@craft-agent/shared/protocol'
import type { ISessionManager } from '@craft-agent/server-core/handlers'
import { BindingStore } from '../binding-store'
import { Commands } from '../commands'
import type { IncomingMessage, PlatformAdapter, SentMessage, InlineButton } from '../types'

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

function makeAdapter(platform: 'telegram' | 'whatsapp', inlineButtons: boolean): PlatformAdapter & { sent: string[]; sentButtons: InlineButton[]; edits: Array<{ messageId: string; text: string }> } {
  const sent: string[] = []
  const sentButtons: InlineButton[] = []
  const edits: Array<{ messageId: string; text: string }> = []
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
    sentButtons,
    edits,
    async initialize() {},
    async destroy() {},
    isConnected() { return true },
    onMessage() {},
    onButtonPress() {},
    async sendText(_channelId: string, text: string): Promise<SentMessage> {
      sent.push(text)
      return { platform, channelId: 'chan-1', messageId: String(sent.length) }
    },
    async editMessage(_channelId: string, messageId: string, text: string): Promise<void> {
      edits.push({ messageId, text })
    },
    async sendButtons(_channelId: string, text: string, buttons?: InlineButton[]): Promise<SentMessage> {
      sent.push(text)
      if (buttons) sentButtons.push(...buttons)
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

  describe('/thinking', () => {
    function setup(level?: string) {
      const sessions = [makeSession('sess-1', 'Alpha', 100)]
      if (level) (sessions[0] as { thinkingLevel?: string }).thinkingLevel = level
      const setSessionThinkingLevel = mock((_id: string, _level: string) => {})
      const store = makeStore()
      store.bind('ws1', 'sess-1', 'telegram', 'chan-1', 'Alice')
      const commands = new Commands(
        makeSessionManager(sessions, { setSessionThinkingLevel } as Partial<ISessionManager>),
        store,
        'ws1',
      )
      const adapter = makeAdapter('telegram', true)
      return { setSessionThinkingLevel, commands, adapter }
    }

    it('sets the thinking level of the bound session', async () => {
      const { setSessionThinkingLevel, commands, adapter } = setup('medium')

      await commands.handleCommand(adapter, { ...makeMessage('/thinking high'), platform: 'telegram' })

      expect(setSessionThinkingLevel).toHaveBeenCalledWith('sess-1', 'high')
      expect(adapter.sent.at(-1)).toContain('Thinking level set to high.')
    })

    it('is case-insensitive and tolerates the @bot suffix', async () => {
      const { setSessionThinkingLevel, commands, adapter } = setup('medium')

      await commands.handleCommand(adapter, { ...makeMessage('/thinking@MyBot MAX'), platform: 'telegram' })

      expect(setSessionThinkingLevel).toHaveBeenCalledWith('sess-1', 'max')
    })

    it('presents the thinking level picker as buttons when no argument is given (inline platform)', async () => {
      const { setSessionThinkingLevel, commands, adapter } = setup('xhigh')

      await commands.handleCommand(adapter, { ...makeMessage('/thinking'), platform: 'telegram' })

      expect(setSessionThinkingLevel).not.toHaveBeenCalled()
      // Six levels, each button carries a `think:` id, current one marked.
      expect(adapter.sentButtons).toHaveLength(6)
      expect(adapter.sentButtons.every((b) => b.id.startsWith('think:'))).toBe(true)
      expect(adapter.sentButtons.some((b) => b.label.includes('xhigh'))).toBe(true)
      expect(adapter.sentButtons.filter((b) => b.label.startsWith('✓ '))).toHaveLength(1)
    })

    it('falls back to text usage on platforms without inline buttons', async () => {
      const setSessionThinkingLevel = mock((_id: string, _level: string) => {})
      const store = makeStore()
      store.bind('ws1', 'sess-1', 'whatsapp', 'chan-1', 'Alice')
      const commands = new Commands(
        makeSessionManager([makeSession('sess-1', 'Alpha', 100)], { setSessionThinkingLevel } as Partial<ISessionManager>),
        store,
        'ws1',
      )
      const adapter = makeAdapter('whatsapp', false)

      await commands.handleCommand(adapter, { ...makeMessage('/thinking'), platform: 'whatsapp' })

      expect(setSessionThinkingLevel).not.toHaveBeenCalled()
      expect(adapter.sentButtons).toHaveLength(0)
      expect(adapter.sent.at(-1)).toContain('Thinking level:')
      expect(adapter.sent.at(-1)).toContain('Usage: /thinking')
    })

    it('rejects an unknown level without touching the session', async () => {
      const { setSessionThinkingLevel, commands, adapter } = setup('medium')

      await commands.handleCommand(adapter, { ...makeMessage('/thinking bogus'), platform: 'telegram' })

      expect(setSessionThinkingLevel).not.toHaveBeenCalled()
      expect(adapter.sent.at(-1)).toContain('Usage: /thinking')
    })
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

  it('edits the started notice in place once compaction completes (editing-capable platform)', async () => {
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

    // Started notice is sent exactly once, then edited in place (no second message).
    expect(adapter.sent.filter(s => s.includes('Compacting conversation context'))).toHaveLength(1)
    expect(adapter.edits).toHaveLength(1)
    expect(adapter.edits[0].messageId).toBe('1')
    expect(adapter.edits[0].text).toContain('Compaction complete')
  })

  it('appends a completion line on platforms that cannot edit messages', async () => {
    const sessions = [makeSession('sess-1', 'Alpha', 100)]
    const sendMessage = mock(async () => {})
    const store = makeStore()
    store.bind('ws1', 'sess-1', 'whatsapp', 'chan-1', 'Alice')
    const commands = new Commands(
      makeSessionManager(sessions, { sendMessage } as Partial<ISessionManager>),
      store,
      'ws1',
    )
    const adapter = makeAdapter('whatsapp', false)

    await commands.handleCommand(adapter, { ...makeMessage('/compact'), platform: 'whatsapp' })

    expect(adapter.edits).toHaveLength(0)
    expect(adapter.sent.filter(s => s.includes('Compacting conversation context'))).toHaveLength(1)
    expect(adapter.sent.at(-1)).toContain('Compaction complete')
  })

  it('edits the started notice with a failure message when compaction throws', async () => {
    const sessions = [makeSession('sess-1', 'Alpha', 100)]
    const sendMessage = mock(async () => { throw new Error('boom') })
    const store = makeStore()
    store.bind('ws1', 'sess-1', 'telegram', 'chan-1', 'Alice')
    const commands = new Commands(
      makeSessionManager(sessions, { sendMessage } as Partial<ISessionManager>),
      store,
      'ws1',
    )
    const adapter = makeAdapter('telegram', true)

    await commands.handleCommand(adapter, { ...makeMessage('/compact'), platform: 'telegram' })

    expect(adapter.edits).toHaveLength(1)
    expect(adapter.edits[0].text).toContain('failed')
    expect(adapter.edits[0].text).toContain('boom')
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

  it('stops the run and then clears when the bound session is processing', async () => {
    const session = makeSession('sess-1', 'Alpha', 100)
    session.isProcessing = true
    const clearSessionMessages = mock(async () => {})
    // Mirrors the real cancelProcessing: it requests the stop but leaves
    // isProcessing set until the event loop drains.
    const cancelProcessing = mock(async () => {
      session.isProcessing = false
    })
    const store = makeStore()
    store.bind('ws1', 'sess-1', 'telegram', 'chan-1', 'Alice')
    const commands = new Commands(
      makeSessionManager([session], { clearSessionMessages, cancelProcessing } as Partial<ISessionManager>),
      store,
      'ws1',
    )
    const adapter = makeAdapter('telegram', true)

    await commands.handleCommand(adapter, { ...makeMessage('/clear'), platform: 'telegram' })

    expect(cancelProcessing).toHaveBeenCalledWith('sess-1')
    expect(clearSessionMessages).toHaveBeenCalledWith('sess-1')
    expect(adapter.sent.at(-1)).toContain('Context cleared')
  })

  describe('/status model info', () => {
    it('shows model, connection, thinking level and idle status when set', async () => {
      const session = makeSession('sess-1', 'Alpha', 100)
      ;(session as unknown as Record<string, unknown>).model = 'agnes-2.5-flash'
      ;(session as unknown as Record<string, unknown>).llmConnection = 'litellm-proxy'
      ;(session as unknown as Record<string, unknown>).thinkingLevel = 'medium'
      const store = makeStore()
      store.bind('ws1', 'sess-1', 'telegram', 'chan-1', 'Alice')
      const commands = new Commands(
        makeSessionManager([session]),
        store,
        'ws1',
        undefined,
        undefined,
        {
          getWorkspaceConfig: () => ({ enabled: false, platforms: {} }),
          seedOwnerOnFirstPair: async () => [],
          resolveConnection: (slug) => (slug === 'litellm-proxy' ? { name: 'litellm-proxy' } : undefined),
        },
      )
      const adapter = makeAdapter('telegram', true)

      await commands.handleCommand(adapter, { ...makeMessage('/status'), platform: 'telegram' })

      const out = adapter.sent.at(-1) ?? ''
      expect(out).toContain('Bound to "Alpha"')
      expect(out).toContain('Model: agnes-2.5-flash')
      expect(out).toContain('Connection: litellm-proxy')
      expect(out).not.toContain('(removed')
      expect(out).toContain('Thinking: medium')
      expect(out).toContain('Status: idle')
    })

    it('shows connection display name when resolveConnection resolves the slug', async () => {
      const session = makeSession('sess-1', 'Alpha', 100)
      ;(session as unknown as Record<string, unknown>).model = 'default'
      ;(session as unknown as Record<string, unknown>).llmConnection = 'litellm-proxy'
      const store = makeStore()
      store.bind('ws1', 'sess-1', 'telegram', 'chan-1', 'Alice')
      const commands = new Commands(
        makeSessionManager([session]),
        store,
        'ws1',
        undefined,
        undefined,
        {
          getWorkspaceConfig: () => ({ enabled: false, platforms: {} }),
          seedOwnerOnFirstPair: async () => [],
          resolveConnection: (slug) => (slug === 'litellm-proxy' ? { name: 'LiteLLM Proxy' } : undefined),
        },
      )
      const adapter = makeAdapter('telegram', true)

      await commands.handleCommand(adapter, { ...makeMessage('/status'), platform: 'telegram' })

      const out = adapter.sent.at(-1) ?? ''
      expect(out).toContain('Connection: LiteLLM Proxy')
      expect(out).not.toContain('(removed')
    })

    it('shows the live default connection/model when the persisted one was deleted', async () => {
      // Session created while 'agnes-openai' existed; connection since removed.
      // /status must show what ACTUALLY answers now (the workspace default),
      // not the stale label.
      const session = makeSession('sess-1', 'Alpha', 100)
      ;(session as unknown as Record<string, unknown>).model = 'agnes-2.5-flash'
      ;(session as unknown as Record<string, unknown>).llmConnection = 'agnes-openai'
      const store = makeStore()
      store.bind('ws1', 'sess-1', 'telegram', 'chan-1', 'Alice')
      const commands = new Commands(
        makeSessionManager([session]),
        store,
        'ws1',
        undefined,
        undefined,
        {
          getWorkspaceConfig: () => ({ enabled: false, platforms: {} }),
          seedOwnerOnFirstPair: async () => [],
          resolveConnection: () => undefined, // slug no longer in config
          resolveDefaultConnection: () => ({
            slug: 'litellm-proxy',
            name: 'LiteLLM Proxy',
            defaultModel: 'default',
          }),
        },
      )
      const adapter = makeAdapter('telegram', true)

      await commands.handleCommand(adapter, { ...makeMessage('/status'), platform: 'telegram' })

      const out = adapter.sent.at(-1) ?? ''
      expect(out).toContain('Connection: LiteLLM Proxy')
      expect(out).toContain('Model: default')
      expect(out).not.toContain('agnes') // stale label must not leak through
    })

    it('falls back to a generic default hint when no default connection is configured', async () => {
      const session = makeSession('sess-1', 'Alpha', 100)
      ;(session as unknown as Record<string, unknown>).model = 'agnes-2.5-flash'
      ;(session as unknown as Record<string, unknown>).llmConnection = 'agnes-openai'
      const store = makeStore()
      store.bind('ws1', 'sess-1', 'telegram', 'chan-1', 'Alice')
      const commands = new Commands(
        makeSessionManager([session]),
        store,
        'ws1',
        undefined,
        undefined,
        {
          getWorkspaceConfig: () => ({ enabled: false, platforms: {} }),
          seedOwnerOnFirstPair: async () => [],
          resolveConnection: () => undefined,
          resolveDefaultConnection: () => undefined,
        },
      )
      const adapter = makeAdapter('telegram', true)

      await commands.handleCommand(adapter, { ...makeMessage('/status'), platform: 'telegram' })

      const out = adapter.sent.at(-1) ?? ''
      expect(out).toContain('Connection: (workspace default)')
      expect(out).toContain('Model: (default) (agnes-2.5-flash)')
    })

    it('shows processing status with current activity', async () => {
      const session = makeSession('sess-1', 'Alpha', 100)
      ;(session as unknown as Record<string, unknown>).isProcessing = true
      ;(session as unknown as Record<string, unknown>).currentStatus = { message: 'Reading files' }
      const store = makeStore()
      store.bind('ws1', 'sess-1', 'telegram', 'chan-1', 'Alice')
      const commands = new Commands(makeSessionManager([session]), store, 'ws1')
      const adapter = makeAdapter('telegram', true)

      await commands.handleCommand(adapter, { ...makeMessage('/status'), platform: 'telegram' })

      const out = adapter.sent.at(-1) ?? ''
      expect(out).toContain('Status: processing — Reading files')
    })

    it('omits model lines for legacy sessions without them (binding info still shown)', async () => {
      const session = makeSession('sess-1', 'Legacy', 100)
      const store = makeStore()
      store.bind('ws1', 'sess-1', 'telegram', 'chan-1', 'Alice')
      const commands = new Commands(makeSessionManager([session]), store, 'ws1')
      const adapter = makeAdapter('telegram', true)

      await commands.handleCommand(adapter, { ...makeMessage('/status'), platform: 'telegram' })

      const out = adapter.sent.at(-1) ?? ''
      expect(out).toContain('Bound to "Legacy"')
      expect(out).toContain('Approval:')
      expect(out).not.toContain('Model:')
      expect(out).not.toContain('Thinking:')
      expect(out).toContain('Status: idle')
    })
  })
})
