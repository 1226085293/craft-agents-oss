import { describe, expect, it } from 'bun:test';
import {
  classifyRetryStep,
  isSdkBusyRejection,
  isUserStoppedTurn,
  type AbortReason,
  type LastAssistantShape,
} from './retry-step-classifier.ts';

/**
 * Retry-step whitelist contract (2026-10-13, session 261008-plain-stag).
 *
 * Regression: the turn ended on an EMPTY stopReason='aborted' assistant
 * message (produced by the retry's own busy-abort), the whitelist refused it
 * ("Cannot retry: the current turn has no re-runnable model step."), and the
 * background ladder looped forever at its rung schedule. Fix contract:
 *   - stopReason='error'  → strip & re-run (unchanged).
 *   - empty stop/length   → strip & re-run (unchanged).
 *   - empty aborted + abortReason='system' → strip & re-run (NEW).
 *   - empty aborted + abortReason='user'   → refuse (P0 rule intact — never
 *     revive a deliberately stopped turn).
 *   - delivered reply + pending follow-ups → drain, no strip (unchanged).
 *   - anything else → refuse (unchanged).
 */

function am(shape: Partial<LastAssistantShape> & { stopReason?: string }): LastAssistantShape {
  return { content: [], ...shape };
}

const TEXT = (t: string) => [{ type: 'text', text: t }];

describe('classifyRetryStep — strip whitelist', () => {
  it('failed step (stopReason=error) strips — unchanged 2026-10-06 behavior', () => {
    const verdict = classifyRetryStep(am({ stopReason: 'error', errorMessage: 'Stream ended without finish_reason' }), null, 0);
    expect(verdict).toEqual({ kind: 'strip', why: 'failed_step' });
  });

  it('empty clean stop (stop, no text) strips — unchanged', () => {
    expect(classifyRetryStep(am({ stopReason: 'stop' }), null, 0))
      .toEqual({ kind: 'strip', why: 'empty_clean_stop' });
  });

  it('empty clean stop (length, no text) strips — unchanged', () => {
    expect(classifyRetryStep(am({ stopReason: 'length' }), null, 0))
      .toEqual({ kind: 'strip', why: 'empty_clean_stop' });
  });

  it('system-aborted empty step strips — the 261008-plain-stag unblock', () => {
    const verdict = classifyRetryStep(am({ stopReason: 'aborted' }), 'system', 0);
    expect(verdict).toEqual({ kind: 'strip', why: 'system_aborted' });
  });

  it('system-aborted step WITH visible text refuses — a text-carrying aborted run may be a partial real answer', () => {
    const verdict = classifyRetryStep(am({ stopReason: 'aborted', content: TEXT('partial answer') }), 'system', 0);
    expect(verdict).toEqual({ kind: 'refuse' });
  });

  it('aborted step with string-typed (non-list) content treats text as absent — no visible text block, strips as system_aborted', () => {
    // The classifier only treats ARRAY content blocks as visible text; a
    // non-array content shape (never emitted by the SDK) falls back to the
    // same empty content path — still safe because the abort attribution
    // gates the decision.
    const verdict = classifyRetryStep(am({ stopReason: 'aborted', content: 'plain string' as unknown as never[] }), 'system', 0);
    expect(verdict).toEqual({ kind: 'strip', why: 'system_aborted' });
  });
});

describe('classifyRetryStep — user-stop P0 rule (never revive a stopped turn)', () => {
  it('USER-stopped empty step refuses — P0 intact', () => {
    expect(classifyRetryStep(am({ stopReason: 'aborted' }), 'user', 0)).toEqual({ kind: 'refuse' });
  });

  it('null attribution refuses too — unknown origin is not worth reviving', () => {
    expect(classifyRetryStep(am({ stopReason: 'aborted' }), null, 0)).toEqual({ kind: 'refuse' });
  });

  it('user-stopped step with visible text refuses', () => {
    expect(classifyRetryStep(am({ stopReason: 'aborted', content: TEXT('x') }), 'user', 0)).toEqual({ kind: 'refuse' });
  });
});

describe('classifyRetryStep — silent-stream recovery drain path (unchanged)', () => {
  it('delivered reply with pending follow-ups drains, no strip', () => {
    const verdict = classifyRetryStep(am({ stopReason: 'stop', content: TEXT('real answer') }), null, 2);
    expect(verdict).toEqual({ kind: 'drain_pending' });
  });

  it('real reply with NO pending follow-ups refuses', () => {
    expect(classifyRetryStep(am({ stopReason: 'stop', content: TEXT('real answer') }), null, 0))
      .toEqual({ kind: 'refuse' });
  });
});

