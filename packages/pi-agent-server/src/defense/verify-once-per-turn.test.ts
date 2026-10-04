import { describe, expect, it } from 'bun:test';
import { DefenseEvaluator } from './evaluator.ts';

/**
 * Regression contract for the 2026-10-05 report: "会话出现结果气泡后
 * 貌似还会出现验证失败的错误" (a result bubble appears, then a second
 * Verifying/Verification-failed cycle shows up after it).
 *
 * Root cause: the `longTurn` verification signal is a TURN-LEVEL
 * accumulator — once iterations/elapsed cross the threshold it stays true
 * for the rest of the turn. Flow that reproduces the report:
 *
 *   1. agent_end #1 → verifyRequired=true (force-long-turn) →
 *      doVerificationCheck → judge FAIL
 *   2. verification_result {passed:false} → followUp queued →
 *      the LLM repairs and streams out a result bubble
 *   3. agent_end #2 (same turn) → evaluateDefensePostStop runs AGAIN.
 *      The repair round added tool calls → longTurn is STILL true →
 *      verifyRequired=true AGAIN → the event adapter demotes the fresh
 *      result bubble + "Verifying final reply…" + a second cycle →
 *      another "Verification failed — continuing" error after the bubble
 *      (the user's report), repeated until maxResumes is exhausted.
 *
 * Contract: ONE verification attempt per turn. A turn whose verification
 * FAILED and was followed up by the LLM must deliver the repaired reply as
 * the final bubble — the next agent_end must NOT re-verify it. (A genuine
 * fault-class signal — empty final, truncation — still resumes as before.)
 */

const COMPLETE_ANSWER = { hasVisibleText: true, aborted: false };

describe('DefenseEvaluator — one verification attempt per turn', () => {
  it('long turn triggers verification on the first stop', () => {
    const e = new DefenseEvaluator({ enabled: true, verifyMinSteps: 1 });
    e.recordToolCall({ type: 'read', output: 'ok' });
    const first = e.evaluate(COMPLETE_ANSWER);
    expect(first.verifyRequired).toBe(true);
    expect(first.verifyReason).toBe('force-long-turn');
  });

  it('does NOT re-verify after a failed verification follow-up (2026-10-05 report)', () => {
    // Long-turn signal: verifyMinSteps=1 → longTurn met from the first stop
    // and stays met for the whole turn (iterations only grow).
    const e = new DefenseEvaluator({ enabled: true, verifyMinSteps: 1 });
    e.recordToolCall({ type: 'read', output: 'ok' });

    // agent_end #1: verification-class turn → verification runs.
    const first = e.evaluate(COMPLETE_ANSWER);
    expect(first.verifyRequired).toBe(true);
    expect(first.verifyReason).toBe('force-long-turn');

    // Judge FAIL → followUp. The repair round performs MORE tool calls and
    // finishes with a normal reply on the SAME turn.
    e.recordToolCall({ type: 'bash', command: 'npm run build' });

    // agent_end #2 on the SAME turn must NOT trigger a second verification —
    // the repaired reply is delivered as the final bubble.
    const second = e.evaluate(COMPLETE_ANSWER);
    expect(second.verifyRequired).not.toBe(true);
    expect(second.shouldResume).toBe(false);
    expect(second.state).toBe('done');
  });

  it('a genuine fault (empty final) still resumes after a used verification slot', () => {
    const e = new DefenseEvaluator({ enabled: true, verifyMinSteps: 1 });
    e.recordToolCall({ type: 'read', output: 'ok' });

    const first = e.evaluate(COMPLETE_ANSWER);
    expect(first.verifyRequired).toBe(true);

    // repair round ends with an EMPTY final → fault-class resume (not verify).
    const second = e.evaluate({ hasVisibleText: false, aborted: false });
    expect(second.verifyRequired).not.toBe(true);
    expect(second.shouldResume).toBe(true);
  });

  it('a fresh turn resets the verification-once budget', () => {
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
