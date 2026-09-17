import { describe, expect, it } from 'bun:test'
import { buildActivityRenderKeys, groupMessagesByTurn } from '../turn-utils'
import type { ActivityItem } from '../TurnCard'
import type { Message } from '@craft-agent/core'

function activity(over: Partial<ActivityItem> & { id: string }): ActivityItem {
  return {
    type: 'intermediate',
    status: 'running',
    content: '',
    timestamp: 0,
    ...over,
  } as ActivityItem
}

describe('buildActivityRenderKeys', () => {
  it('keeps the render key stable across the pending -> authoritative id swap', () => {
    // Same text block: renderer-generated id while streaming, main-process id
    // after text_complete. The key must not change or the row remounts.
    const pending = activity({ id: 'msg-renderer-1', turnId: 'pi-turn-2__m0' })
    const completed = activity({
      id: 'msg-authoritative-9',
      turnId: 'pi-turn-2__m0',
      status: 'completed',
      content: 'done',
    })

    const pendingKeys = buildActivityRenderKeys([pending])
    const completedKeys = buildActivityRenderKeys([completed])

    expect(pendingKeys.get(pending)).toBe('intermediate:pi-turn-2__m0')
    expect(completedKeys.get(completed)).toBe('intermediate:pi-turn-2__m0')
  })

  it('falls back to the activity id when no turnId is present', () => {
    const plain = activity({ id: 'msg-legacy-1' })
    expect(buildActivityRenderKeys([plain]).get(plain)).toBe('msg-legacy-1')
  })

  it('uses the activity id for non-intermediate rows', () => {
    const tool = {
      id: 'msg-tool-1',
      type: 'tool',
      status: 'running',
      toolName: 'Bash',
      timestamp: 0,
    } as ActivityItem
    expect(buildActivityRenderKeys([tool]).get(tool)).toBe('msg-tool-1')
  })

  it('disambiguates repeated turnIds by occurrence order so keys stay unique', () => {
    // Reasoning blocks between tool calls can reuse a correlation id; keys must
    // still be unique within one list.
    const first = activity({ id: 'msg-a', turnId: 'pi-turn-1__m0' })
    const tool = {
      id: 'msg-b',
      type: 'tool',
      status: 'running',
      toolName: 'Bash',
      timestamp: 1,
    } as ActivityItem
    const second = activity({ id: 'msg-c', turnId: 'pi-turn-1__m0' })

    const keys = buildActivityRenderKeys([first, tool, second])
    const values = [keys.get(first), keys.get(tool), keys.get(second)]

    expect(values[0]).toBe('intermediate:pi-turn-1__m0')
    expect(values[1]).toBe('msg-b')
    expect(values[2]).toBe('intermediate:pi-turn-1__m0#1')
    expect(new Set(values).size).toBe(3)
  })
})

describe('render keys survive the text_complete id swap in the turn pipeline', () => {
  const userMessage = {
    id: 'user-1',
    role: 'user',
    content: 'go',
    timestamp: 1,
  } as Message

  it('pending and completed versions of one text block map to the same key', () => {
    const pendingTurn = groupMessagesByTurn(
      [
        userMessage,
        {
          id: 'msg-renderer-1',
          role: 'assistant',
          content: 'Let me look',
          timestamp: 2,
          isStreaming: true,
          isPending: true,
          turnId: 'pi-turn-2__m0',
        } as Message,
      ],
      {}
    )
    const completedTurn = groupMessagesByTurn(
      [
        userMessage,
        {
          id: 'msg-authoritative-9',
          role: 'assistant',
          content: 'Let me look',
          timestamp: 2,
          isIntermediate: true,
          turnId: 'pi-turn-2__m0',
        } as Message,
      ],
      {}
    )

    const pendingActivities = (pendingTurn[1] as { activities: ActivityItem[] }).activities
    const completedActivities = (completedTurn[1] as { activities: ActivityItem[] }).activities
    expect(pendingActivities).toHaveLength(1)
    expect(completedActivities).toHaveLength(1)

    const pendingKeys = buildActivityRenderKeys(pendingActivities)
    const completedKeys = buildActivityRenderKeys(completedActivities)

    expect(completedActivities[0].turnId).toBe('pi-turn-2__m0')
    expect(pendingKeys.get(pendingActivities[0])).toBe(
      completedKeys.get(completedActivities[0])
    )
  })
})
