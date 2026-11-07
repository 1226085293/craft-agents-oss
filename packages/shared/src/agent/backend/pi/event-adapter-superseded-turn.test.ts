/**
 * Superseded-run hold (2026-11-07, session 261105-onyx-steel).
 *
 * Symptom the user reported: "send a message and it silently aborts" — and,
 * once they looked closer, "it still seems to be running in the background,
 * but I see no messages".
 *
 * Mechanism: the session still had a run that never settled (a relay that
 * answered 200 + text/event-stream and then streamed zero bytes). A new user
 * message therefore arrived while `session.isStreaming` was true, and the
 * subprocess aborted the stale run first (`settleStreamingSessionBeforePrompt`).
 * That abort's `agent_end` reached the adapter and completed the event queue —
 * closing the BRAND NEW turn 39 ms after it started. The subprocess then ran
 * the real prompt normally (requests, 134+ SSE events, tool calls), all of it
 * landing in a closed iterator. Every subsequent message repeated the cycle
 * because the unconsumed run kept `isStreaming` true.
 *
 * Contract: an `agent_end` annotated `supersededByFreshTurn: true` must NOT
 * complete the queue; the queue is held until the fresh turn's `agent_start`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
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

/** Feed a raw SDK event and return everything it adapted to. */
function adapt(adapter: PiEventAdapter, event: any): any[] {
  return collect(adapter.adaptEvent(event));
}

describe('PiEventAdapter — superseded run must not close the fresh turn (2026-11-07)', () => {
  let adapter: PiEventAdapter;

  beforeEach(() => {
    adapter = new PiEventAdapter();
    adapter.startTurn();
  });

  afterEach(() => {
    adapter.resetRecoveryState();
  });

  it('holds the queue instead of completing on a superseded agent_end', () => {
    const events = adapt(adapter, { type: 'agent_end', supersededByFreshTurn: true });

    // Nothing terminal may be emitted: the user's turn has not produced a token.
    expect(events.some(e => e.type === 'complete')).toBe(false);
    expect(adapter.shouldCompleteQueue(true, false, false, false)).toBe(false);
  });

  it('releases the hold on the fresh turn\'s agent_start and then completes normally', () => {
    adapt(adapter, { type: 'agent_end', supersededByFreshTurn: true });
    expect(adapter.shouldCompleteQueue(true, false, false, false)).toBe(false);

    // The fresh turn starts — the hold must be gone.
    adapt(adapter, { type: 'agent_start' });

    // ...and its own terminal closes the queue as usual.
    adapt(adapter, {
      type: 'message_end',
      message: {
        role: 'assistant',
        id: 'answer1',
        stopReason: 'stop',
        content: [{ type: 'text', text: '这是新回合的回答。' }],
      },
    });
    adapt(adapter, { type: 'agent_end' });
    expect(adapter.shouldCompleteQueue(true, false, false, false)).toBe(true);
  });

  it('keeps the fresh turn\'s text flowing while the hold is released', () => {
    adapt(adapter, { type: 'agent_end', supersededByFreshTurn: true });
    adapt(adapter, { type: 'agent_start' });

    const messageEvents = adapt(adapter, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: '第一段' },
    });
    // Streaming deltas are not swallowed by the hold machinery.
    expect(messageEvents.some(e => e.type === 'text_delta' && e.text === '第一段')).toBe(true);
  });

  it('does not demote the previous turn\'s draft into a completion', () => {
    // A superseded run may have produced a draft (it was the run the user
    // walked away from). The hold must fold it into the process block only —
    // never let it stand as the answer to the new turn.
    const draftEvents = adapt(adapter, {
      type: 'message_end',
      message: {
        role: 'assistant',
        id: 'draft-old',
        stopReason: 'aborted',
        content: [{ type: 'text', text: '旧的未完成答复' }],
      },
    });
    const draft = draftEvents.find(e => e.type === 'text_complete' && e.isIntermediate === false);

    const holdEvents = adapt(adapter, { type: 'agent_end', supersededByFreshTurn: true });
    expect(holdEvents.some(e => e.type === 'complete')).toBe(false);
    if (draft) {
      const demote = holdEvents.find(e => e.type === 'text_demote');
      expect(demote?.turnId).toBe(draft.turnId);
    }
  });

  it('a normal agent_end still completes when no hold is involved', () => {
    // Guard against the new branch swallowing ordinary turn ends.
    adapt(adapter, { type: 'agent_start' });
    adapt(adapter, {
      type: 'message_end',
      message: {
        role: 'assistant',
        id: 'plain',
        stopReason: 'stop',
        content: [{ type: 'text', text: '完成。' }],
      },
    });
    const endEvents = adapt(adapter, { type: 'agent_end' });
    expect(adapter.shouldCompleteQueue(true, false, false, false)).toBe(true);
    expect(endEvents.some(e => e.type === 'complete')).toBe(true);
  });
});
