/**
 * Renderer behaviour for system-stop notices.
 *
 * When a guardrail in the agent host (busy-limit tool-call cap, no-progress
 * repeat streak) aborts a turn, the user never pressed Stop — so the channel
 * must be told WHY the session went quiet instead of staying silent. These
 * tests pin:
 *
 * 1. A standalone "stopped by the system" notice is delivered on every bound
 *    channel, in all response modes (mode-agnostic, like errors).
 * 2. The trailing `complete` of the aborted run delivers no stale text
 *    (the run has no result, same rule as user interruptions).
 * 3. A transient progress bubble left on the channel is retracted.
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
      return { messageId: `sent-${++counter}` } as SentMessage
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

function stopNotice() {
  return event('system_stop_notice', {
    reason: 'busy_limit',
    message: 'Turn aborted: exceeded 500 tool calls in a single turn (busy-limit guardrail).',
  })
}

const notices = (sent: Sent[]) => sent.filter(s => s.text.includes('Agent stopped this turn'))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('renderer — system stop notice delivery', () => {
  for (const mode of ['progress', 'final_only', 'streaming'] as const) {
    it(`${mode}: posts a standalone notice with the machine reason on the channel`, async () => {
      const { adapter, sent } = createAdapter()
      const renderer = new Renderer()
      const binding = createBinding(mode)

      await renderer.handle(stopNotice(), binding, adapter)

      expect(notices(sent)).toHaveLength(1)
      expect(notices(sent)![0]!.text).toContain('busy_limit')
      expect(notices(sent)![0]!.text).toContain('500 tool calls')
      expect(notices(sent)![0]!.text).toContain('continue')
    })
  }

  it('the trailing complete of the aborted run delivers no stale text', async () => {
    const { adapter, sent } = createAdapter()
    const renderer = new Renderer()
    const binding = createBinding('final_only')

    // A real in-progress buffer existed before the guardrail killed the turn.
    await renderer.handle(
      event('text_complete', { text: 'intermediate thinking', isIntermediate: true }),
      binding,
      adapter
    )
    await renderer.handle(stopNotice(), binding, adapter)
    const before = sent.length
    await renderer.handle(event('complete'), binding, adapter)

    const stale = sent.slice(before).filter(s => s.text.includes('intermediate thinking'))
    expect(stale).toEqual([])
  })

  it('progress: retracts the transient progress bubble when the stop notice arrives', async () => {
    const { adapter, sent, deleted } = createAdapter()
    const renderer = new Renderer()
    const binding = createBinding('progress')

    await renderer.handle(event('tool_start', { toolName: 'Bash' }), binding, adapter)
    // Let the delayed first-bubble timer fire so a progress message exists.
    await new Promise(resolve => setTimeout(resolve, 1500))
    expect(sent.length).toBeGreaterThan(0)
    expect(deleted).toEqual([])

    await renderer.handle(stopNotice(), binding, adapter)
    expect(deleted.length).toBeGreaterThan(0)
    // The standalone notice is still delivered.
    expect(notices(sent)).toHaveLength(1)
  })

  it('falls back to generic fields when the notice omits them', async () => {
    const { adapter, sent } = createAdapter()
    const renderer = new Renderer()
    const binding = createBinding('progress')

    await renderer.handle(event('system_stop_notice'), binding, adapter)

    expect(notices(sent)).toHaveLength(1)
    expect(notices(sent)![0]!.text).toContain('(system)')
    expect(notices(sent)![0]!.text).toContain('Turn stopped by the system.')
  })
})
