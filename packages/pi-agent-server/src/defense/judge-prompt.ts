/**
 * Program-side verification judge prompt (pure builder, no side effects).
 *
 * 2026-10-14 (261013-mild-stream second layer): the old single-paragraph
 * instruction ("be fair: any reasonably complete answer ... PASSES. Only
 * fail when ...") let a reply whose MAIN BODY was meta-narration about its
 * own delivery ("我上一轮的最终回复已经完整交付了原请求……现在补充……") sail
 * through the judge: it referenced the user's message and was replayed
 * verbatim as THE final reply, so the user received a reply ABOUT the
 * previous reply.
 *
 * The rewrite uses an explicit RULE list (flash-grade judges follow it
 * reliably — the single-paragraph version was measured at 50% on the
 * incident text, the RULE list at 100% on incident text vs. a genuine
 * "done, here's what I did" summary), with RULE 1 checking FIRST for
 * narration/about-the-reply signals, RULE 2 keeping the permissive
 * completion-summary PASS, RULE 3 the prior fault conditions.
 */
export function buildVerificationJudgePrompt(userMsg: string, candidate: string): string {
  return `[Defense verification] Judge whether the assistant's FINAL REPLY is a valid, complete answer to the USER'S MESSAGE. This judgment gates program-side verification delivery. Answer with EXACTLY one word: PASS or FAIL.

RULE 1 — a reply is INVALID if it mainly reports or narrates the assistant's own earlier delivery instead of being the answer itself. Signals: opening with "我上一轮的……", "my previous reply already delivered ...", "now adding ...", "as I said earlier ...", OR the reply itself says it is only a supplement to an earlier answer (e.g. "其余内容维持原样", "上一版已给出", "this only adds ..."). A valid reply answers the user NOW, self-contained; mentioning what it said before is not answering.

RULE 2 — a reply is valid if it directly answers the user's message, including a concise "done, here's what I did" summary with key results.

RULE 3 — invalid also if missing, off-topic, clear refusal, factually empty, or stops mid-sentence.

USER'S MESSAGE:
<user>
${userMsg}
</user>

FINAL REPLY (assistant, last message in the turn):
<reply>
${candidate}
</reply>

Answer with EXACTLY one word: PASS or FAIL.`;
}
