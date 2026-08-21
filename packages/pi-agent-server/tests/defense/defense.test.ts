import { describe, expect, it } from 'bun:test';
import {
  complexityScore,
  classify,
  WEIGHTS,
} from '../../src/defense/complexity-score.ts';
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

describe('complexity-score', () => {
  it('read-only short tasks score low and never resume', () => {
    const r = complexityScore([
      { type: 'read' },
      { type: 'read' },
    ]);
    expect(r.hasWrite).toBe(false);
    expect(r.needsEvaluation).toBe(false);
    expect(r.shouldResume).toBe(false);
    expect(r.weighted).toBe(1.0);
  });

  it('write without read-back is the strongest early-stop signal', () => {
    const r = complexityScore([
      { type: 'write' },
    ]);
    expect(r.hasWrite).toBe(true);
    expect(r.hasVerify).toBe(false);
    expect(r.shouldResume).toBe(true);
    expect(r.needsEvaluation).toBe(true);
  });

  it('edit without read-back also triggers resume', () => {
    const r = complexityScore([{ type: 'edit' }]);
    expect(r.shouldResume).toBe(true);
  });

  it('write followed by a read-back with output is verified', () => {
    const r = complexityScore([
      { type: 'write' },
      { type: 'read', output: 'file content...' },
    ]);
    expect(r.hasWrite).toBe(true);
    expect(r.hasVerify).toBe(true);
    expect(r.shouldResume).toBe(false);
    expect(r.needsEvaluation).toBe(true); // still evaluated due to weight
  });

  it('classifies bash write commands', () => {
    expect(classify({ type: 'bash', command: 'rm -rf build' })).toBe('bash:write');
    expect(classify({ type: 'bash', command: 'git push origin main' })).toBe('bash:write');
    expect(classify({ type: 'bash', command: 'npm install' })).toBe('bash:write');
    expect(classify({ type: 'bash', command: 'ls -la' })).toBe('bash:read');
    expect(classify({ type: 'bash', command: 'grep foo bar.txt' })).toBe('bash:read');
  });

  it('bash write triggers resume when no read-back follows', () => {
    const r = complexityScore([
      { type: 'bash', command: 'npm install' },
    ]);
    expect(r.shouldResume).toBe(true);
  });
});

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

  it('iteration cap → aborted', () => {
    const fsm = new SessionLifecycle({ maxIterations: 3 });
    // First call transitions IDLE -> RUNNING, then increments.
    fsm.onStop(false);
    expect(fsm.recordIteration()).toBe(State.RUNNING);
    expect(fsm.recordIteration()).toBe(State.RUNNING);
    expect(fsm.recordIteration()).toBe(State.RUNNING);
    // 4th iteration exceeds maxIterations (3) → aborted.
    expect(fsm.recordIteration()).toBe(State.ABORTED);
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
});

describe('DefenseEvaluator', () => {
  it('is a no-op when disabled', () => {
    const evalr = new DefenseEvaluator({ enabled: false });
    evalr.recordToolCall({ type: 'write' });
    const result = evalr.evaluate();
    expect(result.evaluated).toBe(false);
    expect(result.shouldResume).toBe(false);
  });

  it('resumes when write without read-back detected', () => {
    const evalr = new DefenseEvaluator();
    evalr.recordToolCall({ type: 'write' });
    const result = evalr.evaluate();
    expect(result.evaluated).toBe(true);
    expect(result.shouldResume).toBe(true);
    expect(result.resumeMessage).toContain('Do NOT repeat');
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

  it('fails after resume cap', () => {
    const evalr = new DefenseEvaluator({ maxResumes: 1 });
    evalr.recordToolCall({ type: 'write' });
    let r = evalr.evaluate();
    expect(r.shouldResume).toBe(true);
    // Second resume attempt on the same run (no reset between) hits the cap.
    evalr.recordToolCall({ type: 'write' });
    r = evalr.evaluate();
    expect(r.shouldResume).toBe(false);
    expect(r.state).toBe(State.FAILED);
  });

  it('resetTurn clears the lifecycle for a fresh prompt turn', () => {
    const evalr = new DefenseEvaluator({ maxResumes: 1 });
    evalr.recordToolCall({ type: 'write' });
    expect(evalr.evaluate().shouldResume).toBe(true);
    evalr.resetTurn();
    evalr.recordToolCall({ type: 'write' });
    // Fresh turn → can resume again (cap was reset).
    expect(evalr.evaluate().shouldResume).toBe(true);
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
