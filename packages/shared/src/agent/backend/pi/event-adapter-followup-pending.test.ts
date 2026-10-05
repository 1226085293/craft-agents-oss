/**
 * Mid-turn follow-up continuation guard (2026-10-05 smooth-gorge double
 * bubble): when the SDK's steering/followUp queues still hold user messages
 * at the moment an assistant stop-text is emitted, the SDK injects them via
 * agent.continue() right AFTER this message (same turn, no new turn_start) —
 * see node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js
 * `_runAgentPrompt` / `agent.continue()`.
 *
 * Contract:
 * - `message_end` carrying `assistantFollowUpPending:true` (stamped by
 *   pi-agent-server when pendingMessageCount>0) OR a preceding `queue_update`
 *   with non-empty queues → the stop text is a PROCESS STEP (isIntermediate),
 *   never a result bubble; the queue stays open until the FINAL `agent_end`
 *   (no flag) completes it.
 * - No signal → stop text remains a final bubble (regression).
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { PiEventAdapter } from './event-adapter.ts';

function collect(gen: Generator<any, any, any>): any[] {
  const out: any[] = [];
  let r = gen.next();
  while (!r.done) {
    out.push(r.value);
    r = gen.next();
  }
  return out;
}

/** Emit one assistant stop message via the adapter; returns collected events.
 *  Note: the caller is responsible for `startTurn()` — it resets the
 *  follow-up pending signals under test, so it must run BEFORE any
 *  `queue_update` / signal stamps. */
function emitStop(
  adapter: PiEventAdapter,
  extra: Record<string, unknown> = {},
): any[] {
  return collect(
    adapter.adaptEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        id: 'stop-msg',
        stopReason: 'stop',
        content: [{ type: 'text', text: '✅ 任务完成。工作区干净，已提交。' }],
      },
      ...extra,
    } as any),
  );
}

describe('PiEventAdapter — mid-turn follow-up continuation (2026-10-05)', () => {
  let adapter: PiEventAdapter;

  beforeEach(() => {
    adapter = new PiEventAdapter();
  });

  it('assistantFollowUpPending marks the stop text intermediate and holds the queue open until the final agent_end', () => {
    adapter.startTurn();
    const events = emitStop(adapter, { assistantFollowUpPending: true });
    const tc = events.find((e) => e.type === 'text_complete');
    expect(tc).toBeDefined();
    expect(tc.isIntermediate).toBe(true);
    // No final bookkeeping: a later demote must not fire, and nothing was
    // recorded as the "final" text for this turn.
    expect(events.find((e) => e.type === 'text_demote')).toBeUndefined();
    expect(events.find((e) => e.type === 'complete')).toBeUndefined();

    // Contained-continuation events (e.g. the injected user message's reply)
    // stay process steps too while the hold is open.
    const cont = collect(adapter.adaptEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        id: 'cont-msg',
        stopReason: 'stop',
        content: [{ type: 'text', text: '更新完成。' }],
      },
    } as any));
    expect(cont.find((e) => e.type === 'text_complete').isIntermediate).toBe(true);

    // FINAL agent_end (no flag) completes the turn.
    const end = collect(adapter.adaptEvent({ type: 'agent_end' } as any));
    expect(end.find((e) => e.type === 'complete')).toBeDefined();
    expect(end.find((e) => e.type === 'text_demote')).toBeUndefined();
  });

  it('queue_update with non-empty queues before a stop marks it intermediate (backup signal)', () => {
    adapter.startTurn();
    collect(adapter.adaptEvent({
      type: 'queue_update',
      steering: ['。'],
      followUp: [],
    } as any));
    const events = emitStop(adapter); // no assistantFollowUpPending stamp (signal comes from queue_update state)
    const tc = events.find((e) => e.type === 'text_complete');
    expect(tc).toBeDefined();
    expect(tc.isIntermediate).toBe(true);
    expect(events.find((e) => e.type === 'complete')).toBeUndefined();
  });

  it('empty queue_update clears the pending signal — stop text stays final (regression)', () => {
    adapter.startTurn();
    collect(adapter.adaptEvent({
      type: 'queue_update',
      steering: [],
      followUp: [],
    } as any));
    const events = emitStop(adapter);
    const tc = events.find((e) => e.type === 'text_complete');
    expect(tc).toBeDefined();
    expect(tc.isIntermediate).toBe(false);
    const end = collect(adapter.adaptEvent({ type: 'agent_end' } as any));
    expect(end.find((e) => e.type === 'complete')).toBeDefined();
  });

  it('no signal at all — stop text remains a final bubble (regression)', () => {
    adapter.startTurn();
    const events = emitStop(adapter);
    const tc = events.find((e) => e.type === 'text_complete');
    expect(tc).toBeDefined();
    expect(tc.isIntermediate).toBe(false);
  });
});
