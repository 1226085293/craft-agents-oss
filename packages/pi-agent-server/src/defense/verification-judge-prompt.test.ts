import { describe, expect, it } from 'bun:test'
import { buildVerificationJudgePrompt } from './judge-prompt.ts'

/**
 * Judge prompt contract (2026-10-14, second layer for 261013-mild-stream).
 *
 * The old single-paragraph prompt ("be fair: any reasonably complete answer
 * ... PASSES. Only fail when ...") let a reply whose MAIN BODY was
 * meta-narration about its own delivery ("我上一轮的最终回复已经完整交付了
 * 原请求……现在补充……") sail through the judge; it was replayed verbatim, so
 * the user received a reply *about* the previous reply.
 *
 * The fix replaces the paragraph with an explicit RULE list (RULE 1 first =
 * meta-narration check, RULE 2 = permissive completion summary, RULE 3 =
 * prior fault conditions). Measured on a flash-grade judge: single-paragraph
 * version PASSed the incident text (bug), RULE-list version FAILs it 4/4
 * while genuine "done, here's what I did" summaries still PASS 4/4.
 *
 * These tests pin the contract: (1) RULE 1 names the meta-narration signals
 * including the "supplement to an earlier answer" self-description;
 * (2) RULE 2 keeps the permissive completion-summary clause; (3) RULE 3
 * keeps prior fault conditions; (4) the one-word answer contract and the
 * user/candidate embedding are unchanged.
 */

describe('buildVerificationJudgePrompt', () => {
  it('RULE 1 names the meta-narration signals (261013-mild-stream second layer)', () => {
    const prompt = buildVerificationJudgePrompt('请补充设置页面方案', 'draft text')

    expect(prompt).toContain('RULE 1')
    expect(prompt).toContain('reports or narrates the assistant\'s own earlier delivery')
    expect(prompt).toContain('"my previous reply already delivered ..."')
    expect(prompt).toContain('"now adding ..."')
    // The incident's own tell: the reply says it is only a supplement
    // ("其余内容维持原样") — RULE 1 must flag that too.
    expect(prompt).toContain('only a supplement to an earlier answer')
    expect(prompt).toContain('"其余内容维持原样"')
    expect(prompt).toContain('answers the user NOW, self-contained')
  })

  it('RULE 2 keeps the permissive completion-summary clause (no regressions)', () => {
    const prompt = buildVerificationJudgePrompt('u', 'c')

    // Genuine "done, here's what I did" summaries must NOT be caught by
    // RULE 1 — they are a valid complete answer form.
    expect(prompt).toContain('RULE 2')
    expect(prompt).toContain('done, here\'s what I did')
    expect(prompt).toContain('directly answers the user\'s message')
  })

  it('RULE 3 keeps the prior fault conditions', () => {
    const prompt = buildVerificationJudgePrompt('请写一份设置页方案', '草稿')

    expect(prompt).toContain('RULE 3')
    expect(prompt).toContain('missing, off-topic, clear refusal, factually empty, or stops mid-sentence')
  })

  it('keeps the one-word answer contract', () => {
    const prompt = buildVerificationJudgePrompt('请写一份设置页方案', '草稿')

    expect(prompt).toContain('Answer with EXACTLY one word: PASS or FAIL.')
  })

  it('embeds the user message and candidate for the two-part check', () => {
    const userMsg = '补充并完善设置页面改动方案，也可以删掉不合理的部分'
    const candidate = '我上一轮的最终回复已经完整交付了原请求……'
    const prompt = buildVerificationJudgePrompt(userMsg, candidate)

    expect(prompt).toContain(userMsg)
    expect(prompt).toContain(candidate)
  })
})
