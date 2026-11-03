/**
 * Verification-failure resume: verdict-aware continuation (2026-11-03).
 *
 * The verification lane used to reuse `buildResumeMessage()` — the *delivery*
 * prompt written for the fault classes (silent stop / empty reply / repetition
 * / truncation). That prompt opens with
 *
 *   "[Defense] Verification delivery step — deliver, do NOT re-run the task."
 *   "... output that reply verbatim."
 *
 * which is correct when the only problem is that the reply was never written
 * out. It is catastrophic when the judge said `incomplete` (RULE 2: a
 * multi-step request was partially done and the model stopped to ask). There
 * the model is told to re-deliver what it already wrote and NOT to run tools,
 * so it re-emits byte-identical text; the content-stability stop-loss then
 * reads that identity as "retrying cannot change the outcome" and delivers the
 * rejected reply. Two designs lock into a guaranteed no-progress loop
 * (2026-11-03, session 261103-ivory-current: judge FAILed twice, the user
 * still received the "P1 done — want me to…?" reply).
 *
 * This module replaces the reused prompt for typed FAILs:
 * - `incomplete`  → CONTINUE lane: keep working with tools, never ask.
 * - `truncated`   → FINISH lane: resume the cut-off reply (no new work).
 * - `off-topic` / `other` → REWRITE lane: answer the request, no verbatim escape.
 *
 * It also replaces the byte-identity stop-loss with a bounded no-progress
 * breaker that NEVER claims a pass: escalate once (continue lane, no tools
 * run), then deliver the rejected text *labelled as a failure*.
 */

/** How a rejected reply should be repaired. */
export type VerificationResumeLane =
  /** Task not finished — run tools, do not deliver a summary. */
  | 'continue'
  /** Reply was cut off — finish the text, no new investigation. */
  | 'finish'
  /** Reply missed the request — write the correct answer. */
  | 'rewrite'

/** Map the judge's machine slug to a repair lane. */
export function laneForFailType(failType: string | undefined): VerificationResumeLane {
  switch (failType) {
    case 'incomplete':
      return 'continue'
    case 'truncated':
      return 'finish'
    default:
      // 'off-topic', 'other', or an unparsed slug: the answer itself is wrong.
      return 'rewrite'
  }
}

export interface VerificationResumeInput {
  failType?: string
  /** The judge's reason, verbatim. Never dropped: it names the missing items. */
  reason: string
  /** 1-based attempt index inside this verification cycle (diagnostics only). */
  attempt: number
  /** True when this is the second, firmer continuation after a no-op round. */
  escalated?: boolean
}

/** Max characters of judge reason embedded in the resume prompt. */
const MAX_REASON_CHARS = 1_200

/**
 * Build the resume message for a typed verification FAIL.
 *
 * Wording rules that must survive future edits:
 * - `continue` lane must NOT contain "verbatim" and must NOT say "do NOT
 *   re-run" — those two phrases are what produced the no-progress loop.
 * - Every lane forbids meta-narration about the verification step.
 * - Asking the user is only allowed for a genuine user-only blocker.
 */
