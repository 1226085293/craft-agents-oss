import { describe, expect, it } from 'bun:test';
import {
  ToolLoopDetector,
  digestResult,
  fingerprintToolCall,
  isEmptyArgs,
  shouldRejectEmptyArgs,
  emptyArgsMessage,
} from './tool-loop-detector.ts';

/**
 * Regression contract for the 2026-10-03 incident
 * (session 261001-active-eclipse: ~250 identical iterations at ~7s/round
 * over 1h+ while 19 auto-compactions erased the "already done" memory).
 *
 * The silence-based stall watchdog cannot see this turn — every ~7s event
 * kept pushing its idle deadline back. This detector is the busy-side
 * complement: identical call + identical result, N in a row, is a dead
 * loop even while events flow steadily.
 *
 * Default thresholds under test:
 *   - first 3 identical (fingerprint+result) pairs: no intervention
 *   - 4th identical call → DENY (instructive result, call not executed)
 *   - denied calls extend the streak → 6th → ABORT
 *   - 500 tool calls per turn → ABORT
 *     (default is env-tunable: CRAFT_PI_MAX_TURN_TOOL_CALLS)
 *   - NO wall-clock cap: a legitimate multi-hour turn is never aborted just
 *     for taking time. Only the call-count cap and the identical-repeat
 *     streak can abort.
 */

const CALL = { type: 'bash', command: 'git status' };
const DIGEST = digestResult('nothing to commit, working tree clean', false);

/** Record N executed completions of the same call. */
function fillStreak(detector: ToolLoopDetector, n: number): void {
  for (let i = 0; i < n; i++) {
    expect(detector.recordStart(CALL)).toBeNull();
    detector.recordCompletion(fingerprintToolCall(CALL), DIGEST);
  }
}

describe('fingerprintToolCall', () => {
  it('bash: normalizes whitespace in the command', () => {
    expect(fingerprintToolCall({ type: 'bash', command: 'git   status' }))
      .toBe(fingerprintToolCall({ type: 'bash', command: 'git status\n' }));
  });

  it('non-bash: keyed by sorted args, underscore metadata excluded', () => {
    const a = fingerprintToolCall({ type: 'read', args: { _intent: 'x', path: 'f.ts', limit: 10 } });
    const b = fingerprintToolCall({ type: 'read', args: { limit: 10, path: 'f.ts' } });
    expect(a).toBe(b);
    expect(a).not.toContain('_intent');
  });

  it('different args → different fingerprints', () => {
    expect(fingerprintToolCall({ type: 'read', args: { path: 'a.ts' } }))
      .not.toBe(fingerprintToolCall({ type: 'read', args: { path: 'b.ts' } }));
  });
});

describe('digestResult', () => {
  it('errors digest to a constant', () => {
    expect(digestResult('boom', true)).toBe('error');
    expect(digestResult('other boom', true)).toBe('error');
  });

  it('blanks digest distinctly', () => {
    expect(digestResult('', false)).toBe('(empty)');
  });

  it('normalizes whitespace and is prefix-sensitive', () => {
    const d1 = digestResult('a  b\n c', false);
    expect(d1).toBe(digestResult('a b c', false));
    expect(digestResult('a b c', false)).not.toBe(digestResult('a b c d', false));
  });
});

describe('ToolLoopDetector (repeat threshold)', () => {
  it('lets the first 3 identical calls through (no intervention)', () => {
    const d = new ToolLoopDetector();
    fillStreak(d, 3); // calls 1–3 executed, all recorded, no deny
    expect(d['consecutiveRepeats']).toBe(3);
  });

  it('denies the 4th consecutive identical call', () => {
    const d = new ToolLoopDetector();
    fillStreak(d, 3);
    const intervention = d.recordStart(CALL);
    expect(intervention?.level).toBe('deny');
    expect(intervention?.message).toContain('BLOCKED');
    expect(intervention?.message).toContain('Do NOT repeat');
    expect(intervention?.repeats).toBe(4);
  });

  it('does NOT deny a different call or a different result', () => {
    // Different tool/command: streak resets at the next completion.
    const d1 = new ToolLoopDetector();
    fillStreak(d1, 3);
    expect(d1.recordStart({ type: 'bash', command: 'git log' })).toBeNull();
    d1.recordCompletion(fingerprintToolCall({ type: 'bash', command: 'git log' }), digestResult('new output', false));

    // Same call but CHANGED result (state actually changed): the different
    // digest resets the streak at completion → no deny follows.
    const d2 = new ToolLoopDetector();
    fillStreak(d2, 2); // 2 completed pairs
    const other = { type: 'bash', command: 'git status' };
    const fp = fingerprintToolCall(other);
    d2.recordCompletion(fp, digestResult('modified: file.ts', false)); // 3rd pair, CHANGED digest → streak=1
    expect(d2.recordStart(other)).toBeNull(); // streak 2 < threshold
    d2.recordCompletion(fp, digestResult('modified: file.ts', false)); // streak=2
    expect(d2.recordStart(other)).toBeNull(); // streak 3 < threshold
  });

  it('aborts after threshold + abortAfterExtraRepeats denied repeats', () => {
    const d = new ToolLoopDetector();
    fillStreak(d, 3);
    // 4th → deny
    expect(d.recordStart(CALL)?.level).toBe('deny');
    // 5th → still deny (streak 5 < threshold+2=6)
    expect(d.recordStart(CALL)?.level).toBe('deny');
    // 6th → abort
    const intervention = d.recordStart(CALL);
    expect(intervention?.level).toBe('abort');
    expect(intervention?.message).toContain('Turn aborted');
    expect(intervention?.repeats).toBe(6);
  });

  it('respects a different result digest between calls (no false streak)', () => {
    const d = new ToolLoopDetector();
    const fp = fingerprintToolCall(CALL);
    const results = ['r1', 'r2', 'r1', 'r1'];
    for (const r of results) {
      expect(d.recordStart(CALL)).toBeNull();
      d.recordCompletion(fp, digestResult(r, false));
    }
    // streak is only 2 identical in a row → no intervention
    expect(d.recordStart(CALL)).toBeNull();
  });
});

