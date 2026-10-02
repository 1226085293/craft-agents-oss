/**
 * Renderer behaviour for interrupted runs.
 *
 * A run the user cuts short (Stop button, or a mid-stream redirect) has no
 * result. The gateway's `complete` handler exists to rescue runs that ended on
 * a tool call by falling back to the last assistant text — but applied to an
 * interrupted run that fallback delivers unfinished "thinking" commentary as
 * if it were the answer, which is exactly what the desktop app is careful not
 * to do. These tests pin the gateway to the same rule across all three
 * response modes.
 */

import { describe, it, expect } from 'bun:test'
import { Renderer } from '../renderer'
import { normalizeBindingConfig } from '../types'
import type {
  AdapterCapabilities,
  ChannelBinding,
  PlatformAdapter,
  ResponseMode,
  SentMessage,
} from '../types'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface Sent {
  text: string
}

/** @param messageEditing Platforms with editing can evolve one bubble in place. */
function createAdapter(messageEditing = true) {
  const sent: Sent[] = []
  const deleted: string[] = []
  let counter = 0

  const capabilities: AdapterCapabilities = {
    messageEditing,
    inlineButtons: true,
    maxButtons: 8,
    maxMessageLength: 4096,
    markdown: 'v2',
    webhookSupport: false,
  }

  const adapter = {
    platform: 'telegram',
    capabilities,
    async sendText(_channelId: string, text: string): Promise<SentMessage> {
      sent.push({ text })
      return { messageId: `sent-${++counter}` }
    },
    async editMessage(): Promise<void> {},
    async deleteMessage(_channelId: string, messageId: string): Promise<void> {
      deleted.push(messageId)
    },
  } as unknown as PlatformAdapter

  return { adapter, sent, deleted }
}

function createBinding(responseMode: ResponseMode): ChannelBinding {
  return {
    id: `binding-${responseMode}`,
    workspaceId: 'ws-1',
    sessionId: 'session-1',
    platform: 'telegram',
    channelId: 'chat-1',
    enabled: true,
    createdAt: 1,
    config: normalizeBindingConfig('telegram', { responseMode }),
  }
}

function event(type: string, extra: Record<string, unknown> = {}) {
  return { type, sessionId: 'session-1', ...extra }
}

