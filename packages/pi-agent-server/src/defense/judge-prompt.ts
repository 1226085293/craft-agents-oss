/**
 * Program-side verification judge prompt (pure builder, no side effects).
 *
 * Output contract (user-confirmed 2026-10-17): the judge must give a
 * MACHINE-READABLE verdict plus a human reason, so the process block can
 * show `校验失败（<类型>）— 继续执行` and the full reason is one click away.
 *
 *   PASS                                  → reply delivers
 *   FAIL|<类型>|<原因，一句，<=200字>       → follow up + show reason
 *
 * Single-line `|` format (not JSON): a flash-grade model emitting invalid
 * JSON is common, and our FAIL-safe parser then treats every malformed
 * verdict as FAIL — indistinguishable from the judge being down. A single
 * line is far more robust and one regex parses it.
 *
 * History:
 * - 2026-10-14 (261013-mild-stream second layer): the single-paragraph
 *   instruction let a reply whose MAIN BODY was meta-narration about its own
 *   delivery ("我上一轮的最终回复已经完整交付了原请求……现在补充……") sail
 *   through; it was replayed verbatim as THE final reply, so the user
 *   received a reply ABOUT the previous reply. The RULE list fixed that
 *   incident (measured 50% → 100% on incident text).
 * - 2026-10-17: user removed meta-narration as a FAILURE TYPE — delivering
 *   the answer IS the job, and a "here is what I did" summary is a legitimate
 *   delivery. RULE 1 now only rejects a reply that is *about* a previous
 *   reply rather than being the answer itself (the 261013 incident shape),
 *   never a summary that contains results.
 *
 * Types are stable slugs; the UI maps them to i18n text, so do not rename
 * without updating the locale table.
 */

/** Machine-readable failure types. Slugs are stable — i18n maps these. */
export const JUDGE_FAIL_TYPE = {
  /** Multi-step request partially completed then stopped to ask. */
  INCOMPLETE: 'incomplete',
  /** Answer does not address the user's request. */
  OFF_TOPIC: 'off-topic',
  /** Reply cut off / stops mid-sentence. */
  TRUNCATED: 'truncated',
  /** Anything else worth recording verbatim. */
  OTHER: 'other',
} as const

export type JudgeFailType = (typeof JUDGE_FAIL_TYPE)[keyof typeof JUDGE_FAIL_TYPE]

/** Reason budget — keeps the on-screen line readable, full text goes to disk. */
export const JUDGE_REASON_MAX_CHARS = 200

export function buildVerificationJudgePrompt(userMsg: string, candidate: string): string {
  return `[Defense verification] Judge whether the assistant's FINAL REPLY is a valid, complete answer to the USER'S MESSAGE. This judgment gates program-side verification delivery.

ANSWER FORMAT — exactly one line, no prose around it:
- If the reply is valid:  PASS
- If it is not:            FAIL|<type>|<one short reason>

<type> MUST be one of: incomplete, off-topic, truncated, other
Rules for the reason: at most ${JUDGE_REASON_MAX_CHARS} characters, concrete and specific (name the step that is missing or what the reply fails to address), no filler.

JUDGING RULES:
RULE 1 — The reply must BE the answer, not a message about a previous reply. INVALID only when the reply refers to earlier delivery instead of answering now (e.g. "我上一轮的回复已经交付，现在仅作补充", "my previous reply already delivered this; this only adds ...", "其余内容维持原样", "上一版已给出"). A reply that reports what IT did in this turn — including a plain "done, here is what I did" summary with concrete results — is a valid answer and MUST PASS.

RULE 2 — When the user asked for MULTIPLE things (numbered steps, a list, "do X, Y and Z"), the reply is INVALID (type: incomplete) if it finishes only some and then stops to ask whether to continue. EXCEPTION: the remaining items are explicitly blocked (missing permission, missing information, upstream failure) AND the reply says so — that is a valid stop, PASS.

RULE 3 — INVALID (type: off-topic) if the reply does not address the user's request, is a clear refusal, or is factually empty.

RULE 4 — INVALID (type: truncated) if the reply stops mid-sentence or is otherwise incomplete.

When in doubt, PASS — a wrongly blocked reply costs the user a round trip, a wrongly delivered one costs the same.

USER'S MESSAGE:
<user>
${userMsg}
</user>

FINAL REPLY (assistant, last message in the turn):
<reply>
${candidate}
</reply>

Answer with exactly one line (PASS or FAIL|<type>|<reason>).`;
}

/** Test/verification helper: the exact single-line format we expect back. */
export const JUDGE_PASS_TOKEN = 'PASS' as const