export function buildVerificationResumeMessage(input: VerificationResumeInput): string {
  const lane = laneForFailType(input.failType)
  const type = input.failType ? ` (${input.failType})` : ''
  const reason = (input.reason || '').trim().slice(0, MAX_REASON_CHARS)
  const quoted = reason
    ? `Its reason, verbatim:\n${reason.split('\n').map((line) => `  > ${line}`).join('\n')}`
    : 'It gave no detailed reason.'

  if (lane === 'continue') {
    const lines = [
      `[Defense] Verification FAILED${type} — the task is NOT finished. Continue the work now; this is not a delivery step.`,
      `An independent verification judge rejected your last reply as INCOMPLETE. ${quoted}`,
    ]
    if (input.escalated) {
      lines.push(
        `You were already told once to continue, and your last round re-sent the same rejected text without running a single tool. That is a no-op — repeating the text changes nothing.`,
      )
    }
    lines.push(
      `Do this round:`,
      `1. Execute the remaining items listed above with your tools — edit the files, run the tests/typecheck, commit. Real work, not a plan.`,
      `2. Do NOT ask the user whether to continue ("要我做吗?", "shall I…", "want me to…", "需要我…吗?"). The user already asked for all steps to be finished; asking again is the failure being corrected here. Only a genuine user-only blocker (missing credentials, missing authorization, information that exists nowhere in the workspace) may stop you — and then state exactly what is missing.`,
      `3. Do NOT re-send the previous reply, not even reworded, and do not describe this verification step.`,
      `4. When — and only when — every item above is actually done, write the final reply: the result, with the concrete evidence (what changed, what passed).`,
    )
    return lines.join('\n')
  }

  if (lane === 'finish') {
    return [
      `[Defense] Verification FAILED${type} — your last reply was cut off. Finish it now.`,
      `An independent verification judge rejected your last reply as TRUNCATED. ${quoted}`,
      `Continue the reply from exactly where it stopped. Do not restart it, do not redo completed work, do not investigate anything new, and do not describe this verification step. Deliver the complete text this time.`,
      `If finishing it reveals a genuinely unfinished step of the task, do that step with your tools first.`,
    ].join('\n')
  }

  return [
    `[Defense] Verification FAILED${type} — your last reply does not answer the request. Rewrite it now.`,
    `An independent verification judge rejected your last reply. ${quoted}`,
    `Write the complete, correct answer to the user's request. Fix exactly the objection above.`,
    `Do not re-send the rejected text unchanged, do not narrate this verification step, and do not redo investigation that is already done — only fill the gap named above.`,
    `If the objection is that work is still missing, do that work with your tools before answering, and do not ask the user whether to proceed.`,
  ].join('\n')
}

/** What to do with a rejected reply. */
export type VerificationRetryAction =
  /** Queue another resume (normal repair round). */
  | 'continue'
  /** Queue a firmer continuation: the model ignored the previous one. */
  | 'escalate'
  /** Stop retrying: deliver the current text, labelled as a verification FAILURE. */
  | 'deliver-exhausted'

export interface VerificationRetryInput {
  /** Byte-identical to the previously judged candidate. */
  identical: boolean
  lane: VerificationResumeLane
  /** The run that produced this candidate executed at least one tool call. */
  ranTools: boolean
  /** Escalations already sent in this verification cycle. */
  escalationsUsed: number
  /** Identical-text rounds seen in this cycle, INCLUDING this one (1-based). */
  identicalRounds: number
}

/** Identical rounds tolerated before the turn gives up and delivers. */
export const MAX_IDENTICAL_ROUNDS = 2

/**
 * Bounded no-progress breaker (replaces the content-stability stop-loss).
 *
 * The old rule delivered the rejected text as a PASS the moment the text
 * repeated, which made a delivery-worded resume self-confirming. The breaker
 * distinguishes "the model is stuck" from "the model was never asked to work":
 *
 * - Repeated text + continue lane + zero tool calls → the model did not obey
 *   the continuation. Send ONE escalation before giving up.
 * - Still repeated after that (or a rewrite/finish lane repeating itself,
 *   where an escalation cannot help) → stop, but report a FAILURE.
 *
 * The returned action never means "the verdict changed"; a `deliver-exhausted`
 * delivery must stay visible as a failed verification in the UI.
 */
export function decideVerificationRetry(input: VerificationRetryInput): VerificationRetryAction {
  if (!input.identical) return 'continue'
  if (input.lane === 'continue' && !input.ranTools && input.escalationsUsed < 1) {
    return 'escalate'
  }
  if (input.identicalRounds < MAX_IDENTICAL_ROUNDS) return 'continue'
  return 'deliver-exhausted'
}
