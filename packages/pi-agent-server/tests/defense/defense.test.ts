import { afterAll, describe, expect, it } from 'bun:test';
import {
  State,
  SessionLifecycle,
  fnv1a,
} from '../../src/defense/session-lifecycle.ts';
import {
  DefenseEvaluator,
} from '../../src/defense/evaluator.ts';
import {
  EXECUTION_DISCIPLINE,
  EXECUTION_DISCIPLINE_EN,
  DISCIPLINE_MARKER,
  withExecutionDiscipline,
  stripExecutionDiscipline,
} from '../../src/defense/system-discipline.ts';
import {
  resolveDefenseEnabled,
  DEFAULT_DEFENSE_ENABLED,
} from '../../src/defense/index.ts';
import { buildDefenseStopNotice } from '../../src/defense/evaluator.ts';

describe('session-lifecycle', () => {
  it('tracks state transitions', () => {
    const fsm = new SessionLifecycle();
    expect(fsm.getState()).toBe(State.IDLE);
    expect(fsm.onStop(false)).toBe('run');
    expect(fsm.getState()).toBe(State.RUNNING);
  });

  it('evaluate → resume → evaluate → done', () => {
    const fsm = new SessionLifecycle();
    fsm.recordIteration();
    expect(fsm.onStop(true)).toBe('evaluate');
    const decision = fsm.decideResume('ctx-1');
    expect(decision).toBe(State.RESUME_READY);
    fsm.markResumed();
    expect(fsm.getState()).toBe(State.RESUMING);
    expect(fsm.onStop(false)).toBe('run');
    fsm.markDone();
    expect(fsm.isTerminal()).toBe(true);
  });

  it('resume cap reached → failed', () => {
    const fsm = new SessionLifecycle({ maxResumes: 2 });
    fsm.recordIteration();
    fsm.onStop(true);
    expect(fsm.decideResume('ctx-1')).toBe(State.RESUME_READY);
    fsm.markResumed();
    fsm.onStop(true);
    expect(fsm.decideResume('ctx-2')).toBe(State.RESUME_READY);
    fsm.markResumed();
    fsm.onStop(true);
    expect(fsm.decideResume('ctx-3')).toBe(State.FAILED);
  });

  it('same resume context twice → failed (no progress)', () => {
    const fsm = new SessionLifecycle();
    fsm.recordIteration();
    fsm.onStop(true);
    expect(fsm.decideResume('same-ctx')).toBe(State.RESUME_READY);
    fsm.markResumed();
    fsm.onStop(true);
    expect(fsm.decideResume('same-ctx')).toBe(State.FAILED);
  });

  it('iteration cap only bounds resume chains (first turn unbounded)', () => {
    const fsm = new SessionLifecycle({ maxIterations: 3 });
    // First turn (no resume yet): caps do NOT apply — a long healthy tool
    // chain must keep full defense protection instead of going dark.
    fsm.onStop(false);
    expect(fsm.recordIteration()).toBe(State.RUNNING);
    expect(fsm.recordIteration()).toBe(State.RUNNING);
    expect(fsm.recordIteration()).toBe(State.RUNNING);
    expect(fsm.recordIteration()).toBe(State.RUNNING); // 4th > cap, still RUNNING
    // Enter a resume chain: now the budget applies.
    fsm.onStop(true);
    fsm.decideResume('ctx-1');
    fsm.markResumed();
    // Iterations keep counting across the resume; exceeding the cap aborts.
    fsm.recordIteration();
    fsm.recordIteration();
    fsm.recordIteration();
    expect(fsm.recordIteration()).toBe(State.ABORTED);
  });

  it('duration cap bounds the resume CHAIN, not the whole turn (long first segment is safe)', async () => {
    const fsm = new SessionLifecycle({ maxDurationMs: 100 });
    // Long healthy first segment: run well past the 100 ms cap BEFORE any
    // resume. The chain budget must NOT start at turn start — a long research
    // turn (browser tools etc.) must not eat into the resume allowance.
    fsm.recordIteration();
    await new Promise((r) => setTimeout(r, 150));
    expect(fsm.onStop(true)).toBe('evaluate');
    expect(fsm.decideResume('ctx-1')).toBe(State.RESUME_READY);
    fsm.markResumed();
    // Resumed segment finishes promptly (well under the chain cap).
    expect(fsm.onStop(false)).toBe('run');
    fsm.markDone();
    expect(fsm.isTerminal()).toBe(true);
  });

  it('duration cap still aborts a genuinely stuck resume chain', async () => {
    const fsm = new SessionLifecycle({ maxDurationMs: 100 });
    fsm.recordIteration();
    fsm.onStop(true);
    fsm.decideResume('ctx-1');
    fsm.markResumed();
    // The resumed segment stalls past the chain budget (counted from the
    // FIRST resume — the second agent_end must abort).
    await new Promise((r) => setTimeout(r, 150));
    expect(fsm.onStop(true)).toBe('abort');
    expect(fsm.getState()).toBe(State.ABORTED);
  });

  it('fnv1a produces stable deterministic hashes', () => {
    expect(fnv1a('abc')).toBe(fnv1a('abc'));
    expect(fnv1a('abc')).not.toBe(fnv1a('abd'));
  });

  it('illegal transition throws', () => {
    const fsm = new SessionLifecycle();
    // IDLE -> DONE is not a legal transition.
    expect(() => fsm.markDone()).toThrow(/Illegal state transition/);
  });

  it('ladder handoff is idempotent on repeat entry (2026-10-16 261016-soft-channel)', () => {
    // A turn can route through the ladder lane MORE THAN ONCE — every empty
    // terminal response re-enters the handoff. The second call found the FSM
    // already parked at RESUME_READY and threw
    // `Illegal state transition: resume_ready -> resume_ready`, which the
    // caller swallowed — the main process never got the error event that arms
    // the retry ladder, so retries stalled on "重试 1 次后恢复".
    const fsm = new SessionLifecycle();
    expect(fsm.markLadderHandoff()).toBe(State.RESUME_READY);
    // Repeat entry must be a no-op, NOT a throw.
    expect(() => fsm.markLadderHandoff()).not.toThrow();
    expect(fsm.markLadderHandoff()).toBe(State.RESUME_READY);
    expect(fsm.getState()).toBe(State.RESUME_READY);
  });

  it('ladder handoff re-entry still reaches RESUME_READY from RESUMING', () => {
    // The in-between step of a ladder cycle: the ladder's re-issue runs the
    // model step and the FSM moves RESUMING → EVALUATING → RESUME_READY on
    // the next empty response. This must not throw either.
    const fsm = new SessionLifecycle();
    fsm.markLadderHandoff();
    fsm.markResumed();
    expect(fsm.getState()).toBe(State.RESUMING);
    expect(fsm.markLadderHandoff()).toBe(State.RESUME_READY);
  });

  it('ladder re-issue advances RESUME_READY -> RESUMING (2026-10-18 261017-copper-copper)', () => {
    // The main-process retry ladder owns the continuation after a handoff and
    // never calls markResumed(). Without this step the retried run's post-stop
    // evaluation crashed with `resume_ready -> resume_ready`, and the crash was
    // routed into the retry ladder — which can never re-run an already-
    // delivered reply, so the turn hung until the user stopped it.
    const fsm = new SessionLifecycle();
    fsm.markLadderHandoff();
    expect(fsm.markLadderResumed()).toBe(true);
    expect(fsm.getState()).toBe(State.RESUMING);
    // The retried run ends with a real reply on a long turn -> verification.
    expect(fsm.onStop(true)).toBe('evaluate');
    expect(fsm.decideResume('verify', { verificationLane: true })).toBe(State.RESUME_READY);
    fsm.markResumed();
    expect(fsm.getState()).toBe(State.RESUMING);
  });

  it('markLadderResumed is a no-op outside the ladder lane', () => {
    const fsm = new SessionLifecycle();
    fsm.recordIteration(); // RUNNING — a plain stream-error retry path
    expect(fsm.markLadderResumed()).toBe(false);
    expect(fsm.getState()).toBe(State.RUNNING);
    // Terminal states are never revived.
    fsm.markFailed();
    expect(fsm.markLadderResumed()).toBe(false);
    expect(fsm.getState()).toBe(State.FAILED);
  });

  it('decideResume tolerates a parked RESUME_READY (defensive guard)', () => {
    // Even if a caller reaches the decision path from the parked handoff state
    // (no markLadderResumed), the FSM must not throw: an internal invariant
    // violation must never derail an already-delivered turn into the ladder.
    const fsm = new SessionLifecycle();
    fsm.markLadderHandoff();
    expect(() => fsm.decideResume('verify', { verificationLane: true })).not.toThrow();
    expect(fsm.getState()).toBe(State.RESUME_READY);
    // A cap-driven FAILED from the parked state is legal too (was
    // `resume_ready -> failed` before the normalization).
    const capped = new SessionLifecycle({ maxResumes: 0 });
    capped.markLadderHandoff();
    expect(() => capped.decideResume('fault')).not.toThrow();
    expect(capped.getState()).toBe(State.FAILED);
  });

  it('ladder handoff is a no-op once the FSM is terminal', () => {
    const fsm = new SessionLifecycle();
    fsm.markLadderHandoff();
    fsm.markResumed();
    fsm.markFailed();
    expect(fsm.isTerminal()).toBe(true);
    expect(() => fsm.markLadderHandoff()).not.toThrow();
    expect(fsm.getState()).toBe(State.FAILED);
  });
});

