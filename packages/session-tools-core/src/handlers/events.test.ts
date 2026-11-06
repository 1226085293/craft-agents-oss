import { describe, expect, it } from 'bun:test'
import type { SessionToolContext } from '../context.ts'
import { handleGetEvent } from './events.ts'

function makeCtx(overrides: Partial<SessionToolContext> = {}): SessionToolContext {
  return { sessionId: 'self', ...overrides } as SessionToolContext
}

function textOf(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content.map((c) => c.text ?? '').join('\n')
}

describe('get_event', () => {
  it('shows where the event came from', async () => {
    // A reader that only sees `source: qq` cannot tell a group from a DM, and
    // it fills that gap by guessing — a supervisor described a group message to
    // the user as a private message because the channel was never printed.
    const ctx = makeCtx({
      getEventFn: () => ({
        id: 'evt_1',
        type: 'message.mention',
        source: 'qq',
        receivedAt: 1_800_000_000_000,
        title: '张三 · 在群里提到了你',
        recipients: [],
        links: [{ rel: 'source', url: 'message://qq/group:94A54DAF/ROBOT1.0_x' }],
        body: '测试7',
      }),
    })

    const out = textOf(await handleGetEvent(ctx, { id: 'evt_1' }))

    expect(out).toContain('links:')
    expect(out).toContain('group:94A54DAF')
    expect(out).toContain('测试7')
  })

  it('still reads an event that carries no links', async () => {
    const ctx = makeCtx({
      getEventFn: () => ({
        id: 'evt_2',
        type: 'mail.received',
        source: 'qqmail-idle',
        receivedAt: 1_800_000_000_000,
        title: 'A mail',
        recipients: [],
      }),
    })

    const out = textOf(await handleGetEvent(ctx, { id: 'evt_2' }))

    expect(out).toContain('type: mail.received')
    expect(out).not.toContain('links:')
  })
})
