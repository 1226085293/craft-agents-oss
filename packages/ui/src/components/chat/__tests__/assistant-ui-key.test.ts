import { describe, expect, it } from 'bun:test'
import { getAssistantTurnUiKey, type AssistantTurn } from '../turn-utils'

function makeAssistantTurn(overrides: Partial<AssistantTurn> = {}): AssistantTurn {
  return {
    type: 'assistant',
    turnId: 'pi-turn-1',
    activities: [],
    response: undefined,
    intent: undefined,
    isStreaming: false,
    isComplete: true,
    timestamp: 123,
    ...overrides,
  }
}

describe('getAssistantTurnUiKey', () => {
  it('uses response message id when available', () => {
    const turn = makeAssistantTurn({
      response: {
        text: 'Done',
        isStreaming: false,
        messageId: 'msg-final-1',
      },
    })

    expect(getAssistantTurnUiKey(turn, 0)).toBe('assistant:msg:msg-final-1')
  })

  it('uses the actual final response message id even when the turn has intermediate activity', () => {
    const turn = makeAssistantTurn({
      activities: [
        {
          id: 'intermediate-msg',
          type: 'intermediate',
          status: 'completed',
          content: '我先检查一下',
          timestamp: 789,
        } as any,
      ],
      response: {
        text: '任务完成',
        isStreaming: false,
        messageId: 'final-msg',
      },
    })

    expect(getAssistantTurnUiKey(turn, 1)).toBe('assistant:msg:final-msg')
  })

  it('uses msg-based key when the turn also contains intermediate activity', () => {
    const turn = makeAssistantTurn({
      activities: [
        {
          id: 'tool-1',
          type: 'tool',
          status: 'completed',
          toolName: 'Bash',
          timestamp: 200,
        } as any,
      ],
      response: {
        text: '任务完成',
        isStreaming: false,
        messageId: 'final-msg-1',
      },
    })

    // Normal response: key should use the stable msg-based format
    expect(getAssistantTurnUiKey(turn, 0)).toBe('assistant:msg:final-msg-1')
  })

  it('disambiguates split cards with same turnId/timestamp via index fallback', () => {
    const turnA = makeAssistantTurn({ turnId: 'pi-turn-1', timestamp: 555 })
    const turnB = makeAssistantTurn({ turnId: 'pi-turn-1', timestamp: 555 })

    const keyA = getAssistantTurnUiKey(turnA, 2)
    const keyB = getAssistantTurnUiKey(turnB, 3)

    expect(keyA).not.toBe(keyB)
    expect(keyA).toBe('assistant:turn:pi-turn-1:555:2')
    expect(keyB).toBe('assistant:turn:pi-turn-1:555:3')
  })
})
