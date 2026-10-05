import { describe, expect, it } from 'bun:test';
import { complexityScore, VERIFY_OUTPUT_CMDS } from './complexity-score.ts';
import { DefenseEvaluator } from './evaluator.ts';

/**
 * Regression contract for the 2026-09-07 incident.
 *
 * A turn committed + pushed a git change, then verified exclusively through
 * bash (`git show --stat`, `git ls-remote`) and gave the user a complete
 * final answer. The defense evaluator still forced a second reply because
 * hasVerify only counted the explicit `read` tool — bash verification
 * output was discarded, so the turn looked like "wrote but never read
 * back".
 *
 * Contract: verification-grade bash output counts as read-back evidence.
 * A turn whose final answer answers the user's request must not be resumed
 * just because its verification happened in bash.
 */

const COMPLETE_ANSWER = { hasVisibleText: true, aborted: false };

describe('VERIFY_OUTPUT_CMDS', () => {
  it('matches git verification commands', () => {
    expect(VERIFY_OUTPUT_CMDS.test('git push origin main 2>&1 | tail -5')).toBe(true);
    expect(VERIFY_OUTPUT_CMDS.test('git show --stat --oneline a64e1a29')).toBe(true);
    expect(VERIFY_OUTPUT_CMDS.test('git ls-remote origin refs/heads/main')).toBe(true);
    expect(VERIFY_OUTPUT_CMDS.test('git status -sb | head -2')).toBe(true);
  });

  it('matches test/build runners', () => {
    expect(VERIFY_OUTPUT_CMDS.test('bun test src/defense/')).toBe(true);
    expect(VERIFY_OUTPUT_CMDS.test('bun run typecheck')).toBe(true);
    expect(VERIFY_OUTPUT_CMDS.test('npm run build')).toBe(true);
  });

  it('does not match blind mutating commands', () => {
    expect(VERIFY_OUTPUT_CMDS.test('rm -rf build/')).toBe(false);
    expect(VERIFY_OUTPUT_CMDS.test('cp a b')).toBe(false);
  });
});

describe('complexityScore — bash verification counts as read-back', () => {
  it('git push verified via git show + git ls-remote → no resume (2026-09-07 incident)', () => {
    const result = complexityScore([
      { type: 'bash', command: 'git add -A && git commit -m "fix"' }, // write-class
      { type: 'bash', command: 'git push origin main', output: 'main -> main' }, // write-class + verify
      { type: 'bash', command: 'git show --stat a64e1a29', output: '10 files changed' },
      { type: 'bash', command: 'git ls-remote origin refs/heads/main', output: 'a64e1a29\trefs/heads/main' },
    ]);
    expect(result.hasWrite).toBe(true);
    expect(result.hasVerify).toBe(true);
    expect(result.shouldResume).toBe(false);
  });

  it('edit verified via bun test → no resume', () => {
    const result = complexityScore([
      { type: 'edit' },
      { type: 'bash', command: 'bun test src/foo.test.ts', output: '12 pass, 0 fail' },
    ]);
    expect(result.hasWrite).toBe(true);
    expect(result.hasVerify).toBe(true);
    expect(result.shouldResume).toBe(false);
  });

  it('write followed by git status with output → no resume', () => {
    const result = complexityScore([
      { type: 'write' },
      { type: 'bash', command: 'git status --short', output: ' M file.ts' },
    ]);
    expect(result.hasVerify).toBe(true);
    expect(result.shouldResume).toBe(false);
  });

  it('write with NO verification at all → still resumes (behavior preserved)', () => {
    const result = complexityScore([
      { type: 'write' },
      { type: 'bash', command: 'echo done' }, // not verification-grade
    ]);
    expect(result.hasVerify).toBe(false);
    expect(result.shouldResume).toBe(true);
  });

  it('verify-grade bash command WITHOUT output still does not count', () => {
    const result = complexityScore([
      { type: 'write' },
      { type: 'bash', command: 'git status --short' }, // output lost/null
    ]);
    expect(result.hasVerify).toBe(false);
    expect(result.shouldResume).toBe(true);
  });

  it('a lone write on a short turn no longer routes to verification (S1 removed)', () => {
    const e = new DefenseEvaluator({ enabled: true });
    e.recordToolCall({ type: 'write' });
    e.recordToolCall({ type: 'bash', command: 'git status --short' });
    const result = e.evaluate(COMPLETE_ANSWER);
    // The write-without-readback signal is gone: a short turn that only wrote
    // is NOT verification-class — a clean final answer is delivered as-is.
    expect(result.shouldResume).toBe(false);
    expect(result.verifyRequired).not.toBe(true);
    expect(result.state).toBe('done');
  });
});

describe('DefenseEvaluator end-to-end — write class no longer forces verification (S1 removed)', () => {
  it('commit+push on a short turn with a final answer → no resume, no verification', () => {
    const e = new DefenseEvaluator({ enabled: true });
    e.recordToolCall({ type: 'edit' });
    e.recordToolCall({ type: 'bash', command: 'git commit -m "fix: something"' });
    e.recordToolCall({ type: 'bash', command: 'git push origin main', output: 'main -> main' });
    const result = e.evaluate(COMPLETE_ANSWER);
    expect(result.shouldResume).toBe(false);
    expect(result.verifyRequired).not.toBe(true);
    expect(result.state).toBe('done');
  });
});
