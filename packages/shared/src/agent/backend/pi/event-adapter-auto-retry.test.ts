/**
 * Tests for the subprocess auto-retry lane in PiEventAdapter.
 *
 * The subprocess (pi-agent-server) retries transient LLM errors on its own
 * schedule (2s → 5min, 2h deadline). Its scheduling metadata rides on the raw
 * SDK events as annotations:
 *  - message_end  → `autoRetryPlanned: true` (transient error buffered)
 *  - agent_end    → `autoRetryPending: true` (another round coming; hold)
 *  - agent_end    → `autoRetryFinal: true`   (synthetic give-up terminal)
 *  - agent_end    → `autoRetryFinal + autoRetryCancelled` (cancel terminal)
 *
 * Invariants under test:
 *  1. Annotated errors are buffered, never surfaced immediately.
 *  2. `shouldCompleteQueue` returns false while a retry round is pending.
 *  3. An UN-annotated terminal agent_end still surfaces the buffered error
 *     (defense-in-depth: the normal path must keep working).
 *  4. `autoRetryFinal` surfaces the buffered error and lets the queue
 *     complete (fall-through, not break).
 *  5. `autoRetryFinal + autoRetryCancelled` suppresses the error (a cancel
 *     is not a failure report).
 *  6. A successful retry round (non-error message_end) drops the buffer.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { PiEventAdapter } from './event-adapter.ts';

function collect<T>(gen: Generator<T>): T[] {
  return [...gen];
}

const TRANSIENT_ERROR = '503 Service Unavailable';

function errorMessageEnd(overrides: Record<string, unknown> = {}) {
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      stopReason: 'error',
      errorMessage: TRANSIENT_ERROR,
      content: [],
    },
    ...overrides,
  } as any;
}

function agentEnd(overrides: Record<string, unknown> = {}) {
  return {
    type: 'agent_end',
    messages: [{ role: 'assistant', stopReason: 'error', errorMessage: TRANSIENT_ERROR }],
    ...overrides,
  } as any;
}

describe('PiEventAdapter — subprocess auto-retry lane', () => {
  let adapter: PiEventAdapter;

  beforeEach(() => {
    adapter = new PiEventAdapter();
    adapter.startTurn();
  });

  it('buffers an autoRetryPlanned message_end instead of surfacing the error', () => {
    const events = collect(adapter.adaptEvent(errorMessageEnd({ autoRetryPlanned: true })));

    // Nothing may reach the UI — the retry scheduler owns the turn now.
    expect(events).toHaveLength(0);
  });

  it('holds the queue on an autoRetryPending agent_end', () => {
    collect(adapter.adaptEvent(errorMessageEnd({ autoRetryPlanned: true })));

    const complete = adapter.shouldCompleteQueue(true, undefined, undefined, true);
    expect(complete).toBe(false);

    // A later un-annotated terminal still surfaces the buffered error.
    const terminal = collect(adapter.adaptEvent(agentEnd()));
    const errors = terminal.filter((e) => e.type === 'error' || e.type === 'typed_error');
    expect(errors).toHaveLength(1);
  });

  it('shouldCompleteQueue 4th param clears the hold when no auto-retry pending', () => {
    collect(adapter.adaptEvent(errorMessageEnd({ autoRetryPlanned: true })));

    // Hold…
    expect(adapter.shouldCompleteQueue(true, undefined, undefined, true)).toBe(false);
    // …then a terminal agent_end with no flag clears it and completes.
    expect(adapter.shouldCompleteQueue(true, undefined, undefined, undefined)).toBe(true);
  });

  it('surfaces the buffered error once on an autoRetryFinal agent_end and completes', () => {
    collect(adapter.adaptEvent(errorMessageEnd({ autoRetryPlanned: true })));

    const terminal = collect(adapter.adaptEvent(agentEnd({ autoRetryFinal: true, messages: [] })));
    const errors = terminal.filter((e) => e.type === 'error' || e.type === 'typed_error');
    expect(errors).toHaveLength(1);
    const first = errors[0] as { type: string; message?: string; error?: { message?: string } };
    const surfacedText = first.type === 'typed_error' ? first.error?.message : first.message;
    // parseError may rewrite provider text into a friendlier message — only
    // assert that SOMETHING user-facing was surfaced exactly once.
    expect(typeof surfacedText === 'string' && surfacedText.length > 0).toBe(true);
    // Fall-through: no hold flags left, queue may complete.
    expect(adapter.shouldCompleteQueue(true)).toBe(true);
  });

  it('suppresses the buffered error on an autoRetryFinal + cancelled agent_end', () => {
    collect(adapter.adaptEvent(errorMessageEnd({ autoRetryPlanned: true })));

    const terminal = collect(
      adapter.adaptEvent(agentEnd({ autoRetryFinal: true, autoRetryCancelled: true, messages: [] })),
    );
    const errors = terminal.filter((e) => e.type === 'error' || e.type === 'typed_error');
    expect(errors).toHaveLength(0);
    // Queue still completes (cancel closes the turn cleanly).
    expect(adapter.shouldCompleteQueue(true)).toBe(true);
  });

  it('drops the buffered error when a retry round produces a non-error assistant', () => {
    collect(adapter.adaptEvent(errorMessageEnd({ autoRetryPlanned: true })));

    // The retried turn recovers: a normal assistant message_end arrives.
    const recovered = collect(adapter.adaptEvent({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'recovered' }] },
    } as any));
    expect(recovered.length).toBeGreaterThan(0);

    // A later terminal must NOT surface the stale buffered error.
    const terminal = collect(adapter.adaptEvent(agentEnd()));
    const errors = terminal.filter((e) => e.type === 'error' || e.type === 'typed_error');
    expect(errors).toHaveLength(0);
  });

  it('resetOverflowState clears the auto-retry hold', () => {
    collect(adapter.adaptEvent(errorMessageEnd({ autoRetryPlanned: true })));
    expect(adapter.shouldCompleteQueue(true, undefined, undefined, true)).toBe(false);

    adapter.resetOverflowState();
    expect(adapter.shouldCompleteQueue(true)).toBe(true);
  });

  it('does not buffer an un-annotated transient error (SDK lane unchanged)', () => {
    // No autoRetryPlanned annotation: the SDK's own retry lane buffers it via
    // isRetryableAssistantError — same branch, same buffer, so this also
    // surfaces only at a terminal. Verify the buffer-not-surface invariant.
    const events = collect(adapter.adaptEvent(errorMessageEnd()));
    expect(events).toHaveLength(0);
  });
});
