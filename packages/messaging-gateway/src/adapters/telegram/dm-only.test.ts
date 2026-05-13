/**
 * Tests for the DM-only guard in the Telegram adapter.
 *
 * Exercising the real grammY Bot#on handlers requires network access
 * (getUpdates polling) and is wasteful for what's effectively a
 * `ctx.chat.type === 'private'` check. Instead we unit-test the exported
 * `isPrivateChat` predicate directly — it's the single source of truth
 * used by every handler — and rely on typecheck + code review to confirm
 * each handler calls it.
 */
import { describe, it, expect, mock } from 'bun:test'
import type { Context } from 'grammy'
import type { IncomingMessage } from '../../types'
import {
  TELEGRAM_BOT_COMMANDS,
  TelegramAdapter,
  isPrivateChat,
  registerTelegramBotCommands,
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

    const msg: IncomingMessage = {
      platform: 'telegram',
      channelId: 'chat-a',
      messageId: '1',
      senderId: 'user-a',
      text: 'hello',
      timestamp: Date.now(),
      raw: {},
    }

    ;(adapter as unknown as { dispatchMessage(msg: IncomingMessage): void }).dispatchMessage(msg)

    expect(completed).toBe(false)
    await new Promise((resolve) => setImmediate(resolve))
    expect(completed).toBe(false)
    release()
    await Promise.resolve()
    expect(completed).toBe(true)
  })
})

describe('Telegram bot command registration', () => {
  it('publishes clear in Telegram slash suggestions', async () => {
    const setMyCommands = mock(async (
      _commands: Parameters<TelegramCommandApi['setMyCommands']>[0],
    ) => true as const)

    await registerTelegramBotCommands({ setMyCommands })

    expect(setMyCommands).toHaveBeenCalledTimes(1)
    const registered = setMyCommands.mock.calls[0]?.[0] ?? []
    expect(registered).toEqual(TELEGRAM_BOT_COMMANDS)
    expect(registered).toContainEqual({
      command: 'clear',
      description: 'Clear current context',
    })
  })
})
