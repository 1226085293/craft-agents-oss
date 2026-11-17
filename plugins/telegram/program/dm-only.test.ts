/**
 * Tests for the Telegram adapter's chat acceptance and host menu registration.
 *
 * Exercising the real grammY Bot#on handlers requires network access
 * (getUpdates polling) and is wasteful for what's effectively a
 * `ctx.chat.type` check. Instead we unit-test the exported predicates and
 * the host-menu mechanism directly, and rely on typecheck + code review to
 * confirm each handler calls them.
 */
import { describe, it, expect, mock, afterEach } from 'bun:test'
import type { Context } from 'grammy'
import {
  TelegramAdapter,
  isPrivateChat,
  fetchHostSlashCommands,
  registerHostSlashCommands,
  type TelegramCommandApi,
} from './index'

function ctxWithChatType(type: string | undefined): Context {
  return { chat: type ? { type } : undefined } as unknown as Context
}

describe('isPrivateChat', () => {
  it('accepts private chats', () => {
    expect(isPrivateChat(ctxWithChatType('private'))).toBe(true)
  })

  it('rejects group chats', () => {
    expect(isPrivateChat(ctxWithChatType('group'))).toBe(false)
  })

  it('rejects supergroups', () => {
    expect(isPrivateChat(ctxWithChatType('supergroup'))).toBe(false)
  })

  it('rejects channels', () => {
    expect(isPrivateChat(ctxWithChatType('channel'))).toBe(false)
  })

  it('rejects contexts without a chat', () => {
    expect(isPrivateChat(ctxWithChatType(undefined))).toBe(false)
  })
})

describe('TelegramAdapter inbound dispatch', () => {
  it('does not wait for a long-running message handler', async () => {
    const adapter = new TelegramAdapter()
    let release!: () => void
    let completed = false

    adapter.onMessage(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      completed = true
    })

    // The adapter's inbound message shape, minus the gateway types the work
    // used to import from: only the fields dispatch touches matter here.
    const msg = {
      platform: 'telegram',
      channelId: 'chat-a',
      messageId: '1',
      senderId: 'user-a',
      text: 'hello',
      timestamp: Date.now(),
      raw: {},
    }

    ;(adapter as unknown as { dispatchMessage(msg: unknown): void }).dispatchMessage(msg)

    expect(completed).toBe(false)
    await new Promise((resolve) => setImmediate(resolve))
    expect(completed).toBe(false)
    release()
    await Promise.resolve()
    expect(completed).toBe(true)
  })
})

describe('host slash command menu registration', () => {
  const savedUrl = process.env.CRAFT_EVENTS_URL
  const savedToken = process.env.CRAFT_EVENTS_TOKEN
  let originalFetch: typeof fetch

  afterEach(() => {
    if (savedUrl === undefined) delete process.env.CRAFT_EVENTS_URL
    else process.env.CRAFT_EVENTS_URL = savedUrl
    if (savedToken === undefined) delete process.env.CRAFT_EVENTS_TOKEN
    else process.env.CRAFT_EVENTS_TOKEN = savedToken
    globalThis.fetch = originalFetch
  })

  it('fetches the host catalogue and registers it as menu entries', async () => {
    process.env.CRAFT_EVENTS_URL = 'http://127.0.0.1:9999'
    process.env.CRAFT_EVENTS_TOKEN = 'test-token'
    originalFetch = globalThis.fetch
    globalThis.fetch = mock(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:9999/host/slash_commands')
      expect((init?.headers as Record<string, string>)?.authorization).toBe('Bearer test-token')
      return new Response(
        JSON.stringify({
          ok: true,
          result: [
            { name: 'stop', description: 'Stop the current run' },
            { name: 'help', description: 'List available commands' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch

    const setMyCommands = mock(async () => true as const)
    const count = await registerHostSlashCommands({ setMyCommands } as unknown as TelegramCommandApi)

    expect(count).toBe(2)
    expect(setMyCommands).toHaveBeenCalledTimes(1)
    expect(setMyCommands.mock.calls[0]?.[0]).toEqual([
      { command: 'stop', description: 'Stop the current run' },
      { command: 'help', description: 'List available commands' },
    ])
  })

  it('truncates menu descriptions to the Bot API limit', async () => {
    process.env.CRAFT_EVENTS_URL = 'http://127.0.0.1:9999'
    process.env.CRAFT_EVENTS_TOKEN = 'test-token'
    originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          result: [{ name: 'x', description: 'a description far longer than twenty-five characters' }],
        }),
        { status: 200 },
      ),
    ) as typeof fetch

    const setMyCommands = mock(async () => true as const)
    const commands = setMyCommands.mock as unknown as { calls: unknown[][] }
    await registerHostSlashCommands({ setMyCommands } as unknown as TelegramCommandApi)
    const registered = commands.calls[0]?.[0] as Array<{ command: string; description: string }>
    expect(registered[0].description.length).toBeLessThanOrEqual(25)
  })

  it('registers an empty menu when the host is unreachable', async () => {
    process.env.CRAFT_EVENTS_URL = 'http://127.0.0.1:1'
    process.env.CRAFT_EVENTS_TOKEN = 'test-token'
    originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => {
      throw new Error('connection refused')
    }) as typeof fetch

    const setMyCommands = mock(async () => true as const)
    const count = await registerHostSlashCommands({ setMyCommands } as unknown as TelegramCommandApi)

    expect(count).toBe(0)
    expect(setMyCommands.mock.calls[0]?.[0]).toEqual([])
  })

  it('registers an empty menu when the host answers non-ok', async () => {
    process.env.CRAFT_EVENTS_URL = 'http://127.0.0.1:9999'
    process.env.CRAFT_EVENTS_TOKEN = 'wrong'
    originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })) as typeof fetch

    const setMyCommands = mock(async () => true as const)
    const count = await registerHostSlashCommands({ setMyCommands } as unknown as TelegramCommandApi)

    expect(count).toBe(0)
    expect(setMyCommands.mock.calls[0]?.[0]).toEqual([])
  })

  it('registers an empty menu without host credentials', async () => {
    delete process.env.CRAFT_EVENTS_URL
    delete process.env.CRAFT_EVENTS_TOKEN

    const fetched = await fetchHostSlashCommands()
    expect(fetched).toEqual([])
  })
})