describe('ToolLoopDetector (busy caps)', () => {
  it('aborts when the call count cap is exceeded', () => {
    const d = new ToolLoopDetector({ maxTurnToolCalls: 5 });
    for (let i = 0; i < 5; i++) {
      expect(d.recordStart({ type: 'read', args: { path: `f${i}.ts` } })).toBeNull();
      d.recordCompletion(`read:path=f${i}.ts`, digestResult(`content ${i}`, false));
    }
    const intervention = d.recordStart({ type: 'read', args: { path: 'f5.ts' } });
    expect(intervention?.level).toBe('abort');
    expect(intervention?.message).toContain('exceeded 5 tool calls');
  });

  it('has NO wall-clock cap — long turns with progress are never aborted for taking time', () => {
    // Regression: the 60-min busy cap (removed 2026-10-04) killed legitimate
    // multi-hour turns. The detector only limits call COUNT and identical
    // repeat streaks — a turn running for hours with distinct, progressing
    // calls must be allowed through regardless of elapsed time.
    const d = new ToolLoopDetector();
    expect((d['opts'] as Record<string, unknown>)['maxTurnDurationMs']).toBeUndefined();
    expect((d as { turnStartedAt?: number })['turnStartedAt']).toBeUndefined();
    for (let i = 0; i < 100; i++) {
      const call = { type: 'read', args: { path: `f${i}.ts` } };
      expect(d.recordStart(call)).toBeNull();
      d.recordCompletion(fingerprintToolCall(call), digestResult(`content ${i}`, false));
    }
    // 100 distinct calls, arbitrarily "later" in wall-clock terms: still no intervention
    expect(d.recordStart({ type: 'read', args: { path: 'f100.ts' } })).toBeNull();
  });

  it('resetTurn clears counts and streak', () => {
    const d = new ToolLoopDetector();
    fillStreak(d, 3);
    expect(d.recordStart(CALL)?.level).toBe('deny');
    d.resetTurn();
    expect(d.recordStart(CALL)).toBeNull();
  });
});

describe('empty-args guard (P2)', () => {
  it('detects null/undefined and truly empty input as empty', () => {
    expect(isEmptyArgs(null)).toBe(true);
    expect(isEmptyArgs(undefined)).toBe(true);
    expect(isEmptyArgs({})).toBe(true);
  });

  it('rejects empty built-in calls but permits parameterless MCP meta tools', () => {
    expect(shouldRejectEmptyArgs('Bash', {})).toBe(true);
    expect(shouldRejectEmptyArgs('mcp__session__tools_compute', {})).toBe(false);
    expect(shouldRejectEmptyArgs('mcp__github__list_repositories', {})).toBe(false);
  });

  it('counts craft-metadata-only calls as empty (built-in path still has _displayName/_intent attached)', () => {
    expect(isEmptyArgs({ _displayName: 'X', _intent: 'Y' })).toBe(true);
  });

  it('real arguments are never empty', () => {
    expect(isEmptyArgs({ command: 'echo hi', _displayName: 'X' })).toBe(false);
  });

  it('message names the tool and offers the stop-calling-tools escape hatch', () => {
    const msg = emptyArgsMessage('bash');
    expect(msg).toContain("'bash'");
    expect(msg).toContain('empty parameter object');
    expect(msg).toContain('finish');
  });
});
