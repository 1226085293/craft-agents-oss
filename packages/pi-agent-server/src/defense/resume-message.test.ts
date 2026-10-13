import { describe, expect, it } from 'bun:test'
import { DefenseEvaluator } from './evaluator.ts'

/**
 * Resume-message contract for verification-class turns (2026-10-13,
 * 261013-mild-stream incident).
 *
 * On a FAIL judge verdict the same turn continues via a followUp carrying
 * this message. The real incident produced two defects:
 *
 * 1. P0 — the model read \"then continue\" as \"continue the investigation\"
 *    and re-ran four tool calls it had already completed minutes earlier in
 *    the same turn (grep/sed/head on identical targets).
 * 2. P1-① — instead of a clean reply it emitted META-NARRATION about its own
 *    delivery (\"my previous final reply already fully delivered the original
 *    request ... now adding the list of ...\"). The judge PASSed that text and
 *    it was replayed verbatim, so the user got a reply *about* a reply.
 *
 * The rewrite makes \"write the complete reply now\" the FIRST instruction and
 * adds two explicit prohibitions. These tests pin both, plus the pre-existing
 * per-signal lines that other suites already assert on.
 */

function longTurnEvaluator(): DefenseEvaluator {
  // verifyMinSteps=1 + verifyMinDurationMs=0 → every deliverable stop is a
  // verification-class turn, keeping the fixture focused on the message.
  return new DefenseEvaluator({ enabled: true, verifyMinSteps: 1, verifyMinDurationMs: 0 })
}

function evaluate(e: DefenseEvaluator, message: unknown): { verifyRequired?: boolean; resumeMessage?: string; reason?: string } {
  return e.evaluate(message as Parameters<DefenseEvaluator['evaluate']>[0])
}

const COMPLETE_FINAL = {
  hasVisibleText: true,
  hasFinalText: true,
  stopReason: 'stop',
  aborted: false,
}

describe('buildResumeMessage — verification delivery wording', () => {
  it('demands the complete reply itself, not a description of it', () => {
    const e = longTurnEvaluator()
    const r = evaluate(e, COMPLETE_FINAL)
    expect(r.verifyRequired).toBe(true)
    const msg = r.resumeMessage!

    // The first instruction after the header must be the delivery act.
    expect(msg).toContain('Write the COMPLETE final reply')
    expect(msg).toContain('must be the reply itself')
  });

  it('forbids meta-narration about the delivery process', () => {
    const e = longTurnEvaluator()
    const msg = evaluate(e, COMPLETE_FINAL).resumeMessage!

    // P1-①: prohibition present, with concrete examples of the failure mode.
    expect(msg).toContain('Do NOT write narration about the delivery process')
    expect(msg).toContain('"my previous reply already')
    expect(msg).toContain('"now adding ...')
    expect(msg).toContain('Just give the answer')
  });

  it('forbids re-running investigation already done in this turn', () => {
    const e = longTurnEvaluator()
    const msg = evaluate(e, COMPLETE_FINAL).resumeMessage!

    // P0: the resume is bounded to the delta, not a fresh investigation.
    expect(msg).toContain('You already did the research for this turn')
    expect(msg).toContain('do NOT run them')
    expect(msg).toContain('Only fill a gap you can point to concretely')
    expect(msg).toContain('Do NOT repeat already completed steps')
  });

  it('asks for a full corrected version instead of a patch/diff', () => {
    const e = longTurnEvaluator()
    const msg = evaluate(e, COMPLETE_FINAL).resumeMessage!
    expect(msg).toContain('verbatim')
    expect(msg).toContain('never a patch')
  });

  it('no longer frames the step as \"judge your delivery then state the reason\"', () => {
    const e = longTurnEvaluator()
    const msg = evaluate(e, COMPLETE_FINAL).resumeMessage!

    // The old round-based self-evaluation framing is what produced the
    // meta-narration. \"Judge whether your final reply ... corresponds\" must
    // be gone from the delivery instruction.
    expect(msg).not.toContain('Judge whether your final reply')
    expect(msg).not.toContain('state the reason')
  });

  it('keeps the per-signal aid lines surviving from before', () => {
    const repetition = longTurnEvaluator()
    const rmsg = evaluate(repetition, {
      hasVisibleText: true,
      hasFinalText: false,
      hasRepetitionLoop: true,
      stopReason: 'stop',
      aborted: false,
    })
    expect(rmsg.resumeMessage).toContain('REPETITION LOOP')

    const empty = longTurnEvaluator()
    const emsg = evaluate(empty, {
      hasVisibleText: false,
      hasFinalText: false,
      endsWithEmptyResponse: true,
      stopReason: 'stop',
      aborted: false,
    })
    expect(emsg.resumeMessage).toContain('EMPTY response')

    const truncated = longTurnEvaluator()
    const tmsg = evaluate(truncated, {
      hasVisibleText: true,
      hasFinalText: true,
      truncatedFinal: true,
      stopReason: 'length',
      aborted: false,
    })
    expect(tmsg.resumeMessage).toContain('CUT OFF by the output token limit')

    const stalled = longTurnEvaluator()
    const smsg = evaluate(stalled, {
      hasVisibleText: true,
      hasFinalText: false,
      stallAborted: true,
      aborted: true,
      stopReason: 'aborted',
    })
    expect(smsg.resumeMessage).toContain('ABORTED BY THE SYSTEM')
    expect(smsg.resumeMessage).toContain('NOT by the user')
    expect(smsg.resumeMessage).toContain('continue the task')
  });
});
