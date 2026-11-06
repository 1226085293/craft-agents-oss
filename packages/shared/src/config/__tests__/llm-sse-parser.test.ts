import { describe, expect, it } from 'bun:test'
import { SseFrameParser } from '../llm-sse-parser.ts'

describe('SseFrameParser', () => {
  it('assembles split data and event lines while preserving the raw frame', () => {
    const parser = new SseFrameParser()
    expect(parser.push(new TextEncoder().encode('event: content_block_delta\ndata: {"type":"content_'))).toEqual([])
    const frames = parser.push(new TextEncoder().encode('block_delta"}\n\n'))
    expect(frames).toEqual([{ event: 'content_block_delta', data: '{"type":"content_block_delta"}', raw: 'event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n' }])
  })

  it('ignores comment heartbeat frames and accepts CRLF', () => {
    const parser = new SseFrameParser()
    const frames = parser.push(new TextEncoder().encode(': keepalive\r\n\r\nevent: ping\r\ndata: {"type":"ping"}\r\n\r\n'))
    expect(frames).toEqual([{ event: 'ping', data: '{"type":"ping"}', raw: 'event: ping\r\ndata: {"type":"ping"}\r\n\r\n' }])
  })

  it('flushes a final frame without a blank-line terminator', () => {
    const parser = new SseFrameParser()
    parser.push(new TextEncoder().encode('event: error\ndata: {"message":"failed"}'))
    expect(parser.finish()).toEqual([{ event: 'error', data: '{"message":"failed"}', raw: 'event: error\ndata: {"message":"failed"}' }])
  })
})