/** Reply-shaped text, i.e. what the `complete` fallback would deliver. */
const THINKING_TEXT = 'Let me look at the file first'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('renderer — interrupted runs produce no response', () => {
  // progress and final_only both hold the run's text in `finalBuffer` /
  // `lastAssistantText` and only deliver it from `complete`. On an
  // interruption that held text is commentary, not an answer.
  for (const mode of ['progress', 'final_only'] as const) {
    it(`${mode}: the run's last "thinking" text is not delivered as the answer`, async () => {
      const { adapter, sent } = createAdapter()
      const renderer = new Renderer()
      const binding = createBinding(mode)

      // text_complete with isIntermediate=true is what feeds the fallback buffers.
      await renderer.handle(
        event('text_complete', { text: THINKING_TEXT, isIntermediate: true }),
        binding,
        adapter
      )
      await renderer.handle(event('interrupted'), binding, adapter)
      await renderer.handle(event('complete'), binding, adapter)

      expect(sent.filter(s => s.text.includes(THINKING_TEXT))).toEqual([])
    })
  }

  it('streaming: the trailing complete does not flush the undelivered buffer', async () => {
    // Without message editing, streaming mode just accumulates deltas and
    // flushes whatever is left at `complete`. After an interrupt there is
    // nothing to flush.
    const { adapter, sent } = createAdapter(/* messageEditing */ false)
    const renderer = new Renderer()
    const binding = createBinding('streaming')

    await renderer.handle(event('text_delta', { delta: THINKING_TEXT }), binding, adapter)
    await renderer.handle(event('interrupted'), binding, adapter)
    await renderer.handle(event('complete'), binding, adapter)

    expect(sent).toEqual([])
  })

  it('streaming: a clean run still flushes the undelivered buffer', async () => {
    // Control for the case above — only interruption suppresses the flush.
    const { adapter, sent } = createAdapter(/* messageEditing */ false)
    const renderer = new Renderer()
    const binding = createBinding('streaming')

    await renderer.handle(event('text_delta', { delta: THINKING_TEXT }), binding, adapter)
    await renderer.handle(event('complete'), binding, adapter)

    expect(sent.some(s => s.text.includes(THINKING_TEXT))).toBe(true)
  })

  it('progress: an interrupted run deletes its transient progress bubble', async () => {
    const { adapter, sent, deleted } = createAdapter()
    const renderer = new Renderer()
    const binding = createBinding('progress')

    await renderer.handle(event('tool_start', { toolName: 'Bash' }), binding, adapter)
    // Let the delayed first-bubble timer fire so a progress message exists.
    await new Promise(resolve => setTimeout(resolve, 1500))
    expect(sent.length).toBeGreaterThan(0)
    expect(deleted).toEqual([])

    await renderer.handle(event('interrupted'), binding, adapter)
    // The "thinking…" bubble is transient — it must not survive the interrupt
    // as the run's apparent outcome.
    expect(deleted.length).toBeGreaterThan(0)
  })

  it('progress: the next run delivers normally after an interrupt (no leak)', async () => {
    const { adapter, sent } = createAdapter()
    const renderer = new Renderer()
    const binding = createBinding('progress')

    await renderer.handle(event('text_complete', { text: THINKING_TEXT, isIntermediate: true }), binding, adapter)
    await renderer.handle(event('interrupted'), binding, adapter)
    await renderer.handle(event('complete'), binding, adapter)
    expect(sent.filter(s => s.text.includes(THINKING_TEXT))).toEqual([])

    // A fresh turn starts. Event order guarantees the previous run already
    // emitted either `complete` or `user_message`, never both.
    await renderer.handle(event('user_message', { message: 'try again' }), binding, adapter)
    await renderer.handle(event('text_complete', { text: 'here you go', isIntermediate: false }), binding, adapter)
    await renderer.handle(event('complete'), binding, adapter)

    expect(sent.some(s => s.text.includes('here you go'))).toBe(true)
  })

  it('progress: a silent redirect without a trailing complete still unblocks the next run', async () => {
    // When a queued message takes the aborted run's place, SessionManager calls
    // processNextQueuedMessage instead of emitting `complete`. The abort marker
    // must be cleared by that run's `user_message`, or the next answer is lost.
    const { adapter, sent } = createAdapter()
    const renderer = new Renderer()
    const binding = createBinding('progress')

    await renderer.handle(event('text_complete', { text: 'abandoned thinking', isIntermediate: true }), binding, adapter)
    await renderer.handle(event('interrupted'), binding, adapter)
    // No `complete` here — this is the queued-replay path.
    await renderer.handle(event('user_message', { message: 'actually, do this' }), binding, adapter)
    await renderer.handle(event('text_complete', { text: 'real answer', isIntermediate: false }), binding, adapter)
    await renderer.handle(event('complete'), binding, adapter)

    expect(sent.some(s => s.text.includes('abandoned thinking'))).toBe(false)
    expect(sent.some(s => s.text.includes('real answer'))).toBe(true)
  })

  it('progress: a clean run still falls back to the last assistant text', async () => {
    // Regression guard: the tool-terminated-run rescue (PR #779) must survive.
    // Only interruption suppresses it.
    const { adapter, sent } = createAdapter()
    const renderer = new Renderer()
    const binding = createBinding('progress')

    await renderer.handle(event('text_complete', { text: 'tool-terminated note', isIntermediate: true }), binding, adapter)
    await renderer.handle(event('complete'), binding, adapter)

    expect(sent.some(s => s.text.includes('tool-terminated note'))).toBe(true)
  })

  it('erroring: still reports the failure, and the trailing complete stays silent', async () => {
    const { adapter, sent } = createAdapter()
    const renderer = new Renderer()
    const binding = createBinding('progress')

    await renderer.handle(event('text_complete', { text: THINKING_TEXT, isIntermediate: true }), binding, adapter)
    await renderer.handle(event('error', { error: 'boom' }), binding, adapter)
    await renderer.handle(event('complete'), binding, adapter)

    expect(sent.some(s => s.text.includes('❌') && s.text.includes('boom'))).toBe(true)
    expect(sent.some(s => s.text.includes(THINKING_TEXT))).toBe(false)
  })

  it('streaming: the posted partial thinking bubble is retracted on interrupt', async () => {
    // With message editing, streaming mode posts the thinking text live — on
    // interruption that partial is commentary, not a result, so it must be
    // deleted instead of left in the chat looking like an answer.
    const { adapter, sent, deleted } = createAdapter(/* messageEditing */ true)
    const renderer = new Renderer()
    const binding = createBinding('streaming')

    await renderer.handle(event('text_delta', { delta: THINKING_TEXT }), binding, adapter)
    // First delta posts the bubble; the edit timer needs a tick before sending
    // a second delta, but for deletion we only need the ID recorded.
    expect(sent.length).toBe(1)

    await renderer.handle(event('interrupted'), binding, adapter)

    // The partial that was streamed to the chat is retracted — an interrupted
    // run's thinking text is not an answer to leave behind.
    expect(deleted).toContain('sent-1')
  })

  it('streaming: an explicit Stop sends the desktop-parity interruption notice', async () => {
    const { adapter, sent } = createAdapter()
    const renderer = new Renderer()
    const binding = createBinding('streaming')

    await renderer.handle(event('text_delta', { delta: THINKING_TEXT }), binding, adapter)
    await renderer.handle(
      event('interrupted', { message: { content: 'Response interrupted' } }),
      binding,
      adapter
    )

    expect(sent.some(s => s.text.includes('Response interrupted'))).toBe(true)
  })

  it('progress: an explicit Stop sends the desktop-parity interruption notice after deleting the bubble', async () => {
    const { adapter, sent, deleted } = createAdapter()
    const renderer = new Renderer()
    const binding = createBinding('progress')

    await renderer.handle(event('tool_start', { toolName: 'Bash' }), binding, adapter)
    await new Promise(resolve => setTimeout(resolve, 1500))
    expect(sent.length).toBeGreaterThan(0)

    await renderer.handle(
      event('interrupted', { message: { content: 'Response interrupted' } }),
      binding,
      adapter
    )

    // The transient bubble is retracted…
    expect(deleted.length).toBeGreaterThan(0)
    // …and the user gets the interruption notice (desktop parity), not the
    // run's thinking commentary.
    expect(sent.some(s => s.text === '⏹ Response interrupted')).toBe(true)
    expect(sent.filter(s => s.text.includes(THINKING_TEXT))).toEqual([])
  })

  it('progress: a silent redirect (no `message`) posts no interruption notice', async () => {
    const { adapter, sent } = createAdapter()
    const renderer = new Renderer()
    const binding = createBinding('progress')

    await renderer.handle(event('text_complete', { text: THINKING_TEXT, isIntermediate: true }), binding, adapter)
    await renderer.handle(event('interrupted'), binding, adapter)
    await renderer.handle(event('complete'), binding, adapter)

    // Exactly nothing — the desktop shows nothing for a silent redirect either;
    // the new turn's own bubble picks up from here.
    expect(sent.filter(s => s.text.includes(THINKING_TEXT))).toEqual([])
    expect(sent.some(s => s.text.includes('Response interrupted'))).toBe(false)
  })
})
