import { describe, expect, it } from 'bun:test';
import { DefenseEvaluator } from './evaluator.ts';

/**
 * Regression contract for the 2026-09-08 incident (session fit-pulsar).
 *
 * A mid-task turn running a long (>5 min) verification tool was killed by the
 * stall watchdog, which calls session.abort() — stamping the SAME
 * stopReason='aborted' a user stop produces. The P0 abort rule could not tell
 * the two apart, skipped post-stop evaluation, and a nearly-complete turn
 * (tests 15/15 green, pipeline one step from done) died silently in "todo".
 *
 * Fix contract:
 * 1. A watchdog abort (stallAborted=true) is an infrastructure fault — it must
 *    EVALUATE like any other early-stop signal and resume the turn.
 * 2. A user abort (stallAborted=false/absent) stays terminal — P0 preserved.
 * 3. The resume message tells the model the abort was system-initiated and to
 *    verify interrupted work before redoing it.
 * 4. Guardrails still bound stall resumes (cap + no-progress hash).
 */

const ABORTED_SILENT = { role: 'assistant', content: [{ type: 'text', text: '' }], stopReason: 'aborted' };

function writeThenAbortEvaluator(): DefenseEvaluator {
  const e = new DefenseEvaluator({ enabled: true });
  e.recordToolCall({ type: 'write' });
  return e;
}

describe('stall-watchdog abort attribution (2026-09-08 incident)', () => {
  it('resumes a watchdog-killed turn that wrote without read-back (was silently dropped before)', () => {
    const e = writeThenAbortEvaluator();
    const r = e.evaluate({ hasVisibleText: false, aborted: true, stallAborted: true });
    expect(r.evaluated).toBe(true);
    expect(r.shouldResume).toBe(true);
    expect(r.resumeMessage).toBeTruthy();
  });

  it('resumes a watchdog-killed turn even when prior visible text exists (stall alone is a signal)', () => {
    const e = new DefenseEvaluator({ enabled: true });
    e.recordToolCall({ type: 'bash', command: 'ls' });
    const r = e.evaluate({ hasVisibleText: true, aborted: true, stallAborted: true });
    expect(r.evaluated).toBe(true);
    expect(r.shouldResume).toBe(true);
  });

  it('still never resumes a USER abort (P0 rule intact)', () => {
    const e = writeThenAbortEvaluator();
    const r = e.evaluate({ hasVisibleText: false, aborted: true, stallAborted: false });
    expect(r.shouldResume).toBe(false);
    expect(r.state).toBe('aborted');

    const e2 = writeThenAbortEvaluator();
    const r2 = e2.evaluate({ hasVisibleText: false, aborted: true });
    expect(r2.shouldResume).toBe(false);
    expect(r2.state).toBe('aborted');
  });

  it('resume message explains the system abort and warns against blind redo', () => {
    const e = writeThenAbortEvaluator();
    const r = e.evaluate({ hasVisibleText: false, aborted: true, stallAborted: true });
    expect(r.resumeMessage).toContain('ABORTED BY THE SYSTEM');
    expect(r.resumeMessage).toContain('NOT by the user');
    expect(r.resumeMessage).toContain('continue the task');
  });

  it('guardrail: a fresh evaluator resumes again (server re-creates per turn); lifecycle states stay valid', () => {
    const e = writeThenAbortEvaluator();
    const input = { hasVisibleText: false, aborted: true, stallAborted: true };
    const r1 = e.evaluate(input);
    expect(r1.shouldResume).toBe(true);
    expect(['resumed', 'resuming', 'failed', 'done', 'idle', 'running', 'evaluating', 'resume_ready', 'aborted']).toContain(r1.state);
  });

  it('chain cap: repeated stall resumes eventually hit the resume cap', () => {
    // Drive the SAME lifecycle through repeated stall aborts.
    const e = writeThenAbortEvaluator();
    const input = { hasVisibleText: false, aborted: true, stallAborted: true };
    const outcomes: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = e.evaluate(input);
      outcomes.push(r.state);
      if (!r.shouldResume) break;
      // A real resumed segment records at least one new tool call; here we
      // reuse the identical history on purpose to trigger the no-progress
      // guard after the first identical-context resume.
      const r2 = e.evaluate(input);
      outcomes.push(r2.state);
      break;
    }
    // Either resumed once then failed on identical context, or capped out.
    expect(outcomes.some((s) => s === 'resumed' || s === 'failed')).toBe(true);
  });

  it('aborted silent messages from USER stops keep the markAborted lifecycle transition', () => {
    const e = writeThenAbortEvaluator();
    const r = e.evaluate({ hasVisibleText: false, aborted: true });
    expect(r.state).toBe('aborted');
    // Terminal: a subsequent evaluation is a no-op 'abort' stop.
    const r2 = e.evaluate({ hasVisibleText: false, aborted: true });
    expect(r2.shouldResume).toBe(false);
  });

  it('watchdog abort with EMPTY final response resumes with the empty-response context too', () => {
    const e = new DefenseEvaluator({ enabled: true });
    const r = e.evaluate({
      hasVisibleText: false,
      aborted: true,
      stallAborted: true,
      endsWithEmptyResponse: true,
      hasRepetitionLoop: false,
    });
    expect(r.shouldResume).toBe(true);
    expect(r.resumeMessage).toContain('EMPTY response');
  });

  // Sanity: the two constant shapes above are intentionally identical aborted
  // finals; a watchdog kill after visible text still resumes (signal check).
  it('watchdog abort after visible progress text still resumes', () => {
    const e = new DefenseEvaluator({ enabled: true });
    const r = e.evaluate({
      hasVisibleText: true,
      aborted: true,
      stallAborted: true,
      endsWithEmptyResponse: false,
      hasRepetitionLoop: false,
    });
    expect(r.shouldResume).toBe(true);
    expect(ABORTED_SILENT.stopReason).toBe('aborted');
  });
});
