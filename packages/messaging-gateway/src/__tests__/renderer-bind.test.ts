/**
 * Renderer behaviours around session binding / channel rebinding.
 *
 * Channel rebind (one channel → one session) destroys the old binding. The
 * renderer must clean up after it:
 *
 * - `removeBinding(binding, adapter)` deletes the evicted binding's posted
 *   transient bubbles (progress "thinking…" / streaming partials) so the chat
 *   doesn't keep stale remnants that nothing will ever edit again, and drops
 *   its persisted progress record.
 * - `primeProgressForBinding(binding, adapter)` posts the session's process
 *   bubble immediately when a session is bound mid-run (progress mode), so the
 *   user sees it at once instead of after the next session event + delay.
 */

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Renderer } from '../renderer'
import { normalizeBindingConfig } from '../types'
import type {
  AdapterCapabilities,
  ChannelBinding,
  PlatformAdapter,
  ResponseMode,
  SentMessage,
} from '../types'

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
      return { messageId: `sent-${++counter}` }
    },
    async editMessage(): Promise<void> {},
    async deleteMessage(_channelId: string, messageId: string): Promise<void> {
      deleted.push(messageId)
    },
  } as unknown as PlatformAdapter

  return { adapter, sent, deleted }
}

function createBinding(responseMode: ResponseMode, id = `binding-${responseMode}`): ChannelBinding {
  return {
    id,
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

/** Let the delayed first-progress-bubble timer fire so a bubble exists. */
async function postProgressBubble(renderer: Renderer, binding: ChannelBinding, adapter: PlatformAdapter) {
  await renderer.handle(event('tool_start', { toolName: 'Bash' }), binding, adapter)
  await new Promise((resolve) => setTimeout(resolve, 1500))
}

describe('renderer — removeBinding (binding evicted on channel rebind)', () => {
  it("deletes the evicted binding's posted progress bubble and drops its persisted state", async () => {
    const progressStateFile = join(mkdtempSync(join(tmpdir(), 'render-bind-')), 'render-state.json')
    const { adapter, sent, deleted } = createAdapter()
    const renderer = new Renderer({ progressStateFile })
    const binding = createBinding('progress')

    await postProgressBubble(renderer, binding, adapter)
    expect(sent.length).toBeGreaterThan(0)
    expect(deleted).toEqual([])

    // Simulated eviction: the channel is rebound to a different session.
    const evicted = createBinding('progress', binding.id)
    await renderer.removeBinding(evicted, adapter)

    expect(deleted.length).toBeGreaterThan(0)
    // The persisted record is gone, so a restart can't resurrect the bubble.
    // The renderer removes the whole state file once the last record is gone.
    const persisted = existsSync(progressStateFile)
      ? JSON.parse(readFileSync(progressStateFile, 'utf-8'))
      : { progressMessages: {} }
    expect(persisted.progressMessages?.[binding.id]).toBeUndefined()
  })

  it('deletes a posted streaming partial on eviction', async () => {
    const { adapter, sent, deleted } = createAdapter()
    const renderer = new Renderer()
    const binding = createBinding('streaming')

    await renderer.handle(event('text_delta', { delta: 'partial think' }), binding, adapter)
    expect(sent.length).toBe(1)

    await renderer.removeBinding(binding, adapter)

    expect(deleted).toContain('sent-1')
  })

  it('no-ops safely when the evicted binding never posted anything', async () => {
    const { adapter, deleted } = createAdapter()
    const renderer = new Renderer()
    const binding = createBinding('final_only')

    await renderer.removeBinding(binding, adapter)

    expect(deleted).toEqual([])
  })
})

describe('renderer — primeProgressForBinding (bind mid-run shows process at once)', () => {
  it('progress: posts the thinking bubble immediately without waiting for a session event', async () => {
    const { adapter, sent } = createAdapter()
    const renderer = new Renderer()
    const binding = createBinding('progress')

    await renderer.primeProgressForBinding(binding, adapter)

    // No events, no delay — the bubble is already visible.
    expect(sent.some((s) => s.text.includes('thinking'))).toBe(true)
  })

  it('progress: does not double-post when a bubble already exists', async () => {
    const { adapter, sent } = createAdapter()
    const renderer = new Renderer()
    const binding = createBinding('progress')

    await postProgressBubble(renderer, binding, adapter)
    const countBefore = sent.length

    await renderer.primeProgressForBinding(binding, adapter)

    expect(sent.length).toBe(countBefore)
  })

  it('is a no-op for streaming and final_only modes (their own output renders)', async () => {
    for (const mode of ['streaming', 'final_only'] as const) {
      const { adapter, sent } = createAdapter()
      const renderer = new Renderer()
      const binding = createBinding(mode)
      await renderer.primeProgressForBinding(binding, adapter)
      expect(sent).toEqual([])
    }
  })

  it('is a no-op on adapters without message editing (WhatsApp-style)', async () => {
    const { adapter, sent } = createAdapter(/* messageEditing */ false)
    const renderer = new Renderer()
    const binding = createBinding('progress')
    await renderer.primeProgressForBinding(binding, adapter)
    expect(sent).toEqual([])
  })
})