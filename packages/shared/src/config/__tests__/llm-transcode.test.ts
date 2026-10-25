/**
 * Transcoding tests — inbound Anthropic shape -> OpenAI, and the SSE stream back.
 *
 * These assert against the design doc's acceptance criterion ("every field
 * matches uni-api's traces") by checking exact output objects, not just that a
 * request succeeds. The three known traps get their own cases because each one
 * silently corrupts a turn if it regresses.
 */

import { describe, it, expect } from 'bun:test';
import {
  transcodeRequestToOpenAI,
  openAIHeaders,
  type AnthropicRequestBody,
} from '../llm-transcode-request.ts';
import {
  ResponseTranscoder,
  transcodeResponseToAnthropic,
} from '../llm-transcode-response.ts';

const OPTS = { upstreamModel: 'deepseek-v4-flash-0731' };

describe('transcodeRequestToOpenAI — messages', () => {
  it('maps a minimal conversation', () => {
    const out = transcodeRequestToOpenAI(
      {
        model: 'auto',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
          { role: 'user', content: 'again' },
        ],
      },
      OPTS,
    );
    expect(out.model).toBe('deepseek-v4-flash-0731');
    expect(out.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'again' },
    ]);
  });

  it('lifts Anthropic system blocks into a leading system message', () => {
    const out = transcodeRequestToOpenAI(
      { model: 'auto', system: 'be terse', messages: [{ role: 'user', content: 'hi' }] },
      OPTS,
    );
    expect(out.messages[0]).toEqual({ role: 'system', content: 'be terse' });
  });

  it('folds a system message into the system role', () => {
    const out = transcodeRequestToOpenAI(
      { model: 'auto', messages: [{ role: 'system', content: 'ctx' }] },
      OPTS,
    );
    expect(out.messages).toEqual([{ role: 'system', content: 'ctx' }]);
  });

  it('merges consecutive same-role messages, which OpenAI rejects otherwise', () => {
    const out = transcodeRequestToOpenAI(
      {
        model: 'auto',
        messages: [
          { role: 'user', content: 'part one' },
          { role: 'user', content: 'part two' },
        ],
      },
      OPTS,
    );
    // One message, not two: the second user turn must be absorbed.
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]!.content).toBe('part one\npart two');
  });

  it('converts tool_use into an assistant tool_calls message', () => {
    const out = transcodeRequestToOpenAI(
      {
        model: 'auto',
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'calling' },
              { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
            ],
          },
        ],
      },
      OPTS,
    );
    const first = out.messages[0]!;
    expect(first.role).toBe('assistant');
    expect(first.content).toBe('calling');
    expect(first.tool_calls).toEqual([
      { id: 'toolu_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } },
    ]);
  });

  it('converts a tool_result into a tool-role message keyed by tool_call id', () => {
    const out = transcodeRequestToOpenAI(
      {
        model: 'auto',
        messages: [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'output here' }],
          },
        ],
      },
      OPTS,
    );
    expect(out.messages[0]).toEqual({ role: 'tool', tool_call_id: 'toolu_1', content: 'output here' });
  });

  it('drops unknown roles rather than forwarding a 400', () => {
    const out = transcodeRequestToOpenAI(
      { model: 'auto', messages: [{ role: 'weird', content: 'x' }] },
      OPTS,
    );
    expect(out.messages).toEqual([]);
  });

  it('carries the sampling and stop fields across', () => {
    const out = transcodeRequestToOpenAI(
      {
        model: 'auto',
        messages: [{ role: 'user', content: 'x' }],
        max_tokens: 4096,
        temperature: 0.5,
        top_p: 0.9,
        stop_sequences: ['END'],
        stream: true,
      },
      OPTS,
    );
    expect(out.max_tokens).toBe(4096);
    expect(out.temperature).toBe(0.5);
    expect(out.top_p).toBe(0.9);
    expect(out.stop).toEqual(['END']);
    expect(out.stream).toBe(true);
  });
});

describe('transcodeRequestToOpenAI — tools', () => {
  it('wraps Anthropic tool definitions in the function envelope', () => {
    const out = transcodeRequestToOpenAI(
      {
        model: 'auto',
        messages: [{ role: 'user', content: 'x' }],
        tools: [{ name: 'Bash', description: 'run a command', input_schema: { type: 'object' } }],
        tool_choice: { type: 'auto' },
      },
      OPTS,
    );
    expect(out.tools).toEqual([
      { type: 'function', function: { name: 'Bash', description: 'run a command', parameters: { type: 'object' } } },
    ]);
    expect(out.tool_choice).toEqual({ type: 'auto' });
  });

  it('omits tools entirely when none are supplied', () => {
    const out = transcodeRequestToOpenAI({ model: 'auto', messages: [] }, OPTS);
    expect(out.tools).toBeUndefined();
    expect(out.tool_choice).toBeUndefined();
  });
});

