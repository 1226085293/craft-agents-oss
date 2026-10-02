/**
 * Program-side verification hold (2026-10-02 user-approved redesign):
 * when an agent_end carries defenseVerificationPending, the adapter holds the
 * queue open (NO complete event) until the subprocess reports
 * `verification_result`. passed=true → finalizeVerificationHeld(true) sets
 * pendingQueueComplete → the next shouldCompleteQueue call terminates the
 * queue so the main process can replay the captured final reply. passed=false
 * → the hold releases and the followUp continuation's own agent_end settles
 * the queue normally.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { PiEventAdapter } from './event-adapter.ts';

describe('PiEventAdapter — program-side verification hold (2026-10-02)', () => {
  let adapter: PiEventAdapter;

  beforeEach(() => {
    adapter = new PiEventAdapter();
    adapter.startTurn();
  });

  it('agent_end with defenseVerificationPending holds the queue open', () => {
    expect(adapter.shouldCompleteQueue(true, false, false, true)).toBe(false);
    // No resume/followUp is scheduled — the queue may only finish via
    // verification_result (finalize) or the terminal path.
    expect(adapter.shouldCompleteQueue(false, false, false, false)).toBe(false);
  });

  it('finalizeVerificationHeld(true) lets the next check complete the queue (replay path)', () => {
    adapter.shouldCompleteQueue(true, false, false, true);
    adapter.finalizeVerificationHeld(true);
    expect(adapter.shouldCompleteQueue(false, false, false, false)).toBe(true);
  });

  it('finalizeVerificationHeld(false) does NOT complete the queue (followUp path holds)', () => {
    adapter.shouldCompleteQueue(true, false, false, true);
    adapter.finalizeVerificationHeld(false);
    // Follow-up continuation still in flight: hold stays open.
    expect(adapter.shouldCompleteQueue(false, false, false, false)).toBe(false);
    // The continuation's own agent_end (no verification flag) settles it.
    expect(adapter.shouldCompleteQueue(true, false, false, false)).toBe(true);
  });

  it('a plain agent_end after a held verification clears the hold state', () => {
    adapter.shouldCompleteQueue(true, false, false, true);
    expect(adapter.shouldCompleteQueue(true, false, false, false)).toBe(true);
  });

  it('agent_end with defenseVerificationPending demotes the draft reply to a process step', () => {
    // Main turn: a normal final reply was emitted.
    adapter.startTurn();
    const finals = [...adapter.adaptEvent({
      type: 'message_end',
      message: { role: 'assistant', id: 'f1', stopReason: 'stop', content: [{ type: 'text', text: '草稿终稿' }] },
    } as any)].filter(e => e.type === 'text_complete') as any[];
    expect(finals).toHaveLength(1);
    expect(finals[0]!.isIntermediate).toBe(false);

    // Verification pending on agent_end → the draft is demoted so the
    // verified replay (or follow-up) is the single final bubble.
    const events = [...adapter.adaptEvent({ type: 'agent_end', defenseVerificationPending: true } as any)] as any[];
    const demote = events.find(e => e.type === 'text_demote');
    expect(demote).toBeDefined();
    expect(demote!.turnId).toBe(finals[0]!.turnId);

    // A second hold must NOT re-demote (turnId was cleared).
    const events2 = [...adapter.adaptEvent({ type: 'agent_end', defenseVerificationPending: true } as any)] as any[];
    expect(events2.find(e => e.type === 'text_demote')).toBeUndefined();
  });

  it('verification hold is independent from defense-resume hold (mutually exclusive flags)', () => {
    // agent_end carrying BOTH flags: resume wins first (checked before verify).
    adapter.shouldCompleteQueue(true, true, false, true);
    expect(adapter.shouldCompleteQueue(false, false, false, false)).toBe(false);
    adapter.finalizeDefenseResumeHeld();
    expect(adapter.shouldCompleteQueue(false, false, false, false)).toBe(true);
  });
});
describe('PiEventAdapter — late verification_result after hold release', () => {
  let adapter: PiEventAdapter;

  beforeEach(() => {
    adapter = new PiEventAdapter();
    adapter.startTurn();
  });

  it('finalizeVerificationHeld after the hold was released (interrupt) is a no-op', () => {
    adapter.shouldCompleteQueue(true, false, false, true); // hold on
    expect(adapter.isVerificationHeld()).toBe(true);

    // Simulate the user interrupting mid-judge: resetRecoveryState() clears
    // the hold (pi-agent.ts interrupt path).
    adapter.resetRecoveryState();
    expect(adapter.isVerificationHeld()).toBe(false);

    // The late stale PASS result must not set pendingQueueComplete or
    // otherwise touch the next turn's queue state.
    adapter.finalizeVerificationHeld(true);
    adapter.startTurn(); // next turn begins
    expect(adapter.shouldCompleteQueue(false, false, false, false)).toBe(false);
    // The next turn's plain agent_end settles the queue normally — no
    // premature completion from the stale result.
    expect(adapter.shouldCompleteQueue(true, false, false, false)).toBe(true);
  });

  it('isVerificationHeld reflects the hold lifecycle end to end', () => {
    expect(adapter.isVerificationHeld()).toBe(false);
    adapter.shouldCompleteQueue(true, false, false, true);
    expect(adapter.isVerificationHeld()).toBe(true);
    adapter.finalizeVerificationHeld(false);
    expect(adapter.isVerificationHeld()).toBe(false);
  });
});
