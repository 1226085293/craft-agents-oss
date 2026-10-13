import { describe, expect, it } from 'bun:test';
import { State } from './session-lifecycle.ts';
import { DefenseEvaluator } from './evaluator.ts';

/**
 * Verification triggering contract (2026-10-12 decision): verification is NOT
 * limited to one attempt per turn — the 2026-10-05 "verify-once-per-turn"
 * cap is removed, AND the verification lane is NOT bounded by the maxResumes
 * recovery budget either. Every stop that satisfies the verification-class
 * conditions (a deliverable final candidate, NOT a fault class signal, and
 * the long-turn threshold met) triggers verification:
 *
 *  1. agent_end #1 → verifyRequired=true (force-long-turn) →
 *     doVerificationCheck → judge FAIL
 *  2. verification_result {passed:false} → followUp queued →
 *     the LLM repairs and streams out a result bubble
 *  3. agent_end #2 (same turn, long-turn accumulator still met) →
 *     verifyRequired=true AGAIN → a second verification cycle runs
 *     (and a third, ...) — unbounded by any verification-specific budget or
 *     the maxResumes gate.
 *
 * The loop ends ONLY on: PASS → replay delivery, a genuine fault-class stop
 * (which hands control back to the recovery lanes, where maxResumes still
 * applies), the user stopping the turn, or the chain guardrails
 * (time/iteration caps) firing as the global fail-safe.
 */

const COMPLETE_ANSWER = { hasVisibleText: true, aborted: false };

describe('DefenseEvaluator — verification fires on every qualifying stop', () => {
  it('long turn triggers verification on the first stop', () => {
    const e = new DefenseEvaluator({ enabled: true, verifyMinSteps: 1 });
    e.recordToolCall({ type: 'read', output: 'ok' });
    const first = e.evaluate(COMPLETE_ANSWER);
    expect(first.verifyRequired).toBe(true);
    expect(first.verifyReason).toBe('force-long-turn');
  });

  it('RE-verifies after a failed verification follow-up (no per-turn budget)', () => {
    // Long-turn signal: verifyMinSteps=1 → longTurn met from the first stop
    // and stays met for the whole turn (iterations only grow).
    const e = new DefenseEvaluator({ enabled: true, verifyMinSteps: 1 });
    e.recordToolCall({ type: 'read', output: 'ok' });

    // agent_end #1: verification-class turn → verification runs.
    const first = e.evaluate(COMPLETE_ANSWER);
    expect(first.verifyRequired).toBe(true);

    // Judge FAIL → followUp. The repair round performs MORE tool calls and
    // finishes with a complete reply on the SAME turn.
    e.recordToolCall({ type: 'bash', command: 'npm run build' });

    // agent_end #2 on the SAME turn still qualifies → verification runs AGAIN
    // (the repaired reply is checked, not blindly delivered).
    const second = e.evaluate(COMPLETE_ANSWER);
    expect(second.verifyRequired).toBe(true);
    expect(second.verifyReason).toBe('force-long-turn');
    expect(second.shouldResume).toBe(false);
    expect(second.state).toBe('resuming');
  });

  it('verification cycles are NOT bounded by maxResumes (verification lane is budget-free)', () => {
    // maxResumes=1 would FAIL any fault-lane recovery after one slot — the
    // verification lane must keep re-verifying every qualifying stop
    // regardless, until pass/chain-cap/user-stop.
    const e = new DefenseEvaluator({ enabled: true, verifyMinSteps: 1, maxResumes: 1 });
    e.recordToolCall({ type: 'read', output: 'ok' });

    expect(e.evaluate(COMPLETE_ANSWER).verifyRequired).toBe(true); // verify #1
    e.recordToolCall({ type: 'bash', command: 'repair 1' });
    expect(e.evaluate(COMPLETE_ANSWER).verifyRequired).toBe(true); // verify #2 (slot budget long exhausted)
    e.recordToolCall({ type: 'bash', command: 'repair 2' });
    expect(e.evaluate(COMPLETE_ANSWER).verifyRequired).toBe(true); // verify #3
    e.recordToolCall({ type: 'bash', command: 'repair 3' });
    const round4 = e.evaluate(COMPLETE_ANSWER);
    expect(round4.verifyRequired).toBe(true); // verify #4 — still verifying, never FAILED
    expect(round4.state).toBe('resuming');
  });

  it('fault-lane recovery still respects maxResumes (only the verification lane is unbounded)', () => {
    const e = new DefenseEvaluator({ enabled: true, verifyMinSteps: 1, maxResumes: 1 });
    e.recordToolCall({ type: 'read', output: 'ok' });

    // Verification lane: no slot consumed.
    expect(e.evaluate(COMPLETE_ANSWER).verifyRequired).toBe(true);

    // Fault-lane (empty final) consumes the single recovery slot…
    const resume = e.evaluate({ hasVisibleText: false, aborted: false });
    expect(resume.shouldResume).toBe(true);
    expect(resume.verifyRequired).not.toBe(true);

    // …and the next fault-lane stop hits the cap → FAILED.
    const failed = e.evaluate({ hasVisibleText: false, aborted: false });
    expect(failed.state).toBe(State.FAILED);
    expect(failed.failureReason).toContain('Resume cap reached');
  });

  it('unbounded verification keeps a chain-cap fail-safe (iteration guardrail)', () => {
    // Chain caps are the global time/iteration fail-safe that still bounds
    // an endless re-verify loop (user-approved fail-safe design).
    const e = new DefenseEvaluator({ enabled: true, verifyMinSteps: 1, maxIterations: 1 });
    e.recordToolCall({ type: 'read', output: 'ok' });

    // Verify #1 anchors the chain budget.
    expect(e.evaluate(COMPLETE_ANSWER).verifyRequired).toBe(true);
    // One repair round stays within the chain budget → still verifying.
    e.recordToolCall({ type: 'bash', command: 'repair 1' });
    expect(e.evaluate(COMPLETE_ANSWER).verifyRequired).toBe(true);
    // Second repair round exceeds the chain cap (2 > 1) → the chain
    // guardrail aborts the turn: evaluation short-circuits, no verification.
    e.recordToolCall({ type: 'bash', command: 'repair 2' });
    const r = e.evaluate(COMPLETE_ANSWER);
    expect(r.evaluated).toBe(false);
    expect(r.state).toBe(State.ABORTED);
  });

  it('a genuine fault (empty final) resumes instead of verifying, at any point', () => {
    const e = new DefenseEvaluator({ enabled: true, verifyMinSteps: 1 });
    e.recordToolCall({ type: 'read', output: 'ok' });

    const first = e.evaluate(COMPLETE_ANSWER);
    expect(first.verifyRequired).toBe(true);

    // A repair round that ends EMPTY is a fault-class stop at any point of
    // the turn — it resumes (not verifies), exactly like before.
    const second = e.evaluate({ hasVisibleText: false, aborted: false });
    expect(second.verifyRequired).not.toBe(true);
    expect(second.shouldResume).toBe(true);
  });

  it('a fresh turn resets the recovery state and long turns verify again', () => {
    const e = new DefenseEvaluator({ enabled: true, verifyMinSteps: 1 });
    e.recordToolCall({ type: 'read', output: 'ok' });

    const first = e.evaluate(COMPLETE_ANSWER);
    expect(first.verifyRequired).toBe(true);

    e.resetTurn();
    e.recordToolCall({ type: 'read', output: 'ok' });
    const next = e.evaluate(COMPLETE_ANSWER);
    expect(next.verifyRequired).toBe(true);
  });
});