describe('DefenseEvaluator', () => {
  it('is a no-op when disabled', () => {
    const evalr = new DefenseEvaluator({ enabled: false });
    evalr.recordToolCall({ type: 'write' });
    const result = evalr.evaluate();
    expect(result.evaluated).toBe(false);
    expect(result.shouldResume).toBe(false);
  });

  it('triggers verification (verifyRequired) on a forced long turn (S1 removed, 2026-10-05)', () => {
    const evalr = new DefenseEvaluator({ verifyMinSteps: 1 });
    evalr.recordToolCall({ type: 'read', output: 'ok' });
    const result = evalr.evaluate({ hasVisibleText: true, hasFinalText: true, aborted: false });
    // Long-turn is the only verification-class trigger now (write-without-
    // read-back was removed): the program checks the captured final reply
    // with an LLM first, and only reverts to a follow-up (resume) on FAIL.
    expect(result.evaluated).toBe(true);
    expect(result.shouldResume).toBe(false);
    expect(result.verifyRequired).toBe(true);
    expect(result.verifyReason).toBe('force-long-turn');
    expect(result.resumeMessage).toBeDefined();
  });

  it('resume message orders a direct delivery, not a delivery self-judgment (2026-10-13 rewrite)', () => {
    const evalr = new DefenseEvaluator({ verifyMinSteps: 1 });
    evalr.recordToolCall({ type: 'read', output: 'ok' });
    const result = evalr.evaluate();
    const msg = result.resumeMessage!;
    // The FIRST instruction is the delivery act itself…
    expect(msg).toContain('Verification delivery');
    expect(msg).toContain('Write the COMPLETE final reply');
    // …and an already-correct draft is re-delivered verbatim (one effective
    // reply, no second different answer).
    expect(msg).toContain('verbatim');
    expect(msg).toContain('do NOT re-run the task');
    // Two prohibitions learned from 261013-mild-stream: no meta-narration
    // about the delivery, no re-running investigation done earlier this turn.
    expect(msg).toContain('Do NOT write narration about the delivery process');
    expect(msg).toContain('do NOT run them');
    // A corrected version must be delivered in full — never a patch/diff.
    expect(msg).toContain('never a patch');
  });

  it('does not resume on clean completion', () => {
    const evalr = new DefenseEvaluator();
    evalr.recordToolCall({ type: 'read' });
    const result = evalr.evaluate();
    expect(result.evaluated).toBe(true);
    expect(result.shouldResume).toBe(false);
  });

  it('does not resume on high complexity without write (informational only)', () => {
    const evalr = new DefenseEvaluator();
    // 5 read-only-ish calls with high combined weight but no write
    for (let i = 0; i < 8; i++) evalr.recordToolCall({ type: 'read' });
    const result = evalr.evaluate();
    expect(result.evaluated).toBe(true);
    expect(result.shouldResume).toBe(false);
  });

  it('fails after the resume cap (fault-class resumes consume the budget)', () => {
    // Verification is now once-per-turn (latched), so it does NOT loop against
    // the cap. Fault-class resumes (an empty final) still do — each one burns
    // a resume slot until the cap (or a no-progress hash) ends the turn.
    const evalr = new DefenseEvaluator({ maxResumes: 1 });
    const emptyFinal = { hasVisibleText: false, hasFinalText: false, aborted: false, endsWithEmptyResponse: true };
    let r = evalr.evaluate(emptyFinal);
    expect(r.shouldResume).toBe(true);
    // Second identical resume hits the cap → terminal FAILED.
    r = evalr.evaluate(emptyFinal);
    expect(r.shouldResume).toBe(false);
    expect(r.state).toBe(State.FAILED);
  });

  it('ladder handoff + long-turn verification does not throw (2026-10-18 261017-copper-copper)', () => {
    const evalr = new DefenseEvaluator({ verifyMinSteps: 1, ladderOwnsEmptyResponse: true });
    evalr.recordToolCall({ type: 'read', output: 'ok' });
    // 1) Empty terminal response → handoff parks the FSM at RESUME_READY.
    const first = evalr.evaluate({
      hasVisibleText: false,
      hasFinalText: false,
      aborted: false,
      endsWithEmptyResponse: true,
    });
    expect(first.emptyResponseOwned).toBe(true);
    expect(first.state).toBe(State.RESUME_READY);
    // 2) The main-process ladder re-issues the model step.
    expect(evalr.markLadderResumed()).toBe(true);
    // 3) The retried run delivers a real reply on a long turn → verification
    //    (this exact sequence used to throw resume_ready -> resume_ready).
    const second = evalr.evaluate({ hasVisibleText: true, hasFinalText: true, aborted: false });
    expect(second.evaluated).toBe(true);
    expect(second.verifyRequired).toBe(true);
    expect(second.state).toBe(State.RESUMING);
  });

  it('resetTurn clears the lifecycle for a fresh prompt turn', () => {
    const evalr = new DefenseEvaluator({ maxResumes: 1, verifyMinSteps: 1 });
    evalr.recordToolCall({ type: 'read', output: 'ok' });
    expect(evalr.evaluate({ hasVisibleText: true, hasFinalText: true, aborted: false }).verifyRequired).toBe(true);
    evalr.resetTurn();
    evalr.recordToolCall({ type: 'read', output: 'ok' });
    // Fresh turn → recovery state resets; a qualifying long turn verifies again.
    expect(evalr.evaluate({ hasVisibleText: true, hasFinalText: true, aborted: false }).verifyRequired).toBe(true);
  });
});