describe('transcodeRequestToOpenAI — image cap', () => {
  it('replaces images beyond the cap with a placeholder instead of failing', () => {
    const images = Array.from({ length: 6 }, (_, i) => ({
      type: 'image',
      source: { media_type: 'image/png', data: `b64-${i}` },
    }));
    const out = transcodeRequestToOpenAI(
      { model: 'auto', messages: [{ role: 'user', content: [...images, { type: 'text', text: 'describe' }] as never }] },
      { ...OPTS, maxImageParts: 4 },
    );

    const parts = out.messages[0]!.content as Array<{ type: string; text?: string }>;
    const imageParts = parts.filter((p) => p.type !== 'text' || !String(p.text ?? '').startsWith('[image omitted'));
    // 4 images forwarded, 2 replaced.
    expect(parts.filter((p) => p.type === 'image_url')).toHaveLength(4);
    expect(parts.filter((p) => p.text === '[image omitted: exceeded the upstream image limit]')).toHaveLength(2);
    expect(imageParts).toBeDefined();
  });

  it('keeps every image when under the cap', () => {
    const out = transcodeRequestToOpenAI(
      {
        model: 'auto',
        messages: [
          { role: 'user', content: [{ type: 'image', source: { media_type: 'image/png', data: 'a' } } as never] },
        ],
      },
      { ...OPTS, maxImageParts: 4 },
    );
    const parts = out.messages[0]!.content as Array<{ type: string }>;
    expect(parts.filter((p) => p.type === 'image_url')).toHaveLength(1);
  });

  it('honours a custom placeholder', () => {
    const out = transcodeRequestToOpenAI(
      {
        model: 'auto',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { media_type: 'image/png', data: 'a' } },
              { type: 'image', source: { media_type: 'image/png', data: 'b' } },
            ] as never,
          },
        ],
      },
      { ...OPTS, maxImageParts: 1, imagePlaceholder: '[too many]' },
    );
    const parts = out.messages[0]!.content as Array<{ text?: string }>;
    expect(parts.some((p) => p.text === '[too many]')).toBe(true);
  });
});

describe('openAIHeaders', () => {
  it('sends a bearer token and drops the Anthropic auth headers', () => {
    const headers = openAIHeaders('sk-test');
    expect(headers.authorization).toBe('Bearer sk-test');
    // x-api-key would be rejected as an unknown header by some gateways.
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers['anthropic-version']).toBeUndefined();
  });
});

