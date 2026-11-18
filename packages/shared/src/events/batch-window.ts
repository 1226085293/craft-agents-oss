/**
 * Batch window (D3, stage 5): when is a burst of chat messages one decision?
 *
 * The problem it solves: a person typing four short messages in a row is making
 * one request. Judging each message separately costs four model calls, and worse,
 * the first three get judged without the context the fourth supplies —
 * 「把这个改一下」 means nothing until the next line says what.
 *
 * The rule fixed in v7: close a batch at **10 messages** or **5 minutes after the
 * first message**, whichever comes first; a new message after the close starts a
 * new batch. `@bot` is a fast lane that closes immediately — someone addressing
 * the bot by name is asking for attention now, not for a queue.
 *
 * Deliberately pure: the window is a decision about *when*, and keeping it free
 * of storage and timers means the rule can be tested exactly (including the
 * boundary cases) without waiting five minutes.
 */

/** Messages in one batch before it closes regardless of time. */
export const BATCH_MAX_MESSAGES = 10;

/** How long after the first message a batch closes. */
export const BATCH_WINDOW_MS = 5 * 60 * 1000;

export interface BatchMessage {
  /** Stable id, so a re-delivered event is not counted twice. */
  eventId: string;
  /** When the message arrived. */
  at: number;
  /** The sender addressed the bot by name (or @mention). */
  mentionsBot?: boolean;
}

export interface BatchState {
  /** Messages collected so far, oldest first. */
  messages: BatchMessage[];
  /** Arrival time of the first message — the clock the window runs on. */
  openedAt: number;
}

export function openBatch(first: BatchMessage): BatchState {
  return { messages: [first], openedAt: first.at };
}

/** Is this batch due to close at `now`, ignoring any new message? */
export function isBatchExpired(batch: BatchState, now: number): boolean {
  if (batch.messages.length >= BATCH_MAX_MESSAGES) return true;
  return now - batch.openedAt >= BATCH_WINDOW_MS;
}

export type BatchDecision =
  | { action: 'append'; batch: BatchState }
  | { action: 'close'; closed: BatchState; next: BatchState };

/**
 * Add a message to the batch (or start a new one when the old one already closed).
 *
 * `now` is when this message arrived, and it is used to decide whether the
 * *previous* batch expired before it: the message that arrives after the window
 * belongs to the next batch, not to the one that just timed out. That ordering is
 * the part worth pinning — closing after appending would silently widen every
 * window by one message.
 */
export function addToBatch(batch: BatchState | undefined, message: BatchMessage): BatchDecision {
  if (batch && isBatchExpired(batch, message.at)) {
    return { action: 'close', closed: batch, next: openBatch(message) };
  }
  if (!batch) {
    return { action: 'close', closed: { messages: [], openedAt: message.at }, next: openBatch(message) };
  }

  const messages = [...batch.messages, message];
  const appended: BatchState = { ...batch, messages };

  // A mention closes immediately: someone naming the bot wants an answer now.
  if (message.mentionsBot) {
    return { action: 'close', closed: appended, next: { messages: [], openedAt: message.at } };
  }
  if (messages.length >= BATCH_MAX_MESSAGES) {
    return { action: 'close', closed: appended, next: { messages: [], openedAt: message.at } };
  }
  return { action: 'append', batch: appended };
}


