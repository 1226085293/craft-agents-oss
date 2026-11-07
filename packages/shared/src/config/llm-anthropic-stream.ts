import type { SseFrame } from './llm-sse-parser.ts'

export type AnthropicStreamFailureKind = 'truncated' | 'empty_response' | 'upstream_error'

export interface AnthropicStreamFailure {
  kind: AnthropicStreamFailureKind
  message: string
}

interface BlockState {
  type: string
  id?: string
  name?: string
  inputJson: string
  text: string
}

/**
 * Observes an Anthropic SSE stream while it is forwarded untouched.
 *
 * It only buffers the `message_stop` frame: a clean stop has to be withheld
 * when the turn carried no visible answer, otherwise the client accepts an
 * empty turn before the retry marker can be appended.
 */
export class AnthropicStreamMonitor {
  private readonly blocks = new Map<number, BlockState>()
  private messageStartSeen = false
  private messageId = ''
  private model = ''
  private messageStopSeen = false
  private hasVisibleText = false
  private hasCompletedToolCall = false
  private lastInputTokens = 0
  private lastOutputTokens = 0

  constructor(private readonly publicModel: string) {}

  /**
   * Returns how the caller should treat this frame.
   *
   * `forward` writes the original bytes; `hold` withholds this frame; `fail`
   * stops forwarding and appends the synthetic failure terminal.
   */
  observe(frame: SseFrame): { action: 'forward' | 'hold'; failure?: AnthropicStreamFailure } {
    if (frame.event === 'error') {
      return { action: 'hold', failure: { kind: 'upstream_error', message: this.errorMessage(frame.data) } }
    }

    let payload: Record<string, unknown> | undefined
    try {
      payload = JSON.parse(frame.data) as Record<string, unknown>
    } catch {
      payload = undefined
    }
    const type = frame.event ?? (typeof payload?.type === 'string' ? payload.type : undefined)

    switch (type) {
      case 'message_start': {
        this.messageStartSeen = true
        const message = payload?.message as Record<string, unknown> | undefined
        if (typeof message?.id === 'string') this.messageId = message.id
        if (typeof message?.model === 'string' && message.model) this.model = message.model
        this.readUsage(message?.usage)
        break
      }
      case 'content_block_start': {
        const index = this.index(payload)
        const block = payload?.content_block as Record<string, unknown> | undefined
        if (index !== undefined && block) {
          const state: BlockState = {
            type: typeof block.type === 'string' ? block.type : '',
            inputJson: '',
            text: typeof block.text === 'string' ? block.text : '',
          }
          if (typeof block.id === 'string') state.id = block.id
          if (typeof block.name === 'string') state.name = block.name
          // Streaming tool calls start with an empty `{}` placeholder and send
          // the real object as input_json_delta chunks. Seeding inputJson with
          // "{}" would make `{}` + `{"command":...}` unparseable, marking every
          // valid tool call as an empty response.
          if (block.input !== undefined) {
            const input = block.input as Record<string, unknown> | null
            const placeholder = input !== null && typeof input === 'object' && !Array.isArray(input)
              && Object.keys(input).length === 0
            if (!placeholder) state.inputJson = JSON.stringify(block.input)
          }
          this.blocks.set(index, state)
          if (state.text.trim()) this.hasVisibleText = true
        }
        break
      }
      case 'content_block_delta': {
        const index = this.index(payload)
        const delta = payload?.delta as Record<string, unknown> | undefined
        const block = index === undefined ? undefined : this.blocks.get(index)
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          if (block) block.text += delta.text
          if (delta.text.trim()) this.hasVisibleText = true
        } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string' && block) {
          block.inputJson += delta.partial_json
        }
        break
      }
      case 'content_block_stop': {
        const index = this.index(payload)
        if (index === undefined) break
        const block = this.blocks.get(index)
        this.blocks.delete(index)
        if (block && this.isToolBlock(block) && this.validToolInput(block.inputJson)) {
          this.hasCompletedToolCall = true
        }
        break
      }
      case 'message_delta': {
        this.readUsage(payload?.usage)
        break
      }
      case 'message_stop': {
        this.messageStopSeen = true
        if (!this.hasVisibleContent()) {
          return {
            action: 'hold',
            failure: {
              kind: 'empty_response',
              message: 'upstream stream ended without visible text or a tool call',
            },
          }
        }
        return { action: 'forward' }
      }
      default:
        break
    }

    return { action: 'forward' }
  }

  /** Verdict after the transport ended without an already-returned failure. */
  endOfStream(sawByte: boolean): AnthropicStreamFailure | undefined {
    if (this.messageStopSeen && this.hasVisibleContent()) return undefined
    if (!this.messageStopSeen) {
      return {
        kind: sawByte ? 'truncated' : 'empty_response',
        message: sawByte
          ? 'upstream stream ended without a finish_reason'
          : 'upstream stream ended without visible text or a tool call',
      }
    }
    return {
      kind: 'empty_response',
      message: 'upstream stream ended without visible text or a tool call',
    }
  }

  /** Anthropic frames that turn the refusal into an error with the retry marker. */
  failureTerminal(marker: string | undefined, failure: AnthropicStreamFailure): string {
    const out: string[] = []
    if (!this.messageStartSeen) {
      const model = this.model || this.publicModel
      out.push(
        this.frame(
          'message_start',
          JSON.stringify({
            type: 'message_start',
            message: {
              id: this.messageId || `msg_gateway_${Date.now().toString(36)}`,
              type: 'message',
              role: 'assistant',
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          }),
        ),
      )
    }
    for (const index of [...this.blocks.keys()].sort((a, b) => a - b)) {
      out.push(this.frame('content_block_stop', JSON.stringify({ type: 'content_block_stop', index })))
    }
    const explanation = marker ? `${marker}: ${failure.message}` : failure.message
    out.push(
      this.frame(
        'message_delta',
        JSON.stringify({
          type: 'message_delta',
          delta: {
            stop_reason: 'refusal',
            stop_sequence: null,
            stop_details: { explanation },
          },
          usage: { output_tokens: this.lastOutputTokens },
        }),
      ),
    )
    out.push(this.frame('message_stop', JSON.stringify({ type: 'message_stop' })))
    return out.join('')
  }

  /**
   * Whether the stream has produced anything the user would actually see.
   *
   * Reasoning deltas keep the socket busy without counting here, which is the
   * whole point: a model can stream chain-of-thought for minutes and still owe
   * the caller an answer.
   */
  get hasVisibleOutput(): boolean {
    return this.hasVisibleText || this.hasCompletedToolCall
  }

  private hasVisibleContent(): boolean {
    return this.hasVisibleOutput
  }

  private isToolBlock(block: BlockState): boolean {
    return block.type === 'tool_use' || block.type === 'server_tool_use'
  }

  private validToolInput(input: string): boolean {
    try {
      const parsed = JSON.parse(input || '{}') as unknown
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    } catch {
      return false
    }
  }

  private errorMessage(data: string): string {
    try {
      const body = JSON.parse(data) as { error?: { message?: unknown }; message?: unknown }
      const message = body.error?.message ?? body.message
      if (typeof message === 'string' && message.trim()) return message
    } catch {
      // Fall through to the raw payload, which is still more useful than "".
    }
    return data.trim() || 'upstream sent an SSE error event'
  }

  private readUsage(value: unknown): void {
    const usage = value as Record<string, unknown> | undefined
    if (typeof usage?.input_tokens === 'number') this.lastInputTokens = usage.input_tokens
    if (typeof usage?.output_tokens === 'number') this.lastOutputTokens = usage.output_tokens
  }

  private index(payload: Record<string, unknown> | undefined): number | undefined {
    return typeof payload?.index === 'number' ? payload.index : undefined
  }

  private frame(event: string, data: string): string {
    return `event: ${event}\ndata: ${data}\n\n`
  }
}
