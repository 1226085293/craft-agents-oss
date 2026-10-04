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
 * - RELEASE (2026-10-07 active-wren): when the drained continuation's own
 *   terminal stop arrives with NO pending signal (no assistantFollowUpPending
 *   stamp, queue_update empty), it is by definition the turn's LAST reply —
 *   the continuation holds are released so it is emitted as the result
 *   bubble (isIntermediate:false). Without the release the hold was sticky
 *   and the turn's actual answer was demoted into the process card (“没有回复，
 *   然后中断了”).
 * - No signal at all → stop text remains a final bubble (regression).
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

  it('assistantFollowUpPending: the main reply stays a result bubble; the drained continuation\'s clean stop is the second result bubble', () => {
    adapter.startTurn();
    const events = emitStop(adapter, { assistantFollowUpPending: true });
    const tc = events.find((e) => e.type === 'text_complete');
    expect(tc).toBeDefined();
    // 2026-10-07 plain-jade: the main reply is NOT demoted anymore — it is
    // shown as a result bubble the moment it completes; the drain round's
    // reply becomes a second result bubble. No demote/promote bookkeeping.
    expect(tc.isIntermediate).toBe(false);
    // No final bookkeeping yet: the one-final gate was released for the
    // drain round.
    expect(events.find((e) => e.type === 'text_demote')).toBeUndefined();
    expect(events.find((e) => e.type === 'text_promote')).toBeUndefined();
    expect(events.find((e) => e.type === 'complete')).toBeUndefined();

    // The contained-continuation reply (the drained steer/followUp answer):
    // no pending stamp, no non-empty queue_update — nothing is left to drain,
    // so this is the turn's second result bubble. The sticky hold must be
    // released here (active-wren).
    const cont = collect(adapter.adaptEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        id: 'cont-msg',
        stopReason: 'stop',
        content: [{ type: 'text', text: '更新完成。' }],
      },
    } as any));
    const contTc = cont.find((e) => e.type === 'text_complete');
    expect(contTc).toBeDefined();
    expect(contTc.isIntermediate).toBe(false);
    // Nothing was demoted, so nothing gets re-promoted.
    expect(cont.find((e) => e.type === 'text_promote')).toBeUndefined();

    // FINAL agent_end (no flag) completes the turn.
    const end = collect(adapter.adaptEvent({ type: 'agent_end' } as any));
    expect(end.find((e) => e.type === 'complete')).toBeDefined();
    expect(end.find((e) => e.type === 'text_demote')).toBeUndefined();
  });

  it('active-wren regression: queue_update non-empty → main reply stays a bubble → drain clears queue → drained reply is the second bubble', () => {
    adapter.startTurn();
    // Steer “你叫什么名字” queued mid-turn (03:57:14 in the incident).
    collect(adapter.adaptEvent({
      type: 'queue_update',
      steering: ['你叫什么名字'],
      followUp: [],
    } as any));
    // Main reply (folder list) ends while the steer is still pending →
    // subprocess stamps assistantFollowUpPending. 2026-10-07 plain-jade:
    // it is NOT demoted — shown as a result bubble right away.
    const main = emitStop(adapter, { assistantFollowUpPending: true });
    expect(main.find((e) => e.type === 'text_complete').isIntermediate).toBe(false);
    expect(main.find((e) => e.type === 'text_demote')).toBeUndefined();
    // SDK drains the steer: its user message starts, queue_update clears.
    collect(adapter.adaptEvent({
      type: 'message_start',
      message: { role: 'user', content: [{ type: 'text', text: '你叫什么名字' }] },
    } as any));
    collect(adapter.adaptEvent({
      type: 'queue_update',
      steering: [],
      followUp: [],
    } as any));
    // The drained reply (name answer) — terminal stop, nothing pending.
    // The one-final gate was released by the main stop, so this reply
    // claims it and becomes the second result bubble.
    const drained = collect(adapter.adaptEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        id: 'drain-msg',
        stopReason: 'stop',
        content: [{ type: 'text', text: '我是 Craft Agent。' }],
      },
    } as any));
    const drainedTc = drained.find((e) => e.type === 'text_complete');
    expect(drainedTc).toBeDefined();
    expect(drainedTc.text).toBe('我是 Craft Agent。');
    expect(drainedTc.isIntermediate).toBe(false);
    // Two bubbles, no promote/demote bookkeeping (nothing was demoted).
    expect(drained.find((e) => e.type === 'text_promote')).toBeUndefined();
    expect(drained.find((e) => e.type === 'text_demote')).toBeUndefined();
    // Turn completes on the flagless agent_end.
    const end = collect(adapter.adaptEvent({ type: 'agent_end' } as any));
    expect(end.find((e) => e.type === 'complete')).toBeDefined();
  });

  it('wise-horizon regression: no re-promotion duplicates — the main reply is emitted once, as a bubble, the moment it completes', () => {
    adapter.startTurn();
    collect(adapter.adaptEvent({
      type: 'queue_update',
      steering: ['还有你叫什么？'],
      followUp: [],
    } as any));
    const main = emitStop(adapter, { assistantFollowUpPending: true });
    // Shown immediately as a result bubble (2026-10-07 plain-jade).
    expect(main.find((e) => e.type === 'text_complete').isIntermediate).toBe(false);
    // SDK drains the steer: its user message starts, queue_update clears.
    collect(adapter.adaptEvent({
      type: 'message_start',
      message: { role: 'user', content: [{ type: 'text', text: '还有你叫什么？' }] },
    } as any));
    collect(adapter.adaptEvent({
      type: 'queue_update',
      steering: [],
      followUp: [],
    } as any));
    // Drain round 1 (the steer's answer): a second result bubble.
    const d1 = collect(adapter.adaptEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        id: 'drain-1',
        stopReason: 'stop',
        content: [{ type: 'text', text: '我是 Craft Agent。' }],
      },
    } as any));
    expect(d1.find((e) => e.type === 'text_complete').isIntermediate).toBe(false);
    // No demotion ever happened → nothing to promote, anywhere.
    expect(d1.filter((e) => e.type === 'text_promote').length).toBe(0);
    // No second drain follows; a flagless agent_end completes the turn and
    // must NOT emit promote/demote either.
    const end = collect(adapter.adaptEvent({ type: 'agent_end' } as any));
    expect(end.find((e) => e.type === 'text_promote')).toBeUndefined();
    expect(end.find((e) => e.type === 'text_demote')).toBeUndefined();
    expect(end.find((e) => e.type === 'complete')).toBeDefined();
  });

  it('no steer — plain final reply emits no text_promote (regression)', () => {
    adapter.startTurn();
    const events = emitStop(adapter);
    expect(events.find((e) => e.type === 'text_complete').isIntermediate).toBe(false);
    expect(events.find((e) => e.type === 'text_promote')).toBeUndefined();
  });

  it('queue_update with non-empty queues before a stop keeps it a result bubble (pending drain released the gate)', () => {
    adapter.startTurn();
    collect(adapter.adaptEvent({
      type: 'queue_update',
      steering: ['。'],
      followUp: [],
    } as any));
    const events = emitStop(adapter); // no assistantFollowUpPending stamp (signal comes from queue_update state)
    const tc = events.find((e) => e.type === 'text_complete');
    expect(tc).toBeDefined();
    // 2026-10-07 plain-jade: the reply that finished while the hold opened
    // stays a bubble (isIntermediate=false); the drain round's reply claims
    // the released one-final gate.
    expect(tc.isIntermediate).toBe(false);
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
