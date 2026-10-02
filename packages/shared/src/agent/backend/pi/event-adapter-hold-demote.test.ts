/**
 * Draft-reply demotion at hold-open points (2026-10-02 "bubble before the
 * session ends" bug): when agent_end holds the event queue open so the SAME
 * Craft turn continues later (overflow-compaction recovery, defense-resume
 * follow-up, queued steering/follow-up continuation, SDK auto-retry), any
 * already-emitted draft final reply must be demoted into the process block —
 * otherwise the UI shows a "final" bubble while the turn is still running
 * (user session 261002-alert-flow, 2026-10-02: reply bubble at 16:21 while
 * "Compacting context…" + tools kept running for 6+ more minutes).
 *
 * Contract: `text_demote { turnId }` is yielded exactly when a draft exists
 * AND the turn continues; a turn that actually ends (no hold) never demotes.
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

/** Emit a normal main-turn draft final reply; returns its turnId. */
function emitDraft(adapter: PiEventAdapter): string {
  adapter.startTurn();
  const events = collect(adapter.adaptEvent({
    type: 'message_end',
    message: {
      role: 'assistant',
      id: 'draft1',
      stopReason: 'stop',
      content: [{ type: 'text', text: '先摸清几处关键事实：' }],
    },
  } as any));
  const final = events.find((e) => e.type === 'text_complete');
  expect(final).toBeDefined();
  expect(final.isIntermediate).toBe(false);
  return final.turnId as string;
}

describe('PiEventAdapter — draft demotion at hold-open points (2026-10-02)', () => {
  let adapter: PiEventAdapter;

  beforeEach(() => {
    adapter = new PiEventAdapter();
  });

  it('overflow-compaction hold demotes the draft reply', () => {
    const draftTurn = emitDraft(adapter);
    // Next call overflows → the SDK will auto-compact + continue.
    const errEvents = collect(adapter.adaptEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        id: 'overflow1',
        stopReason: 'error',
        errorMessage: 'Prompt is too long: 250000 tokens > 131072 maximum',
      },
    } as any));
    // Overflow error is suppressed (no typed_error/error yielded).
    expect(errEvents.find((e) => e.type === 'error' || e.type === 'typed_error')).toBeUndefined();
    // agent_end → hold open; the draft must be demoted so it stops looking
    // like a finished reply while compaction + the recovered turn run.
    const endEvents = collect(adapter.adaptEvent({ type: 'agent_end' } as any));
    const demote = endEvents.find((e) => e.type === 'text_demote');
    expect(demote).toBeDefined();
    expect(demote.turnId).toBe(draftTurn);
    expect(endEvents.find((e) => e.type === 'complete')).toBeUndefined();
  });

  it('defense-resume hold demotes the draft reply', () => {
    const draftTurn = emitDraft(adapter);
    const endEvents = collect(adapter.adaptEvent({
      type: 'agent_end',
      defenseResumePending: true,
    } as any));
    const demote = endEvents.find((e) => e.type === 'text_demote');
    expect(demote).toBeDefined();
    expect(demote.turnId).toBe(draftTurn);
    expect(endEvents.find((e) => e.type === 'complete')).toBeUndefined();
  });

  it('queued-followUp hold demotes the draft reply', () => {
    const draftTurn = emitDraft(adapter);
    const endEvents = collect(adapter.adaptEvent({
      type: 'agent_end',
      queuedFollowUpPending: true,
    } as any));
    const demote = endEvents.find((e) => e.type === 'text_demote');
    expect(demote).toBeDefined();
    expect(demote.turnId).toBe(draftTurn);
    expect(endEvents.find((e) => e.type === 'complete')).toBeUndefined();
  });

  it('verification hold demotes the draft reply (existing behavior, via helper)', () => {
    const draftTurn = emitDraft(adapter);
    const endEvents = collect(adapter.adaptEvent({
      type: 'agent_end',
      defenseVerificationPending: true,
    } as any));
    const demotes = endEvents.filter((e) => e.type === 'text_demote');
    expect(demotes).toHaveLength(1);
    expect(demotes[0]!.turnId).toBe(draftTurn);
  });

  it('SDK retry hold demotes the draft reply', () => {
    const draftTurn = emitDraft(adapter);
    const endEvents = collect(adapter.adaptEvent({
      type: 'agent_end',
      willRetry: true,
    } as any));
    const demote = endEvents.find((e) => e.type === 'text_demote');
    expect(demote).toBeDefined();
    expect(demote.turnId).toBe(draftTurn);
    expect(endEvents.find((e) => e.type === 'complete')).toBeUndefined();
  });

  it('no demotion when a hold had no draft to demote (idempotent)', () => {
    adapter.startTurn();
    // No final text emitted (only toolUse intermediates).
    collect(adapter.adaptEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        id: 'tool1',
        stopReason: 'toolUse',
        content: [{ type: 'text', text: 'doing work' }],
      },
    } as any));
    const endEvents = collect(adapter.adaptEvent({
      type: 'agent_end',
      defenseResumePending: true,
    } as any));
    expect(endEvents.find((e) => e.type === 'text_demote')).toBeUndefined();
  });

  it('terminal agent_end (no hold) completes without demoting', () => {
    const draftTurn = emitDraft(adapter);
    const endEvents = collect(adapter.adaptEvent({ type: 'agent_end' } as any));
    expect(endEvents.find((e) => e.type === 'text_demote')).toBeUndefined();
    const complete = endEvents.find((e) => e.type === 'complete');
    expect(complete).toBeDefined();
    // The draft stays a final bubble (turn actually ended).
    void draftTurn;
  });
});
