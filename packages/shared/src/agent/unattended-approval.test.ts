/**
 * Stage 2 policy: asking must not hang when there is nobody to ask.
 *
 * The failure this pins: `ask` mode parks a tool call until a person approves.
 * A channel-woken (or scheduled) session has no window open, so the call parked
 * forever, the stall watchdog killed the turn, and the person who triggered the
 * work saw nothing at all. Refusing with a reason the assistant can relay ends
 * the turn cleanly instead.
 */

import { describe, expect, it } from 'bun:test';

import { decideApproval, isUnattended, UNATTENDED_REFUSAL_REASON } from './unattended-approval.ts';

describe('unattended approval policy', () => {
  it('parks the call when a person is watching', () => {
    expect(decideApproval({ attended: true, unattendedOrigin: false })).toBe('park');
  });

  it('parks when the session was woken by a channel but someone then opened it', () => {
    // Opening the window is the person showing up; parking is right — they are
    // watching the question appear.
    expect(decideApproval({ attended: true, unattendedOrigin: true })).toBe('park');
  });

  it('refuses instead of parking when nobody is watching', () => {
    expect(decideApproval({ attended: false, unattendedOrigin: true })).toBe('refuse');
  });

  it('treats an unknown-origin session with no window as unattended, not parkable', () => {
    expect(decideApproval({ attended: false, unattendedOrigin: false })).toBe('refuse');
  });

  it('never silently allows — the only non-park outcome is a refusal', () => {
    const outcomes = [
      decideApproval({ attended: true, unattendedOrigin: false }),
      decideApproval({ attended: true, unattendedOrigin: true }),
      decideApproval({ attended: false, unattendedOrigin: true }),
      decideApproval({ attended: false, unattendedOrigin: false }),
    ];
    expect(outcomes.every((o) => o === 'park' || o === 'refuse')).toBe(true);
  });

  it('exposes one predicate that matches the decision', () => {
    expect(isUnattended({ attended: false, unattendedOrigin: true })).toBe(true);
    expect(isUnattended({ attended: true, unattendedOrigin: true })).toBe(false);
    expect(isUnattended({ attended: false, unattendedOrigin: false })).toBe(true);
  });

  it('gives the model a reason it can relay, not a user-blame message', () => {
    expect(UNATTENDED_REFUSAL_REASON).toContain('需要人确认');
    expect(UNATTENDED_REFUSAL_REASON).toContain('不要重试');
    // The old blanket message blamed the user, who was never asked.
    expect(UNATTENDED_REFUSAL_REASON).not.toBe('Permission denied by user.');
  });
});
