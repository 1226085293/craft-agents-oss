/**
 * Batch window boundaries (D3).
 *
 * These pin the two easy-to-get-wrong edges: the message that arrives after the
 * window belongs to the NEXT batch (not the one that just expired), and the
 * 10-message cap closes on the message that reaches it.
 */
import { describe, expect, it } from 'bun:test';

import {
  BATCH_MAX_MESSAGES,
  BATCH_WINDOW_MS,
  addToBatch,
  isBatchExpired,
  openBatch,
  type BatchMessage,
} from './batch-window.ts';

const msg = (id: string, at: number, mentionsBot = false): BatchMessage => ({ eventId: id, at, mentionsBot });

describe('batch window', () => {
  it('stays open before the window elapses', () => {
    const batch = openBatch(msg('a', 0));
    expect(isBatchExpired(batch, BATCH_WINDOW_MS - 1)).toBe(false);
  });

  it('closes exactly at the window edge', () => {
    const batch = openBatch(msg('a', 0));
    expect(isBatchExpired(batch, BATCH_WINDOW_MS)).toBe(true);
  });

  it('appends a message that arrives inside the window', () => {
    const batch = openBatch(msg('a', 0));
    const decision = addToBatch(batch, msg('b', 1000));
    expect(decision.action).toBe('append');
    if (decision.action === 'append') expect(decision.batch.messages).toHaveLength(2);
  });

  it('starts a new batch for a message after the window — it must not join the expired one', () => {
    const batch = openBatch(msg('a', 0));
    const decision = addToBatch(batch, msg('b', BATCH_WINDOW_MS + 1));
    expect(decision.action).toBe('close');
    if (decision.action === 'close') {
      expect(decision.closed.messages.map((m) => m.eventId)).toEqual(['a']);
      expect(decision.next.messages.map((m) => m.eventId)).toEqual(['b']);
    }
  });

  it('closes on the message that reaches the cap', () => {
    let batch = openBatch(msg('m0', 0));
    let last: ReturnType<typeof addToBatch> | undefined;
    for (let i = 1; i < BATCH_MAX_MESSAGES; i += 1) {
      last = addToBatch(batch, msg(`m${i}`, i));
      if (last.action === 'append') batch = last.batch;
    }
    expect(last?.action).toBe('close');
    if (last?.action === 'close') expect(last.closed.messages).toHaveLength(BATCH_MAX_MESSAGES);
  });

  it('closes immediately when the message mentions the bot', () => {
    const batch = openBatch(msg('a', 0));
    const decision = addToBatch(batch, msg('b', 10, true));
    expect(decision.action).toBe('close');
    if (decision.action === 'close') expect(decision.closed.messages).toHaveLength(2);
  });
});
