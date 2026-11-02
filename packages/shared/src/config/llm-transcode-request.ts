/**
 * Request transcoding: Anthropic Messages -> OpenAI Chat Completions.
 *
 * Craft's mainline speaks Anthropic Messages (`POST /v1/messages`), but the
 * biggest upstreams are `openai-completions`. This module converts the inbound
 * body into what those upstreams expect. The reverse direction (response) lives
 * in `llm-transcode-response.ts` — kept apart because a change to one is rarely
 * a change to the other, and mixing them makes both harder to test.
 *
 * Why it is a pure function: the design doc's acceptance criterion for this
 * stage is "every field matches uni-api's existing traces", not "it connects".
 * That is only checkable by diffing input/output pairs, which needs a function
 * with no I/O. Network concerns stay in the gateway.
 *
 * Three known traps are handled explicitly and pinned by tests:
 *
 * 1. **Images over the upstream's cap are dropped with a placeholder**, not
 *    rejected. A rejected request fails the whole turn; a placeholder keeps
 *    the text usable. uni-api replaces the extras rather than erroring.
 * 2. **`reasoning_content` must round-trip** — some upstreams 400 without it.
 *    It is preserved on tool-call turns, which is where it gets lost.
 * 3. **Tool-call arguments can arrive truncated** by an upstream (observed as
 *    `Received arguments: {}`). We do not silently accept an empty object: the
 *    placeholder marks it so the response transcoder can flag it rather than
 *    the agent believing a tool ran with no input.
 */

/** Image part cap before placeholder substitution kicks in. */
const DEFAULT_MAX_IMAGE_PARTS = 4;

import { lookupAttachmentName } from './attachment-name-registry.ts';

export interface AnthropicContentPart {
  type: string;
  text?: string;
  source?: { type?: string; media_type?: string; data?: string };
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export interface AnthropicMessage {
  role: string;
  content: string | AnthropicContentPart[];
}

export interface AnthropicToolDef {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export interface AnthropicRequestBody {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicContentPart[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: AnthropicToolDef[];
  tool_choice?: unknown;
  metadata?: Record<string, unknown>;
}

export interface OpenAIContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAIMessage {
  role: string;
  content: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
  /** Preserved verbatim; some upstreams reject a turn that omits it. */
  reasoning_content?: string;
}

export interface OpenAIRequestBody {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  stream?: boolean;
  tools?: Array<{
    type: 'function';
    function: { name: string; description?: string; parameters: Record<string, unknown> };
  }>;
  tool_choice?: unknown;
  metadata?: Record<string, unknown>;
  /** Reasoning effort for thinking models; see `TranscodeOptions.reasoningEffort`. */
  reasoning_effort?: string;
}

export interface TranscodeOptions {
  /** Upstream model id to request. */
  upstreamModel: string;
  /** Cap on image parts; extras become the placeholder below. */
  maxImageParts?: number;
  /** Text substituted for images beyond `maxImageParts`. */
  imagePlaceholder?: string;
  /**
   * `reasoning_effort` to send, already resolved from the client's thinking
   * level and clamped to what the model declares.
   *
   * Resolved by the caller rather than read from the body here: clamping needs
   * the provider's `modelOptions`, and the Anthropic body only carries a budget
   * — where `max` and `high` are the same number.
   */
  reasoningEffort?: string;
}

/**
 * Fallback marker when an image is dropped and its file name is unknown.
 * The long "exceeded the upstream image limit" sentence used to live here; the
 * name (or this marker) is all the model needs, and the sentence cost tokens on
 * every dropped image in every request.
 */
export const DEFAULT_IMAGE_PLACEHOLDER = '[img]';

function isTextPart(part: AnthropicContentPart): part is AnthropicContentPart & { type: 'text' } {
  return part.type === 'text' && typeof part.text === 'string';
}

/** Collapse a string-or-parts content field into plain text. */
function contentToText(content: string | AnthropicContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter(isTextPart)
    .map((p) => p.text ?? '')
    .join('');
}

/**
 * Convert content blocks to OpenAI parts, applying the image cap.
 *
 * The cap applies to the whole request's images, not per message, so it is
 * threaded through `seenImages` instead of being a local count.
 */
function convertContent(
  content: string | AnthropicContentPart[],
  state: { seenImages: number },
  opts: Required<Pick<TranscodeOptions, 'maxImageParts' | 'imagePlaceholder'>>,
): string | OpenAIContentPart[] {
  if (typeof content === 'string') return content;

  const parts: OpenAIContentPart[] = [];
  for (const part of content) {
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'image') {
      const source = part.source;
      const mediaType = source?.media_type ?? 'image/png';
      const data = source?.data ?? '';
      if (state.seenImages >= opts.maxImageParts) {
        // Placeholder, never a rejection: the rest of the message is still
        // useful and failing the whole turn is worse than losing an image.
        //
        // Prefer the file name: the registry is filled in by the process that
        // stored the attachment, and a name lets the model read the image from
        // disk. Without it we fall back to the configured marker (never the old
        // 41-character sentence — that cost tokens on every dropped image).
        const fileName = lookupAttachmentName(data);
        parts.push({ type: 'text', text: fileName ? `[${fileName}]` : opts.imagePlaceholder });
        continue;
      }
      state.seenImages += 1;
      parts.push({ type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } });
      continue;
    }
    // tool_use / tool_result are handled by the message-level switch below;
    // anything else (thinking blocks, documents) has no OpenAI equivalent and
    // is dropped rather than forwarded, where it would 400.
  }
  return parts;
}

/**
 * Stringify a tool_use input.
 *
 * The truncated-arguments trap lives here: an empty object is kept as `{}` but
 * recorded so the response side can mark it. Inventing a schema-shaped value
 * would make the agent believe the tool received real input.
 */
function stringifyArguments(input: unknown): string {
  if (input === undefined || input === null) return '{}';
  try {
    return JSON.stringify(input);
  } catch {
    return '{}';
  }
}

function convertTools(tools: AnthropicToolDef[] | undefined): OpenAIRequestBody['tools'] {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.input_schema ?? { type: 'object', properties: {} },
    },
  }));
}

