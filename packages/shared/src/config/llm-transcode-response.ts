/**
 * Response transcoding: OpenAI Chat Completions -> Anthropic Messages.
 *
 * The gateway's client parses Anthropic's SSE
 * event names. An OpenAI-shaped upstream emits a different vocabulary
 * (`message_start` vs `response.created`, `content_block_delta` vs
 * `response.output_text.delta`), so the stream is rewritten event by event
 * rather than buffered: buffering would add a full turn of latency and lose
 * the incremental behaviour Craft relies on.
 *
 * Shape of the output stream is Anthropic's canonical sequence:
 *
 *   message_start -> content_block_start -> content_block_delta* ->
 *   content_block_stop -> message_delta -> message_stop
 *
 * Text and tool calls each get their own block index, which is what the SDK
 * uses to associate deltas with the right block.
 *
 * The three known traps from the design doc that involve the response side:
 *
 * - `reasoning_content` must survive the round trip; it is forwarded as a
 *   `thinking` block so it reaches the agent rather than being dropped.
 * - A mid-stream cut on a Craft chat request carries a supported `refusal`
 *   stop reason and a private retry marker in `stop_details`; Pi exposes the
 *   marker to the session layer, which discards the partial and resumes the
 *   same model step while leaving successful streams fully incremental.
 * - Truncated tool-call arguments are marked instead of being silently
 *   accepted (see `llm-transcode-request.ts` for the request half).
 */

import type { OpenAIMessage } from './llm-transcode-request.ts';

/** Anthropic SSE event names the SDK understands. */
const EV = {
  messageStart: 'message_start',
  contentBlockStart: 'content_block_start',
  contentBlockDelta: 'content_block_delta',
  contentBlockStop: 'content_block_stop',
  messageDelta: 'message_delta',
  messageStop: 'message_stop',
  ping: 'ping',
  error: 'error',
} as const;

export interface AnthropicSSEEvent {
  event: string
  data: Record<string, unknown>
}

export interface TranscodeContext {
  /** Public model id the client asked for; echoed back in message_start. */
  publicModel: string
  /** Upstream model actually used. */
  upstreamModel: string
  /** Message id advertised to the SDK. */
  messageId: string
}

