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

/**
 * Truncated tool-call guard (2026-10-04 incident).
 *
 * Upstream relays (agnes free tier and others) intermittently cut an SSE
 * stream while tool-call arguments are still streaming. The buffered args
 * JSON is then incomplete. Before this guard, the interceptor emitted the
 * partial call with a synthesized `finish_reason: "tool_calls"`, which
 * surfaced downstream as `Validation failed ... Received arguments: {}` /
 * missing required params. Now the incomplete call(s) are suppressed and the
 * stream closes with a retryable `network_error` finish instead.
 */
describe('unified-network-interceptor truncated tool-call streams', () => {
  let sessionDir: string;

  beforeAll(async () => {
    process.env.CRAFT_INTERCEPTOR_DISABLE_AUTO_INSTALL = '1';
    ({ createOpenAiSseStrippingStream } = await import('../unified-network-interceptor.ts'));
  });

  afterAll(() => {
    delete process.env.CRAFT_INTERCEPTOR_DISABLE_AUTO_INSTALL;
  });

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'interceptor-truncated-'));
    toolMetadataStore.setSessionDir(sessionDir);
  });

  afterEach(() => {
    toolMetadataStore._clearForTesting();
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it('still emits a complete consolidated call for a full stream (regression)', async () => {
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_full","type":"function","function":{"name":"bash","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"_intent\\": \\"run\\""}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":", \\"command\\": \\"echo hi\\""}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const out = await runThroughProcessor(createOpenAiSseStrippingStream(), sse);

    expect(out).toContain('"id":"call_full"');
    expect(out).toContain('"arguments":"{\\"command\\":\\"echo hi\\"}"');
    expect(out).toContain('"finish_reason":"tool_calls"');
    expect(out).not.toContain('network_error');
    expect(out).not.toContain('_intent');
  });

  it('suppresses a stream truncated mid-arguments and signals a retryable network_error', async () => {
    // Stream cut after the metadata fragment — no finish, no [DONE].
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"checking demote impl"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_cut","type":"function","function":{"name":"bash","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"_displayName\\": \\"check demote impl\\""}}]}}]}\n\n',
    ];

    const out = await runThroughProcessor(createOpenAiSseStrippingStream(), sse);

    expect(out).toContain('"finish_reason":"network_error"');
    expect(out).not.toContain('"finish_reason":"tool_calls"');
    // The truncated call must not be dispatched in any form.
    expect(out).not.toContain('call_cut');
    expect(out).not.toContain('_displayName');
    // Reasoning passthrough still works.
    expect(out).toContain('"reasoning_content":"checking demote impl"');
  });

  it('suppresses a cut right after the id/name frame (the Received arguments: {} shape)', async () => {
    // Stream cut before ANY argument delta arrived. Previously this emitted
    // a consolidated call with `"arguments":"{}"` plus a synthesized
    // tool_calls finish — the exact validation failure from the incident.
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_cut2","type":"function","function":{"name":"bash","arguments":""}}]}}]}\n\n',
    ];

    const out = await runThroughProcessor(createOpenAiSseStrippingStream(), sse);

    expect(out).toContain('"finish_reason":"network_error"');
    expect(out).not.toContain('"arguments":"{}"');
    expect(out).not.toContain('call_cut2');
    expect(out).not.toContain('"finish_reason":"tool_calls"');
  });

  it('replaces a late real finish with network_error when arguments were cut', async () => {
    // The relay delivered a finish_reason despite the truncated arguments —
    // the buffered finish must not be forwarded as a finished tool_calls turn.
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_cut3","type":"function","function":{"name":"bash","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"_intent\\": \\"run checks\\""}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const out = await runThroughProcessor(createOpenAiSseStrippingStream(), sse);

    expect(out).toContain('"finish_reason":"network_error"');
    expect(out).not.toContain('"finish_reason":"tool_calls"');
    expect(out).not.toContain('call_cut3');
    // Retryable terminal is emitted exactly once.
    expect(out.match(/network_error/g)?.length).toBe(1);
  });

  it('keeps a legitimate no-arg call with a real finish (no over-triggering)', async () => {
    // Zero-argument tools legitimately stream no arguments when the relay
    // omits the `{}` payload — with a real finish_reason this is complete.
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_noarg","type":"function","function":{"name":"tools_workspace","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const out = await runThroughProcessor(createOpenAiSseStrippingStream(), sse);

    expect(out).toContain('"id":"call_noarg"');
    expect(out).toContain('"arguments":"{}"');
    expect(out).toContain('"finish_reason":"stop"');
    expect(out).not.toContain('network_error');
  });

  it('keeps the DeepSeek two-phase merge behavior (phase-2 args at shifted index)', async () => {
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_two","type":"function","function":{"name":"web_fetch","arguments":"{\\"_intent\\": \\"fetch\\", \\"_displayName\\": \\"Fetch\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\\"url\\": \\"https://example.com\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const out = await runThroughProcessor(createOpenAiSseStrippingStream(), sse);

    expect(out).toContain('"id":"call_two"');
    expect(out).toContain('"arguments":"{\\"url\\":\\"https://example.com\\"}"');
    expect(out).toContain('"finish_reason":"tool_calls"');
    expect(out).not.toContain('network_error');
    expect(out).not.toContain('_intent');
  });

  it('suppresses the whole batch when any call in it was truncated', async () => {
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_ok","type":"function","function":{"name":"bash","arguments":"{\\"command\\": \\"echo a\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_bad","type":"function","function":{"name":"bash","arguments":"{\\"_displayName\\": \\"b\\""}}]}}]}\n\n',
    ];

    const out = await runThroughProcessor(createOpenAiSseStrippingStream(), sse);

    expect(out).toContain('"finish_reason":"network_error"');
    // Even the complete sibling call is withheld — the turn is retried as a whole.
    expect(out).not.toContain('call_ok');
    expect(out).not.toContain('call_bad');
  });
});