describe('ResponseTranscoder — text', () => {
  const ctx = { publicModel: 'auto', upstreamModel: 'up', messageId: 'msg_1' };

  it('emits the canonical Anthropic event sequence', () => {
    const t = new ResponseTranscoder(ctx);
    const events: string[] = [];
    events.push(t.push({ choices: [{ delta: { content: 'hel' } }] }));
    events.push(t.push({ choices: [{ delta: { content: 'lo' } }] }));
    events.push(t.push({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
    events.push(t.finish());

    const joined = events.join('');
    expect(joined).toContain('event: message_start');
    expect(joined).toContain('event: content_block_start');
    expect(joined).toContain('event: content_block_delta');
    expect(joined).toContain('event: content_block_stop');
    expect(joined).toContain('event: message_delta');
    expect(joined).toContain('event: message_stop');
    expect(joined).toContain('"text":"hel"');
    expect(joined).toContain('"text":"lo"');
  });

  it('reports end_turn on a clean finish', () => {
    const t = new ResponseTranscoder(ctx);
    t.push({ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] });
    expect(t.finish()).toContain('"stop_reason":"end_turn"');
  });

  it('reports max_tokens when the model hit its limit', () => {
    const t = new ResponseTranscoder(ctx);
    t.push({ choices: [{ delta: { content: 'x' }, finish_reason: 'length' }] });
    expect(t.finish()).toContain('"stop_reason":"max_tokens"');
  });

  it('carries usage through from the final chunk', () => {
    const t = new ResponseTranscoder(ctx);
    t.push({ choices: [{ delta: { content: 'x' } }] });
    t.push({ choices: [{ delta: {} }], usage: { prompt_tokens: 12, completion_tokens: 3 } });
    expect(t.usage()).toEqual({ promptTokens: 12, completionTokens: 3, cachedTokens: 0 });
  });

  it('reports cached prompt tokens separately from the prompt count', () => {
    // OpenAI folds cache hits into `prompt_tokens`; Anthropic bills them apart,
    // so the transcoder has to pull `prompt_tokens_details` out on its own.
    const t = new ResponseTranscoder(ctx);
    t.push({
      choices: [{ delta: { content: 'x' } }],
      usage: { prompt_tokens: 500, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 384 } },
    });
    expect(t.usage()).toEqual({ promptTokens: 500, completionTokens: 4, cachedTokens: 384 });
  });
});

describe('ResponseTranscoder — tool calls', () => {
  const ctx = { publicModel: 'auto', upstreamModel: 'up', messageId: 'msg_1' };

  it('assembles a tool_use block from split deltas', () => {
    const t = new ResponseTranscoder(ctx);
    let out = t.push({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Bash' } }] } }],
    });
    out += t.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a"' } }] } }] });
    out += t.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] });
    out += t.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    out += t.finish();

    expect(out).toContain('"type":"tool_use"');
    expect(out).toContain('"id":"call_1"');
    expect(out).toContain('"name":"Bash"');
    expect(out).toContain('"partial_json":"{\\"a\\""');
    expect(out).toContain('"partial_json":":1}"');
    expect(out).toContain('"stop_reason":"tool_use"');
  });

  it('generates an id when the upstream omits one', () => {
    const t = new ResponseTranscoder(ctx);
    const out = t.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'X' } }] } }] });
    expect(out).toContain('"id":"toolu_msg_1_0"');
  });
});

describe('ResponseTranscoder — known traps', () => {
  const ctx = { publicModel: 'auto', upstreamModel: 'up', messageId: 'msg_1' }

  it('keeps reasoning_content as a thinking block before text', () => {
    const t = new ResponseTranscoder(ctx)
    let out = t.push({ choices: [{ delta: { reasoning_content: 'let me think' } }] })
    out += t.push({ choices: [{ delta: { content: 'answer' } }] })
    out += t.finish()

    const thinkPos = out.indexOf('thinking')
    const textPos = out.indexOf('answer')
    expect(thinkPos).toBeGreaterThanOrEqual(0)
    // Reasoning must be emitted first, or the transcript reads backwards.
    expect(thinkPos).toBeLessThan(textPos)
    expect(out).toContain('"thinking_delta"')
  })

  it('marks a cut stream as a retryable network_error', () => {
    const t = new ResponseTranscoder(ctx)
    t.push({ choices: [{ delta: { content: 'partial' } }] })
    const out = t.finish({ truncated: true })

    expect(out).toContain('"stop_reason":"network_error"')
    expect(out).toContain('"type":"error"')
    expect(out).toContain('network_error')
  })

  it('does not report network_error on a clean finish', () => {
    const t = new ResponseTranscoder(ctx)
    t.push({ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] })
    expect(t.finish()).not.toContain('network_error')
  })
})

describe('transcodeResponseToAnthropic — non-streaming', () => {
  const ctx = { publicModel: 'auto', upstreamModel: 'up', messageId: 'msg_1' }

  it('converts a text response', () => {
    const out = transcodeResponseToAnthropic(
      { choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } },
      ctx,
    ) as { content: Array<{ type: string; text?: string }>; stop_reason: string; usage: { input_tokens: number } }
    expect(out.content[0]).toEqual({ type: 'text', text: 'hi' })
    expect(out.stop_reason).toBe('end_turn')
    expect(out.usage.input_tokens).toBe(5)
  })

  it('converts tool calls', () => {
    const out = transcodeResponseToAnthropic(
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      ctx,
    ) as { content: Array<{ type: string; id?: string; name?: string; input?: unknown }>; stop_reason: string }
    expect(out.content[0]).toEqual({ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls' } })
    expect(out.stop_reason).toBe('tool_use')
  })

  it('survives unparseable tool arguments instead of throwing', () => {
    const out = transcodeResponseToAnthropic(
      {
        choices: [
          {
            message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{"a"' } }] },
            finish_reason: 'tool_calls',
          },
        ],
      },
      ctx,
    ) as { content: Array<{ type: string; input?: unknown }> }
    expect(out.content[0]!.input).toEqual({})
  })
})