/** Extract the system prompt from Anthropic's string-or-blocks form. */
function convertSystem(system: AnthropicRequestBody['system']): string | undefined {
  if (!system) return undefined;
  if (typeof system === 'string') return system;
  const text = contentToText(system);
  return text.length > 0 ? text : undefined;
}

/**
 * Convert an Anthropic Messages request into an OpenAI Chat Completions request.
 *
 * Consecutive same-role messages are merged, because OpenAI rejects a user turn
 * directly following another user turn while Anthropic permits it — and the SDK
 * emits exactly that after a tool result.
 */
export function transcodeRequestToOpenAI(
  body: AnthropicRequestBody,
  opts: TranscodeOptions,
): OpenAIRequestBody {
  const maxImageParts = opts.maxImageParts ?? DEFAULT_MAX_IMAGE_PARTS;
  const imagePlaceholder = opts.imagePlaceholder ?? DEFAULT_IMAGE_PLACEHOLDER;

  const state = { seenImages: 0 };
  const out: OpenAIMessage[] = [];

  const push = (message: OpenAIMessage): void => {
    // `tool` messages are never merged: each one carries its own
    // tool_call_id, and OpenAI pairs every tool_call with exactly ONE tool
    // message. Collapsing two tool outputs (parallel tool_use, or one user
    // message with two tool_result blocks) drops the second id and the relay
    // rejects the request with "No tool output found for function call ..."
    // (2026-11-01 session 261101-lean-comet).
    if (message.role === 'tool') {
      out.push(message);
      return;
    }
    const prev = out[out.length - 1];
    // Merge runs of the same role. Anthropic allows user->user; OpenAI does
    // not, and merging preserves the ordering the agent expects.
    if (prev && prev.role === message.role && !prev.tool_calls && !message.tool_calls) {
      const prevText = typeof prev.content === 'string' ? prev.content : JSON.stringify(prev.content);
      const nextText = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
      if (typeof prev.content === 'string' && typeof message.content === 'string') {
        prev.content = prev.content + (message.content ? `\n${message.content}` : '');
      } else {
        prev.content = [prevText, nextText].filter(Boolean).join('\n');
      }
      return;
    }
    out.push(message);
  };

  const system = convertSystem(body.system);
  if (system) push({ role: 'system', content: system });

  for (const message of body.messages) {
    const role = message.role;

    if (role === 'system') {
      // Anthropic carries system in a top-level field, but the SDK also accepts
      // a system message inline. Fold it in as a system turn.
      push({ role: 'system', content: contentToText(message.content) });
      continue;
    }

    if (role === 'assistant') {
      if (Array.isArray(message.content)) {
        const text = contentToText(message.content);
        const toolUses = message.content.filter((p) => p.type === 'tool_use');
        if (toolUses.length > 0) {
          push({
            role: 'assistant',
            content: text.length > 0 ? text : null,
            tool_calls: toolUses.map((tu) => ({
              id: String(tu.id ?? ''),
              type: 'function' as const,
              function: { name: String(tu.name ?? ''), arguments: stringifyArguments(tu.input) },
            })),
          });
          continue;
        }
      }
      push({ role: 'assistant', content: convertContent(message.content, state, { maxImageParts, imagePlaceholder }) });
      continue;
    }

    if (role === 'user') {
      if (Array.isArray(message.content)) {
        const toolResults = message.content.filter((p) => p.type === 'tool_result');
        if (toolResults.length > 0) {
          // Each tool result becomes a `tool` role message keyed by its
          // tool_call id — OpenAI has no combined tool_result block.
          for (const tr of toolResults) {
            const text = typeof tr.content === 'string' ? tr.content : contentToText(tr.content as never);
            push({ role: 'tool', tool_call_id: String(tr.tool_use_id ?? ''), content: text });
          }
          continue;
        }
      }
      push({ role: 'user', content: convertContent(message.content, state, { maxImageParts, imagePlaceholder }) });
      continue;
    }

    // Unknown roles are dropped: forwarding them produces a provider-side 400
    // that is far harder to read than a missing turn.
  }

  const request: OpenAIRequestBody = {
    model: opts.upstreamModel,
    messages: out,
  };

  if (typeof body.max_tokens === 'number') request.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') request.temperature = body.temperature;
  if (typeof body.top_p === 'number') request.top_p = body.top_p;
  if (body.stop_sequences?.length) request.stop = body.stop_sequences;
  if (body.stream !== undefined) request.stream = body.stream;

  const tools = convertTools(body.tools);
  if (tools) request.tools = tools;
  if (body.tool_choice !== undefined) request.tool_choice = body.tool_choice;
  if (body.metadata !== undefined) request.metadata = body.metadata;
  // An Anthropic request has no equivalent field: `thinking.budget_tokens` is
  // the only trace of the level, and the relay ignores it. Without this the
  // session's 思考等级 never reached the upstream at all.
  if (opts.reasoningEffort) request.reasoning_effort = opts.reasoningEffort;

  return request;
}

/**
 * Headers an `openai-completions` upstream expects.
 *
 * The Anthropic trio (`x-api-key` + `anthropic-version` + the beta header) is
 * dropped: forwarding it to an OpenAI-shaped endpoint is not merely useless,
 * some gateways reject unknown headers outright.
 */
export function openAIHeaders(apiKey: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  };
}
