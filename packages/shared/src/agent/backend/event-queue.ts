/**
 * Event Queue for Async Generator Pattern
 *
 * Bridges async event handlers (.on() listeners) with AsyncGenerator<AgentEvent>.
 * Used by PiAgent where events arrive asynchronously from a subprocess JSONL
 * stream, unlike ClaudeAgent's synchronous for-await loop over SDK messages.
 *
 * Pattern:
 *   handler calls enqueue(event) → pushes to queue, wakes waiters
 *   chat() loop calls drain()   → yields queued events, waits when empty
 *   handler calls complete()    → signals no more events
 */

import type { AgentEvent } from '@craft-agent/core/types';

export class EventQueue {
  private queue: AgentEvent[] = [];
  private resolvers: Array<(done: boolean) => void> = [];
  private done: boolean = false;

  /**
   * Enqueue an event and wake any waiting consumers.
   */
  enqueue(event: AgentEvent): void {
    if (this.done) {
      // Fallback diagnostic (2026-08-23): an event arriving after complete()
      // has already drained is consumed by NOBODY — the chat() loop has
      // exited and the next turn's reset() will discard it. This is the
      // signature of a cross-process lifecycle mismatch (e.g. a defense
      // resume / overflow recovery turn arriving after the queue closed).
      // The main-process fixes hold the queue open across those flows; this
      // warn is the last line of defense so a recurrence is visible in logs.
      // eslint-disable-next-line no-console
      console.warn(`[EventQueue] enqueue after complete — event dropped: ${event.type}`);
    }
    this.queue.push(event);
    this.signal(false);
  }

  /**
   * Signal that the turn is complete — no more events expected.
   * Wakes all waiting consumers with done=true.
   */
  complete(): void {
    this.done = true;
    this.signal(true);
  }

  /**
   * Reset queue state for a new turn.
   * Must be called before each chat() invocation.
   */
  reset(): void {
    this.queue = [];
    this.resolvers = [];
    this.done = false;
  }

  /**
   * Async generator that yields events as they arrive.
   * Completes when complete() is called and the queue is drained.
   */
  async *drain(): AsyncGenerator<AgentEvent> {
    while (true) {
      const isDone = await this.waitForEvent();

      // Yield all queued events
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }

      if (isDone) break;
    }
  }

  /**
   * Check if the queue has pending events.
   */
  get hasPending(): boolean {
    return this.queue.length > 0;
  }

  /**
   * Check if the queue has been marked complete.
   */
  get isComplete(): boolean {
    return this.done;
  }

  // ============================================================
  // Internal
  // ============================================================

  /**
   * Wake all waiting consumers.
   */
  private signal(done: boolean): void {
    const pending = this.resolvers.splice(0);
    for (const resolve of pending) {
      resolve(done);
    }
  }

  /**
   * Wait for events to be available or completion signal.
   * Returns true when turn is complete and queue is empty.
   */
  private waitForEvent(): Promise<boolean> {
    if (this.queue.length > 0 || this.done) {
      return Promise.resolve(this.done && this.queue.length === 0);
    }
    return new Promise((resolve) => {
      this.resolvers.push(resolve);
    });
  }
}
