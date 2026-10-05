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
  it('is based on turn identity (turnId + open timestamp), not on the response', () => {
    const turn = makeAssistantTurn({
      response: {
        text: 'Done',
        isStreaming: false,
        messageId: 'msg-final-1',
      },
    })

    expect(getAssistantTurnUiKey(turn, 0)).toBe('assistant:turn:pi-turn-1:123')
  })

  it('keeps the same key when the response messageId arrives (streaming → landed)', () => {
    // While streaming there is no landed response yet
    const streaming = makeAssistantTurn({
      isStreaming: true,
      isComplete: false,
      activities: [
        {
          id: 'tool-1',
          type: 'tool',
          status: 'completed',
          toolName: 'Bash',
          timestamp: 200,
        } as any,
      ],
    })
    const landed = makeAssistantTurn({
      activities: streaming.activities,
      response: {
        text: '任务完成',
        isStreaming: false,
        messageId: 'final-msg',
      },
    })

    const keyWhileStreaming = getAssistantTurnUiKey(streaming, 0)
    const keyAfterLanded = getAssistantTurnUiKey(landed, 0)

    expect(keyWhileStreaming).toBe(keyAfterLanded)
    expect(keyAfterLanded).toBe('assistant:turn:pi-turn-1:123')
  })

  it('keeps the same key across reverse-pagination index shifts', () => {
    // ChatDisplay renders `turns.slice(startIndex)` and passes the sliced
    // local index; loading more turns grows startIndex and shifts indexes.
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
    })

    expect(getAssistantTurnUiKey(turn, 0)).toBe(getAssistantTurnUiKey(turn, 7))
    expect(getAssistantTurnUiKey(turn, 0)).toBe('assistant:turn:pi-turn-1:123')
  })

  it('keeps the same key when an intermediate message is promoted to the response', () => {
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
        text: '我先检查一下',
        isStreaming: false,
        messageId: 'intermediate-msg',
      },
    })

    expect(getAssistantTurnUiKey(turn, 1)).toBe('assistant:turn:pi-turn-1:123')
  })

  it('distinguishes split cards that open at different timestamps', () => {
    const turnA = makeAssistantTurn({ turnId: 'pi-turn-1', timestamp: 555 })
    const turnB = makeAssistantTurn({ turnId: 'pi-turn-1', timestamp: 556 })

    const keyA = getAssistantTurnUiKey(turnA, 0)
    const keyB = getAssistantTurnUiKey(turnB, 1)

    expect(keyA).not.toBe(keyB)
    expect(keyA).toBe('assistant:turn:pi-turn-1:555')
    expect(keyB).toBe('assistant:turn:pi-turn-1:556')
  })

  it('is stable for a turn that never got activities (bare process card)', () => {
    const turn = makeAssistantTurn({ timestamp: 999 })

    expect(getAssistantTurnUiKey(turn, 0)).toBe(getAssistantTurnUiKey(turn, 3))
    expect(getAssistantTurnUiKey(turn, 0)).toBe('assistant:turn:pi-turn-1:999')
  })
})
