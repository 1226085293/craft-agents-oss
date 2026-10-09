import { describe, expect, it } from 'bun:test'
import { canOpenActivityDetails } from '../turn-utils'
import type { ActivityItem } from '../TurnCard'

function activity(over: Partial<ActivityItem> & { id: string }): ActivityItem {
  return {
    type: 'intermediate',
    status: 'running',
    content: '',
    timestamp: 0,
    ...over,
  } as ActivityItem
}

describe('canOpenActivityDetails', () => {
  it('opens a STREAMING intermediate row (live Thinking... step)', () => {
    const streamingThinking = activity({ id: 'thinking-live', status: 'running', content: 'partial reasoning…' })
    expect(canOpenActivityDetails(streamingThinking)).toBe(true)
  })

  it('opens a completed intermediate row', () => {
    const doneThinking = activity({ id: 'thinking-done', status: 'completed', content: 'full reasoning text' })
    expect(canOpenActivityDetails(doneThinking)).toBe(true)
  })

  it('opens a completed tool row', () => {
    const doneTool = activity({ id: 'tool-done', type: 'tool', status: 'completed' })
    expect(canOpenActivityDetails(doneTool)).toBe(true)
  })

  it('does NOT open a running tool row', () => {
    const runningTool = activity({ id: 'tool-running', type: 'tool', status: 'running' })
    expect(canOpenActivityDetails(runningTool)).toBe(false)
  })

  it('does NOT open a failed/error row', () => {
    const failedThinking = activity({ id: 'thinking-failed', status: 'error' })
    expect(canOpenActivityDetails(failedThinking)).toBe(false)
  })
})