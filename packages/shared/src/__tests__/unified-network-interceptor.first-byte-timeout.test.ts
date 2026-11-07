/**
 * SSE first-byte watchdog (2026-11-07, session 261105-onyx-steel).
 *
 * Real wire capture: the relay answered
 *   `200 OK, content-type: text/event-stream`
 * and then wrote NOTHING for 90+ seconds (twice, 06:11 and 07:02 UTC). The
 * 90 s turn watchdog aborted the run; the SDK stayed `isStreaming`, and from
 * then on every user message was superseded-then-aborted — "send a message and
 * it silently aborts", with the real run streaming into a closed queue.
 *
 * The existing HTTP idle timeout is 600 s, far too late to be the authority.
 * A response that opens its stream and never writes a byte is a dead
 * connection: fail THAT request with a retryable error instead of letting a
 * zombie run poison the session.
 *
 * These tests exercise the helper directly (rather than patching globalThis
 * fetch): the interceptor auto-installs at module-import time, and bun shares
 * that module cache across test files, so a fetch-level harness silently
 * degrades depending on which file the runner loaded first.
 */
import { describe, expect, it } from 'bun:test';
import { withFirstByteWatchdog } from '../unified-network-interceptor.ts';

const TIMEOUT_MS = 120;

/** A body that opens its stream and then never produces a chunk. */
function silentBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start() {
      // Deliberately never enqueue and never close — the exact upstream shape.
    },
  });
}

/** A body that emits `chunks` after an optional initial delay. */
function bodyOf(chunks: string[], delayMs = 0): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let out = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

describe('withFirstByteWatchdog', () => {
  it('errors a stream that opens and never writes a byte', async () => {
    const guarded = withFirstByteWatchdog(silentBody(), 'test', TIMEOUT_MS);
    await expect(readAll(guarded)).rejects.toThrow(/no data within/i);
  });

  it('leaves a normal stream untouched', async () => {
    const guarded = withFirstByteWatchdog(
      bodyOf(['data: one\n\n', 'data: two\n\n']),
      'test',
      TIMEOUT_MS,
    );
    expect(await readAll(guarded)).toBe('data: one\n\ndata: two\n\n');
  });

  it('does not trip when the first byte arrives inside the window', async () => {
    const guarded = withFirstByteWatchdog(
      bodyOf(['data: late\n\n'], 20),
      'test',
      TIMEOUT_MS,
    );
    expect(await readAll(guarded)).toBe('data: late\n\n');
  });

  it('cancels the upstream reader when the watchdog fires', async () => {
    let cancelled = false;
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    const src = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
      },
      cancel() {
        cancelled = true;
      },
    });

    const guarded = withFirstByteWatchdog(src, 'test', TIMEOUT_MS);
    await expect(readAll(guarded)).rejects.toThrow(/no data within/i);
    expect(controllerRef).not.toBeNull();
    expect(cancelled).toBe(true);
  });

  it('does not leak the timer across a normally closed stream', async () => {
    // A short timeout plus a stream closed immediately: if the timer survived
    // the close it would fire later and try to error an already-closed
    // controller (throwing "Invalid state"). Awaiting a tick proves it does not.
    const guarded = withFirstByteWatchdog(bodyOf(['data: x\n\n']), 'test', 50);
    expect(await readAll(guarded)).toBe('data: x\n\n');
    await new Promise(r => setTimeout(r, 120));
  });
});
