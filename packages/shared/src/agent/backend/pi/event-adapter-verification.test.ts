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

  it('verification hold is independent from defense-resume hold (mutually exclusive flags)', () => {
    // agent_end carrying BOTH flags: resume wins first (checked before verify).
    adapter.shouldCompleteQueue(true, true, false, true);
    expect(adapter.shouldCompleteQueue(false, false, false, false)).toBe(false);
    adapter.finalizeDefenseResumeHeld();
    expect(adapter.shouldCompleteQueue(false, false, false, false)).toBe(true);
  });
});