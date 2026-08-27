import { describe, expect, test } from 'bun:test'

import {
  WeChatAdapter,
  collectAttachments,
  extractBody,
  parseWeChatChannel,
  parseWeChatCredentials,
} from '../adapters/wechat/index'

describe('WeChat — parseWeChatCredentials', () => {
  test('parses a full credential JSON', () => {
    const creds = parseWeChatCredentials(
      JSON.stringify({ botToken: 'tok123', baseUrl: 'https://ilinkai.weixin.qq.com', botId: 'bot1', userId: 'wxu_1' }),
    )
    expect(creds.botToken).toBe('tok123')
    expect(creds.baseUrl).toBe('https://ilinkai.weixin.qq.com')
    expect(creds.botId).toBe('bot1')
    expect(creds.userId).toBe('wxu_1')
  })

  test('defaults baseUrl when omitted', () => {
    const creds = parseWeChatCredentials(JSON.stringify({ botToken: 'tok' }))
    expect(creds.baseUrl).toBe('https://ilinkai.weixin.qq.com')
  })

  test('throws on missing botToken', () => {
    expect(() => parseWeChatCredentials(JSON.stringify({ baseUrl: 'x' }))).toThrow(/botToken/)
  })

  test('throws on non-JSON input', () => {
    expect(() => parseWeChatCredentials('not-json')).toThrow(/malformed/)
  })
})

describe('WeChat — parseWeChatChannel', () => {
  test('parses group channel', () => {
    expect(parseWeChatChannel('group:g123')).toEqual({ kind: 'group', id: 'g123' })
  })
  test('parses private channel', () => {
    expect(parseWeChatChannel('private:wxu_1')).toEqual({ kind: 'private', id: 'wxu_1' })
  })
  test('falls back to private for bare id', () => {
    expect(parseWeChatChannel('wxu_1')).toEqual({ kind: 'private', id: 'wxu_1' })
  })
})

describe('WeChat — extractBody', () => {
  test('extracts text item', () => {
    expect(extractBody([{ type: 1, text_item: { text: 'hello' } }])).toBe('hello')
  })

  test('uses voice auto-transcription', () => {
    expect(extractBody([{ type: 3, voice_item: { text: '语音转文字' } }])).toBe('语音转文字')
  })

  test('builds quoted context', () => {
    const body = extractBody([
      {
        type: 1,
        text_item: { text: '回复内容' },
        ref_msg: { title: '原始消息', message_item: { type: 1, text_item: { text: '被引用' } } },
      },
    ])
    expect(body).toBe('[引用: 原始消息 | 被引用]\n回复内容')
  })

  test('returns empty for no items', () => {
    expect(extractBody(undefined)).toBe('')
  })
})

describe('WeChat — collectAttachments', () => {
  test('collects image/video/file/voice items', () => {
    const atts = collectAttachments({
      message_id: 42,
      item_list: [
        { type: 2, msg_id: 'i1' },
        { type: 5, msg_id: 'v1' },
        { type: 4, msg_id: 'f1', file_item: { file_name: 'a.pdf' } },
        { type: 3, msg_id: 'a1' },
      ],
    })
    expect(atts).toHaveLength(4)
    expect(atts[0]).toEqual({ type: 'photo', fileId: 'i1' })
    expect(atts[1]).toEqual({ type: 'video', fileId: 'v1' })
    expect(atts[2]).toEqual({ type: 'document', fileId: 'f1', fileName: 'a.pdf' })
    expect(atts[3]).toEqual({ type: 'voice', fileId: 'a1' })
  })

  test('falls back to message_id-based fileId', () => {
    const atts = collectAttachments({ message_id: 7, item_list: [{ type: 2 }] })
    expect(atts.length).toBeGreaterThan(0)
    expect(atts[0]!.fileId).toBe('img:7')
  })
})

describe('WeChat — capabilities', () => {
  test('adapter platform is wechat with no inline buttons', () => {
    const adapter = new WeChatAdapter()
    expect(adapter.platform).toBe('wechat')
    expect(adapter.capabilities.inlineButtons).toBe(false)
    expect(adapter.capabilities.messageEditing).toBe(false)
    expect(adapter.capabilities.markdown).toBe('v2')
    expect(adapter.isConnected()).toBe(false)
  })
})