describe('isSdkBusyRejection — coordination signals are not faults', () => {
  it('exact SDK busy message is detected', () => {
    expect(isSdkBusyRejection('Agent is already processing. Wait for completion before continuing.')).toBe(true);
  });

  it('already busy variant is detected', () => {
    expect(isSdkBusyRejection('Agent is already busy')).toBe(true);
  });

  it('wait-for-completion phrasing is detected', () => {
    expect(isSdkBusyRejection('Wait for completion before continuing.')).toBe(true);
  });

  it('case-insensitive', () => {
    expect(isSdkBusyRejection('AGENT IS ALREADY PROCESSING')).toBe(true);
  });

  it('genuine failures are NOT busy rejections', () => {
    expect(isSdkBusyRejection('Turn stalled: no activity for 300s — aborting')).toBe(false);
    expect(isSdkBusyRejection('Upstream SSE protocol error')).toBe(false);
    expect(isSdkBusyRejection('Rate limit exceeded')).toBe(false);
  });

  it('unrelated text containing "already" does not false-positive', () => {
    expect(isSdkBusyRejection('Stream already closed' )).toBe(false);
  });
});

// Sanity: the exported AbortReason type is the exact union the server writes.
describe('AbortReason type surface', () => {
  it('accepts the three server-side values', () => {
    const reasons: AbortReason[] = ['user', 'system', null];
    expect(reasons).toHaveLength(3);
  });
});
/**
 * 2026-10-18 (session 261016-deft-tide): a tool promise hung, the stall
 * watchdog aborted the run, and the transcript tail stayed on an assistant
 * stopReason='toolUse' step with NO toolResult messages. `continue()` cannot
 * run from an assistant tail, so every retry refused with "no re-runnable
 * model step" forever. The classifier now synthesizes an error toolResult per
 * dangling call — but only for SYSTEM-attributed aborts (P0: never revive a
 * user-stopped turn).
 */
describe('classifyRetryStep — dangling toolUse recovery (2026-10-18)', () => {
  const toolCall = (id: string, name = 'mcp__session__call_tool') => ({ type: 'toolCall', id, name });

  it('system-aborted dangling toolUse synthesizes one error result per call', () => {
    const verdict = classifyRetryStep(
      am({ stopReason: 'toolUse', content: [toolCall('call_1')] }),
      'system',
      0,
    );
    expect(verdict).toEqual({
      kind: 'synthesize_tool_results',
      results: [{ toolCallId: 'call_1', toolName: 'mcp__session__call_tool' }],
    });
  });

  it('multiple dangling calls all get results', () => {
    const verdict = classifyRetryStep(
      am({ stopReason: 'toolUse', content: [toolCall('call_1'), toolCall('call_2', 'Bash')] }),
      'system',
      0,
    );
    expect(verdict).toEqual({
      kind: 'synthesize_tool_results',
      results: [
        { toolCallId: 'call_1', toolName: 'mcp__session__call_tool' },
        { toolCallId: 'call_2', toolName: 'Bash' },
      ],
    });
  });

  it('a dangling toolUse step that also carries partial text still synthesizes', () => {
    const verdict = classifyRetryStep(
      am({ stopReason: 'toolUse', content: [...TEXT('partial progress'), toolCall('call_1')] }),
      'system',
      0,
    );
    expect(verdict.kind).toBe('synthesize_tool_results');
  });

  it('USER-stopped toolUse refuses — P0 intact', () => {
    expect(classifyRetryStep(
      am({ stopReason: 'toolUse', content: [toolCall('call_1')] }),
      'user',
      0,
    )).toEqual({ kind: 'refuse' });
  });

  it('null attribution refuses too (unknown origin is not revived)', () => {
    expect(classifyRetryStep(
      am({ stopReason: 'toolUse', content: [toolCall('call_1')] }),
      null,
      0,
    )).toEqual({ kind: 'refuse' });
  });

  it('a toolUse step with no identifiable toolCall blocks refuses (nothing to synthesize)', () => {
    expect(classifyRetryStep(
      am({ stopReason: 'toolUse', content: [{ type: 'text', text: 'no calls' }] }),
      'system',
      0,
    )).toEqual({ kind: 'refuse' });
  });

  it('missing tool name falls back to "unknown"', () => {
    const verdict = classifyRetryStep(
      am({ stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'call_1' }] }),
      'system',
      0,
    );
    expect(verdict).toEqual({
      kind: 'synthesize_tool_results',
      results: [{ toolCallId: 'call_1', toolName: 'unknown' }],
    });
  });
});


/**
 * 2026-10-18 (P0 hardening): handleAbort now rejects the hung tool, so a
 * user-stopped turn's transcript tail can be a re-runnable toolResult. The
 * classifier only gates assistant tails; handleRetry uses this latch for the
 * rest. Attribution is reset at the start of each fresh prompt.
 */
describe('isUserStoppedTurn — P0 retry latch (2026-10-18)', () => {
  it('user attribution refuses a retry (even with a toolResult tail)', () => {
    expect(isUserStoppedTurn('user')).toBe(true);
  });

  it('system attribution allows a retry', () => {
    expect(isUserStoppedTurn('system')).toBe(false);
  });

  it('null attribution allows a retry', () => {
    expect(isUserStoppedTurn(null)).toBe(false);
  });
});