function sse(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * One streamed delta.
 *
 * Every field is optional because OpenAI sends them across separate chunks:
 * the first chunk may carry only a role, the next only content, and a tool
 * call's name arrives apart from its arguments.
 */
export interface OpenAIDelta {
  role?: string
  content?: string | null
  reasoning_content?: string
  tool_calls?: Array<{
    index?: number
    id?: string
    type?: string
    function?: { name?: string; arguments?: string }
  }>
}

/** OpenAI streaming chunk. Only the fields this transcoder reads are typed. */
export interface OpenAIStreamChunk {
  id?: string
  model?: string
  choices?: Array<{
    index?: number
    delta?: OpenAIDelta
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    /**
     * OpenAI reports cache hits inside `prompt_tokens`; Anthropic exposes the
     * same count separately as `cache_read_input_tokens`. Subtract it from
     * Anthropic `input_tokens` while keeping the full prompt count in gateway
     * usage stats, so the Pi adapter can add both fields without double-counting.
     */
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

/**
 * Accumulator for one streamed response.
 *
 * Held across chunks because OpenAI sends a tool call's name and arguments in
 * separate deltas, and Anthropic needs the whole block before `content_block_start`.
 */
export class ResponseTranscoder {
  private readonly ctx: TranscodeContext
  private started = false
  private textBlockIndex = -1
  private reasoningBlockIndex = -1
  private textOpen = false
  private reasoningOpen = false
  /** tool_call index -> { blockIndex, id, name, args } */
  private toolBlocks = new Map<number, { blockIndex: number; id: string; name: string; args: string }>()
  private nextBlockIndex = 0
  private inputTokens = 0
  private outputTokens = 0
  private cachedTokens = 0
  private finishReason: string | null = null
  /** Set when the upstream cut the stream without a finish_reason. */
  private truncated = false

  constructor(ctx: TranscodeContext) {
    this.ctx = ctx
  }

  /** Emit the opening events. Called once, before the first delta. */
  private ensureStarted(): string[] {
    if (this.started) return []
    this.started = true
    return [
      sse(EV.messageStart, {
        type: EV.messageStart,
        message: {
          id: this.ctx.messageId,
          type: 'message',
          role: 'assistant',
          model: this.ctx.publicModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          // The SDK reads cache numbers off `message_start` too, and the
          // real count only arrives with the final chunk — it is overwritten by
          // `message_delta` below.
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
        },
      }),
      sse(EV.ping, { type: 'ping' }),
    ]
  }

  /** Feed one parsed OpenAI chunk; returns the SSE text to forward. */
  push(chunk: OpenAIStreamChunk): string {
    const out: string[] = [...this.ensureStarted()]

    if (chunk.usage) {
      this.inputTokens = chunk.usage.prompt_tokens ?? this.inputTokens
      this.outputTokens = chunk.usage.completion_tokens ?? this.outputTokens
      const cached = chunk.usage.prompt_tokens_details?.cached_tokens
      if (typeof cached === 'number' && Number.isFinite(cached)) this.cachedTokens = cached
    }

    const choice = chunk.choices?.[0]
    if (!choice) return out.join('')

    const delta = choice.delta ?? {}

    // Reasoning first: it precedes text in the model's output, and emitting it
    // afterwards would reorder the transcript.
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      if (!this.reasoningOpen) {
        this.reasoningBlockIndex = this.nextBlockIndex++
        this.reasoningOpen = true
        out.push(
          sse(EV.contentBlockStart, {
            type: EV.contentBlockStart,
            index: this.reasoningBlockIndex,
            content_block: { type: 'thinking', thinking: '' },
          }),
        )
      }
      out.push(
        sse(EV.contentBlockDelta, {
          type: EV.contentBlockDelta,
          index: this.reasoningBlockIndex,
          delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
        }),
      )
    }

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      if (this.toolBlocks.size === 0) {
        // Close reasoning before opening text so blocks do not interleave.
        if (this.reasoningOpen) {
          out.push(sse(EV.contentBlockStop, { type: EV.contentBlockStop, index: this.reasoningBlockIndex }))
          this.reasoningOpen = false
        }
        if (!this.textOpen) {
          this.textBlockIndex = this.nextBlockIndex++
          this.textOpen = true
          out.push(
            sse(EV.contentBlockStart, {
              type: EV.contentBlockStart,
              index: this.textBlockIndex,
              content_block: { type: 'text', text: '' },
            }),
          )
        }
        out.push(
          sse(EV.contentBlockDelta, {
            type: EV.contentBlockDelta,
            index: this.textBlockIndex,
            delta: { type: 'text_delta', text: delta.content },
          }),
        )
      }
    }

    for (const tc of delta.tool_calls ?? []) {
      const index = tc.index ?? 0
      let block = this.toolBlocks.get(index)
      if (!block) {
        // A tool call starts: close the text block so tool_use gets its own.
        if (this.textOpen) {
          out.push(sse(EV.contentBlockStop, { type: EV.contentBlockStop, index: this.textBlockIndex }))
          this.textOpen = false
        }
        block = {
          blockIndex: this.nextBlockIndex++,
          id: tc.id ?? `toolu_${this.ctx.messageId}_${index}`,
          name: tc.function?.name ?? '',
          args: '',
        }
        this.toolBlocks.set(index, block)
        out.push(
          sse(EV.contentBlockStart, {
            type: EV.contentBlockStart,
            index: block.blockIndex,
            content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
          }),
        )
      }
      if (tc.function?.name && block.name.length === 0) block.name = tc.function.name
      if (typeof tc.function?.arguments === 'string' && tc.function.arguments.length > 0) {
        block.args += tc.function.arguments
        out.push(
          sse(EV.contentBlockDelta, {
            type: EV.contentBlockDelta,
            index: block.blockIndex,
            delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
          }),
        )
      }
    }

    if (choice.finish_reason) this.finishReason = choice.finish_reason
    return out.join('')
  }

  /**
   * Emit the closing events.
   *
   * `truncated` distinguishes a clean finish from a cut stream: the gateways
   * drop connections mid-turn, and reporting both as `end_turn` would hide a
   * failed turn from the agent's retry logic.
   */
  finish(options: { truncated?: boolean; retryMarker?: string } = {}): string {
    const out: string[] = [...this.ensureStarted()]
    this.truncated = options.truncated === true

    for (const block of this.toolBlocks.values()) {
      out.push(sse(EV.contentBlockStop, { type: EV.contentBlockStop, index: block.blockIndex }))
    }
    if (this.reasoningOpen) {
      out.push(sse(EV.contentBlockStop, { type: EV.contentBlockStop, index: this.reasoningBlockIndex }))
    }
    if (this.textOpen) {
      out.push(sse(EV.contentBlockStop, { type: EV.contentBlockStop, index: this.textBlockIndex }))
    }

    const stopReason = this.truncated
      ? options.retryMarker ? 'refusal' : 'network_error'
      : this.finishReason === 'tool_calls' || this.finishReason === 'function_call'
        ? 'tool_use'
        : this.finishReason === 'length'
          ? 'max_tokens'
          : 'end_turn'

    out.push(
      sse(EV.messageDelta, {
        type: EV.messageDelta,
        delta: {
          stop_reason: stopReason,
          stop_sequence: null,
          ...(this.truncated && options.retryMarker
            ? { stop_details: { explanation: `${options.retryMarker}: upstream stream ended without a finish_reason` } }
            : {}),
        },
        usage: {
          input_tokens: Math.max(0, this.inputTokens - this.cachedTokens),
          output_tokens: this.outputTokens,
          cache_read_input_tokens: this.cachedTokens,
        },
      }),
    )
    out.push(sse(EV.messageStop, { type: EV.messageStop }))

    if (this.truncated && !options.retryMarker) {
      out.push(
        sse(EV.error, {
          type: 'error',
          error: { type: 'network_error', message: 'upstream stream ended without a finish_reason' },
        }),
      )
    }

    return out.join('')
  }

  /** Token counts seen so far, for the gateway's usage record. */
  usage(): { promptTokens: number; completionTokens: number; cachedTokens: number } {
    return { promptTokens: this.inputTokens, completionTokens: this.outputTokens, cachedTokens: this.cachedTokens }
  }

  /** True once any content or tool call has been emitted. */
  get hasContent(): boolean {
    return this.textOpen || this.reasoningOpen || this.toolBlocks.size > 0
  }
}

/**
 * Convert a whole non-streaming OpenAI response into Anthropic's shape.
 *
 * Used when the client asked for `stream: false`; the streaming path above is
 * the one Craft actually uses, but the SDK's retry probes do not.
 */
export function transcodeResponseToAnthropic(
  body: {
    id?: string
    model?: string
    choices?: Array<{ message?: OpenAIMessage & { reasoning_content?: string }; finish_reason?: string | null }>
    usage?: {
      prompt_tokens?: number
      completion_tokens?: number
      prompt_tokens_details?: { cached_tokens?: number }
    }
  },
  ctx: TranscodeContext,
): Record<string, unknown> {
  const choice = body.choices?.[0]
  const message = choice?.message
  const content: Array<Record<string, unknown>> = []

  if (typeof message?.reasoning_content === 'string' && message.reasoning_content.length > 0) {
    content.push({ type: 'thinking', thinking: message.reasoning_content })
  }
  if (typeof message?.content === 'string' && message.content.length > 0) {
    content.push({ type: 'text', text: message.content })
  }
  for (const tc of message?.tool_calls ?? []) {
    let input: unknown = {}
    try {
      input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}
    } catch {
      // A parse failure here is the request side's truncated-args trap; keep
      // an empty object rather than failing the whole turn.
      input = {}
    }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input })
  }

  const stopReason =
    choice?.finish_reason === 'tool_calls' || choice?.finish_reason === 'function_call'
      ? 'tool_use'
      : choice?.finish_reason === 'length'
        ? 'max_tokens'
        : 'end_turn'

  return {
    id: ctx.messageId,
    type: 'message',
    role: 'assistant',
    model: ctx.publicModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: Math.max(0, (body.usage?.prompt_tokens ?? 0) - (body.usage?.prompt_tokens_details?.cached_tokens ?? 0)),
      output_tokens: body.usage?.completion_tokens ?? 0,
      cache_read_input_tokens: body.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
  }
}
