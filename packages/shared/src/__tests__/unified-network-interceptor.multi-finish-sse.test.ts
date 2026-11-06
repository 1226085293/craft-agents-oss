import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { toolMetadataStore } from '../interceptor-common.ts';

let createOpenAiSseStrippingStream: typeof import('../unified-network-interceptor.ts').createOpenAiSseStrippingStream;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function runThroughProcessor(
  processor: TransformStream<Uint8Array, Uint8Array>,
  chunks: string[],
): Promise<string> {
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

  const output = input.pipeThrough(processor);
  const reader = output.getReader();
  let result = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) result += decoder.decode(value, { stream: true });
  }
  result += decoder.decode();
  return result;
}

/** Data-line payloads of the emitted SSE, in order (the `[DONE]` marker included). */
function emittedDataLines(out: string): string[] {
  return out
    .split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => line.slice('data: '.length));
}

/** Count of `"finish_reason":"<reason>"` occurrences in the emitted stream. */
function countFinishReason(out: string, reason: string): number {
  return out.split(`"finish_reason":"${reason}"`).length - 1;
}

/**
 * Multiple terminal `finish_reason` chunks per stream (Maritaca AI, 2026-11-07).
 *
 * `createOpenAiSseStrippingStream()` used to buffer the terminal chunk in a
 * single slot (`pendingFinishLine`) so that the empty-stream guard could swap
 * it for a retryable `network_error`. When a relay emitted TWO finish chunks —
 * the first one carrying the entire visible reply, the second one carrying only
 * `usage` — the second overwrote the first and the text was lost forever. The
 * downstream SDK then saw zero content and the provider layer reported
 * "No response from provider. Check your API key." against a perfectly good key.
 *
 * Contract now: terminal chunks are accumulated **in arrival order** and every
 * one of them is emitted, while the empty-stream / truncated-tool-call guards
 * keep their original meaning (only a `network_error`, never the buffered
 * finishes).
 */
describe('unified-network-interceptor multiple finish_reason chunks', () => {
  let sessionDir: string;

  beforeAll(async () => {
    process.env.CRAFT_INTERCEPTOR_DISABLE_AUTO_INSTALL = '1';
    ({ createOpenAiSseStrippingStream } = await import('../unified-network-interceptor.ts'));
  });

  afterAll(() => {
    delete process.env.CRAFT_INTERCEPTOR_DISABLE_AUTO_INSTALL;
  });

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'interceptor-multi-finish-'));
    toolMetadataStore.setSessionDir(sessionDir);
  });

  afterEach(() => {
    toolMetadataStore._clearForTesting();
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it('keeps the content carried by the first finish chunk when a second (usage) finish follows', async () => {
    // Real Maritaca AI wire shape: ten empty-content chunks, then a chunk whose
    // delta carries BOTH the whole reply and finish_reason, then a usage-only
    // finish chunk, then [DONE].
    const sse: string[] = [];
    for (let i = 0; i < 10; i++) {
      sse.push('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"","parsed":{}},"finish_reason":null}]}\n\n');
    }
    sse.push('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"OK","parsed":null},"finish_reason":"stop"}]}\n\n');
    sse.push('data: {"choices":[{"index":0,"delta":{"content":null},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":1,"total_tokens":10}}\n\n');
    sse.push('data: [DONE]\n\n');

    const out = await runThroughProcessor(createOpenAiSseStrippingStream(), sse);

    // The body must survive — this is the whole bug.
    expect(out).toContain('"content":"OK"');
    // Both terminal chunks are forwarded, in arrival order, and neither is
    // replaced by the empty-stream guard (visible output was streamed).
    expect(countFinishReason(out, 'stop')).toBe(2);
    expect(out).not.toContain('network_error');
    // The usage-carrying chunk is preserved verbatim.
    expect(out).toContain('"total_tokens":10');

    const lines = emittedDataLines(out);
    const contentIdx = lines.findIndex(l => l.includes('"content":"OK"'));
    const usageIdx = lines.findIndex(l => l.includes('"total_tokens":10'));
    const doneIdx = lines.findIndex(l => l === '[DONE]');
    expect(contentIdx).toBeGreaterThanOrEqual(0);
    expect(usageIdx).toBeGreaterThan(contentIdx);
    expect(doneIdx).toBeGreaterThan(usageIdx);
  });

  it('forwards every buffered finish chunk in order when the stream ends without [DONE]', async () => {
    // Same defect exists on the flush() path: a relay that closes the socket
    // instead of sending [DONE] must not lose the content-bearing chunk either.
    const out = await runThroughProcessor(createOpenAiSseStrippingStream(), [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"par"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"tial"},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":7}}\n\n',
    ]);

    expect(out).toContain('"content":"tial"');
    expect(countFinishReason(out, 'stop')).toBe(2);
    expect(out).toContain('"total_tokens":7');
    expect(out).not.toContain('network_error');
  });

  it('leaves the normal single-finish shape unchanged', async () => {
    const out = await runThroughProcessor(createOpenAiSseStrippingStream(), [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]);

    expect(out).toContain('"content":"Hel"');
    expect(out).toContain('"content":"lo"');
    expect(countFinishReason(out, 'stop')).toBe(1);
    expect(out).not.toContain('network_error');
    expect(emittedDataLines(out).at(-1)).toBe('[DONE]');
  });

  it('still swaps a truly empty stream for exactly one network_error (no buffered finish leaks)', async () => {
    // Zero visible output AND two finish chunks: the guard must win for the
    // whole buffer — emitting network_error *and* the upstream finish would
    // hand the SDK a bogus normal stop after a retryable error.
    const out = await runThroughProcessor(createOpenAiSseStrippingStream(), [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":3}}\n\n',
      'data: [DONE]\n\n',
    ]);

    expect(countFinishReason(out, 'network_error')).toBe(1);
    expect(out).not.toContain('"finish_reason":"stop"');
    expect(out).toContain('[DONE]');
  });

  it('emits only network_error when tool-call arguments were truncated, even with accumulated finishes', async () => {
    // Truncated tool-call guard must clear the accumulated buffer: a relay that
    // sends finish, then a usage finish, must not surface either of them.
    const out = await runThroughProcessor(createOpenAiSseStrippingStream(), [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_cut","type":"function","function":{"name":"bash","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"_intent\\": \\"run checks\\""}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"finish_reason":"tool_calls"}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"total_tokens":4}}\n\n',
      'data: [DONE]\n\n',
    ]);

    expect(countFinishReason(out, 'network_error')).toBe(1);
    expect(out).not.toContain('"finish_reason":"tool_calls"');
    expect(out).not.toContain('call_cut');
    expect(out).toContain('[DONE]');
  });

  it('closes a truncated tool-call stream that ends without [DONE] with a single network_error', async () => {
    const out = await runThroughProcessor(createOpenAiSseStrippingStream(), [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_cut2","type":"function","function":{"name":"bash","arguments":"{\\"_displayName\\": \\"b\\""}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"finish_reason":"tool_calls"}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    ]);

    expect(countFinishReason(out, 'network_error')).toBe(1);
    expect(out).not.toContain('"finish_reason":"tool_calls"');
    expect(out).not.toContain('call_cut2');
  });
});
