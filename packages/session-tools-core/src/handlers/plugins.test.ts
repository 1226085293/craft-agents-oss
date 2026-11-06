import { describe, expect, it } from 'bun:test'

import type { SessionToolContext } from '../context.ts'
import { handleListPluginActions, handlePluginCall } from './plugins.ts'

function makeCtx(overrides: Partial<SessionToolContext> = {}): SessionToolContext {
  return { sessionId: 'self', ...overrides } as SessionToolContext
}

function textOf(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content.map((c) => c.text ?? '').join('\n')
}

describe('plugin actions', () => {
  it('lists what an installed plugin can do, with its argument schema', async () => {
    const ctx = makeCtx({
      listPluginActionsFn: () => [
        {
          plugin: 'messaging',
          name: 'send_message',
          description: '往指定会话发一条文本消息',
          input: {
            type: 'object',
            properties: { channelId: { type: 'string', description: '群为 group:<id>' } },
            required: ['channelId'],
          },
        },
      ],
    })

    const out = textOf(await handleListPluginActions(ctx))

    expect(out).toContain('messaging.send_message')
    expect(out).toContain('group:<id>')
    expect(out).toContain('plugin_call')
  })

  it('marks a reply action as taking its destination from the event', async () => {
    // The model cannot know an openid, so the listing has to say the target is
    // implied — otherwise it invents a channel and the answer goes elsewhere.
    const ctx = makeCtx({
      listPluginActionsFn: () => [
        {
          plugin: 'messaging',
          name: 'reply',
          description: '回复触发本次判断的消息',
          repliesToOrigin: true,
          input: { type: 'object', properties: { text: { type: 'string' } } },
        },
      ],
    })

    const out = textOf(await handleListPluginActions(ctx))

    expect(out).toContain('do not pass a destination')
  })

  it('says so plainly when no plugin is installed', async () => {
    const ctx = makeCtx({ listPluginActionsFn: () => [] })
    const out = textOf(await handleListPluginActions(ctx))
    expect(out).toContain('No plugin actions')
  })

  it('dispatches a call through the host and reports success', async () => {
    let received: { plugin: string; action: string; args: Record<string, unknown> } | undefined
    const ctx = makeCtx({
      callPluginActionFn: async (params) => {
        received = params
        return { ok: true, message: `已发送到 ${params.args.channelId}` }
      },
    })

    const res = await handlePluginCall(ctx, {
      plugin: 'messaging',
      action: 'send_message',
      args: { channelId: 'group:1', text: 'hi' },
    })

    expect(res.isError).toBeFalsy()
    expect(textOf(res)).toContain('group:1')
    expect(received?.plugin).toBe('messaging')
    expect(received?.args.text).toBe('hi')
  })

  it('surfaces a host failure as an error result, not a silent success', async () => {
    const ctx = makeCtx({
      callPluginActionFn: async () => ({ ok: false, message: '没有可回复的来源' }),
    })

    const res = await handlePluginCall(ctx, { plugin: 'messaging', action: 'reply', args: { text: 'x' } })

    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('没有可回复的来源')
  })

  it('requires both plugin and action', async () => {
    const ctx = makeCtx({ callPluginActionFn: async () => ({ ok: true, message: 'unused' }) })

    expect((await handlePluginCall(ctx, { plugin: 'messaging' })).isError).toBe(true)
    expect((await handlePluginCall(ctx, { action: 'reply' })).isError).toBe(true)
  })
})