describe('system-discipline', () => {
  it('appends discipline block to prompt', () => {
    const prompt = withExecutionDiscipline('base prompt');
    expect(prompt).toContain(DISCIPLINE_MARKER);
    expect(prompt).toContain('goal checklist');
  });

  it('is idempotent', () => {
    const once = withExecutionDiscipline('p');
    const twice = withExecutionDiscipline(once);
    expect(twice).toBe(once);
  });

  it('can strip the block', () => {
    const prompt = withExecutionDiscipline('base');
    const stripped = stripExecutionDiscipline(prompt);
    expect(stripped).not.toContain(DISCIPLINE_MARKER);
    expect(stripped).toBe('base');
  });

  it('contains both language variants', () => {
    expect(EXECUTION_DISCIPLINE).toContain('执行纪律');
    expect(EXECUTION_DISCIPLINE_EN).toContain('EXECUTION DISCIPLINE');
  });
});

describe('defense switch', () => {
  it('defaults to enabled', () => {
    expect(DEFAULT_DEFENSE_ENABLED).toBe(true);
    expect(resolveDefenseEnabled(undefined)).toBe(true);
    expect(resolveDefenseEnabled(true)).toBe(true);
    expect(resolveDefenseEnabled(false)).toBe(false);
  });
});


describe('DSML-leak final reply (2026-10-04 incident; fault-class detection removed 2026-10-06)', () => {
  it('a leak-marker final reply no longer forces fault-class resume', () => {
    // The leakedToolCall fault-class signal was removed: the session
    // auto-continues on the next user message, so the post-stop kill +
    // terminal card was redundant. A turn with visible final text now
    // follows the ordinary path (no resume, no verification).
    const evaluator = new DefenseEvaluator();
    evaluator.recordToolCall({ type: 'read' });
    const r = evaluator.evaluate({
      hasVisibleText: true,
      hasFinalText: true,
      aborted: false,
    });
    expect(r.shouldResume).toBe(false);
    expect(r.verifyRequired).toBeUndefined();
  });
});

describe('defense stop notice (2026-10-04 polished-canyon silent stop)', () => {
  it('builds a generic notice for a failed evaluation', () => {
    const n = buildDefenseStopNotice({
      state: 'failed' as never,
      shouldResume: false,
      reason: 'repetitionLoop',
    });
    expect(n).not.toBeNull();
    expect(n!.reason).toBe('repetitionLoop');
    expect(n!.message).toContain('recovery attempts');
    expect(n!.message).toContain('send a message to continue');
  });

  it('falls back to defense_failed when no reason is recorded', () => {
    const n = buildDefenseStopNotice({ state: 'failed' as never, shouldResume: false });
    expect(n!.reason).toBe('defense_failed');
  });

  it('returns null for recoverable or non-terminal results', () => {
    expect(buildDefenseStopNotice({ state: 'resuming' as never, shouldResume: true })).toBeNull();
    expect(buildDefenseStopNotice({ state: 'failed' as never, shouldResume: false, verifyRequired: true })).toBeNull();
  });
});
