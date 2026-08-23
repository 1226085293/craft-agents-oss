import { afterAll, describe, expect, it } from 'bun:test';
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
import { FsWatch } from '../../src/defense/fs-watch.ts';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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


describe('fs-watch (filesystem-fact write detection)', () => {
  const tdir = mkdtempSync(join(tmpdir(), 'fs-watch-test-'));

  it('detects files written after turn-start marker', async () => {
    const fw = new FsWatch();
    fw.markTurnStart();
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(tdir, 'a.txt'), 'x');
    const ev = fw.detectWrites(tdir)!;
    expect(ev.modifiedFiles).toContain('a.txt');
    expect(ev.truncated).toBe(false);
  });

  it('ignores skipped dirs like node_modules', async () => {
    const fw = new FsWatch();
    fw.markTurnStart();
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(tdir, 'node_modules-x'), 'x'); // plain file fine
    const ev = fw.detectWrites(tdir)!;
    expect(ev.modifiedFiles.length).toBeGreaterThan(0);
  });

  it('ignores framework top-level dirs (sessions/, data/, .pi-sessions/) but watches deeper same-name dirs', async () => {
    const fw = new FsWatch();
    fw.markTurnStart();
    await new Promise((r) => setTimeout(r, 20));
    mkdirSync(join(tdir, 'sessions'), { recursive: true });
    writeFileSync(join(tdir, 'sessions', 'session.jsonl'), 'noise');
    writeFileSync(join(tdir, 'deep-sessions'), 'x'); // plain file fine
    const ev = fw.detectWrites(tdir)!;
    expect(ev.modifiedFiles.some((f) => f.startsWith('sessions/'))).toBe(false);
  });

  it('ignores framework noise files like events.jsonl at top level', async () => {
    const fw = new FsWatch();
    fw.markTurnStart();
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(tdir, 'events.jsonl'), '{"tick":1}');
    writeFileSync(join(tdir, 'user-file.txt'), 'mine');
    const ev = fw.detectWrites(tdir)!;
    expect(ev.modifiedFiles).not.toContain('events.jsonl');
    expect(ev.modifiedFiles).toContain('user-file.txt');
  });

  it('returns null without a turn-start anchor', () => {
    const fw = new FsWatch();
    expect(fw.detectWrites(tdir)).toBeNull();
  });

  it('catches regex-blind writes (python3 heredoc) via fs evidence', async () => {
    const evaluator = new DefenseEvaluator({ enabled: true, cwd: tdir });
    evaluator.resetTurn();
    await new Promise((r) => setTimeout(r, 20));
    // python3 heredoc — WRITE_CMDS regex classifies this as bash:read
    evaluator.recordToolCall({
      type: 'bash',
      command: "python3 << EOF\nopen('" + join(tdir, 'new.py') + "','w').write('x')\nEOF",
    });
    writeFileSync(join(tdir, 'new.py'), 'data');
    const r = evaluator.evaluate({ hasVisibleText: false, aborted: false });
    expect(r.shouldResume).toBe(true);
    expect(r.resumeMessage).toContain('new.py');
  });

  it('resumes on silent stop even with no writes', () => {
    const evaluator = new DefenseEvaluator({ enabled: true, cwd: tdir });
    evaluator.resetTurn();
    evaluator.recordToolCall({ type: 'bash', command: 'ls /tmp' }); // read-only
    const r = evaluator.evaluate({ hasVisibleText: false, aborted: false });
    expect(r.shouldResume).toBe(true);
    expect(r.resumeMessage).toContain('WITHOUT any visible reply');
  });

  it('does not resume on user abort', () => {
    const evaluator = new DefenseEvaluator({ enabled: true, cwd: tdir });
    evaluator.resetTurn();
    const r = evaluator.evaluate({ hasVisibleText: false, aborted: true });
    expect(r.shouldResume).toBe(false);
  });

  // P0 (2026-08-22): a user abort is an explicit stop. Every resume signal
  // must yield to it — write-without-readback, empty terminal response, and
  // silent stop alike. Before the short-circuit, aborted + write-no-verify
  // returned shouldResume=true and the interrupted task was revived.
  it('P0: abort short-circuits write-without-readback resume', () => {
    const evaluator = new DefenseEvaluator({ enabled: true, cwd: tdir });
    evaluator.resetTurn();
    evaluator.recordToolCall({ type: 'bash', command: 'rm /tmp/f.txt' }); // bash:write
    const r = evaluator.evaluate({ hasVisibleText: true, aborted: true });
    expect(r.shouldResume).toBe(false);
    expect(r.state).toBe('aborted');
  });

  it('P0: abort short-circuits empty-terminal-response resume', () => {
    const evaluator = new DefenseEvaluator({ enabled: true, cwd: tdir });
    evaluator.resetTurn();
    evaluator.recordToolCall({ type: 'bash', command: 'rm /tmp/f.txt' });
    const r = evaluator.evaluate({ hasVisibleText: false, aborted: true, endsWithEmptyResponse: true });
    expect(r.shouldResume).toBe(false);
    expect(r.state).toBe('aborted');
  });

  it('P0: abort marks the lifecycle terminal (no re-evaluation later in the turn)', () => {
    const evaluator = new DefenseEvaluator({ enabled: true, cwd: tdir });
    evaluator.resetTurn();
    evaluator.recordToolCall({ type: 'bash', command: 'rm /tmp/f.txt' });
    evaluator.evaluate({ hasVisibleText: true, aborted: true });
    expect(evaluator.canEvaluate()).toBe(false);
  });

  it('normal completion (write + read-back + text) does not resume', async () => {
    const evaluator = new DefenseEvaluator({ enabled: true, cwd: tdir });
    evaluator.resetTurn();
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(tdir, 'w.txt'), 'w');
    evaluator.recordToolCall({ type: 'bash', command: 'cp x y' });
    evaluator.recordReadOutput('file content here');
    const r = evaluator.evaluate({ hasVisibleText: true, aborted: false });
    expect(r.shouldResume).toBe(false);
  });

  afterAll(() => {
    rmSync(tdir, { recursive: true, force: true });
  });
});
