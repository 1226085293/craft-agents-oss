import { describe, expect, it } from 'bun:test'
import {
  MAX_IDENTICAL_ROUNDS,
  buildVerificationResumeMessage,
  decideVerificationRetry,
  laneForFailType,
} from './verification-resume.ts'

describe('laneForFailType', () => {
  it('routes an unfinished multi-step task to the continue lane', () => {
    expect(laneForFailType('incomplete')).toBe('continue')
  })

  it('routes a cut-off reply to the finish lane', () => {
    expect(laneForFailType('truncated')).toBe('finish')
  })

  it('routes off-topic / other / unknown to the rewrite lane', () => {
    expect(laneForFailType('off-topic')).toBe('rewrite')
    expect(laneForFailType('other')).toBe('rewrite')
    expect(laneForFailType(undefined)).toBe('rewrite')
    expect(laneForFailType('made-up-slug')).toBe('rewrite')
  })
})

describe('buildVerificationResumeMessage — continue lane', () => {
  const message = buildVerificationResumeMessage({
    failType: 'incomplete',
    reason: 'Only P1 completed; P2 (listener install) is left, and the reply asks whether to generate a launch script.',
    attempt: 1,
  })

  it('opens as a failure and demands work, not delivery', () => {
    expect(message).toContain('the task is NOT finished')
    expect(message).toContain('Continue the work now')
  })

  it('never carries the delivery-lane escape hatch that caused the no-progress loop', () => {
    // These two phrases are the root cause of 261103-ivory-current: they told
    // the model to re-send the rejected text and not to run tools.
    expect(message.toLowerCase()).not.toContain('verbatim reply')
    expect(message.toLowerCase()).not.toContain('output that reply verbatim')
    expect(message.toLowerCase()).not.toContain('do not re-run the task')
  })

  it('quotes the judge reason so the remaining items are concrete', () => {
    expect(message).toContain('Only P1 completed')
    expect(message).toContain('listener install')
    expect(message).toContain('> ')
  })

  it('forbids asking the user and requires tools', () => {
    expect(message).toContain('Do NOT ask the user whether to continue')
    expect(message).toContain('with your tools')
  })

  it('adds the no-op callout only when escalated', () => {
    const plain = buildVerificationResumeMessage({ failType: 'incomplete', reason: 'x', attempt: 1 })
    const escalated = buildVerificationResumeMessage({ failType: 'incomplete', reason: 'x', attempt: 2, escalated: true })
    expect(plain).not.toContain('without running a single tool')
    expect(escalated).toContain('without running a single tool')
  })
})

describe('buildVerificationResumeMessage — finish lane', () => {
  const message = buildVerificationResumeMessage({ failType: 'truncated', reason: 'reply stops mid-sentence', attempt: 1 })

  it('asks to finish the cut-off text instead of doing new work', () => {
    expect(message).toContain('was cut off')
    expect(message).toContain('Continue the reply from exactly where it stopped')
    expect(message).not.toContain('Do NOT ask the user whether to continue')
  })
})

describe('buildVerificationResumeMessage — rewrite lane', () => {
  const message = buildVerificationResumeMessage({ failType: 'off-topic', reason: 'answer talks about a different task', attempt: 1 })

  it('demands a correct answer and drops the verbatim escape hatch', () => {
    expect(message).toContain('does not answer the request')
    expect(message).toContain('Fix exactly the objection above')
    expect(message.toLowerCase()).not.toContain('output that reply verbatim')
  })
})

describe('decideVerificationRetry', () => {
  const base = { lane: 'continue' as const, ranTools: false, escalationsUsed: 0, identicalRounds: 1 }

  it('keeps repairing a changed reply', () => {
    expect(decideVerificationRetry({ ...base, identical: false })).toBe('continue')
  })

  it('escalates once when the continue lane re-sends text without running tools', () => {
    expect(decideVerificationRetry({ ...base, identical: true })).toBe('escalate')
  })

  it('gives up (as a failure) when the escalation was already spent', () => {
    expect(
      decideVerificationRetry({ ...base, identical: true, escalationsUsed: 1, identicalRounds: 2 }),
    ).toBe('deliver-exhausted')
  })

  it('does not escalate when the repeated round actually ran tools', () => {
    expect(decideVerificationRetry({ ...base, identical: true, ranTools: true })).toBe('continue')
  })

  it('gives up after the identical-round budget', () => {
    expect(
      decideVerificationRetry({
        ...base,
        identical: true,
        ranTools: true,
        identicalRounds: MAX_IDENTICAL_ROUNDS,
      }),
    ).toBe('deliver-exhausted')
  })

  it('never escalates rewrite/finish lanes — an escalation cannot change them', () => {
    expect(decideVerificationRetry({ ...base, lane: 'rewrite', identical: true })).toBe('continue')
    expect(
      decideVerificationRetry({ ...base, lane: 'rewrite', identical: true, identicalRounds: MAX_IDENTICAL_ROUNDS }),
    ).toBe('deliver-exhausted')
    expect(decideVerificationRetry({ ...base, lane: 'finish', identical: true })).toBe('continue')
  })
})
