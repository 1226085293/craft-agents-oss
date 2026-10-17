import { describe, expect, it } from 'bun:test'
import { buildVerificationJudgePrompt, JUDGE_FAIL_TYPE, JUDGE_REASON_MAX_CHARS } from './judge-prompt.ts'

/**
 * Judge prompt contract.
 *
 * 2026-10-14 (261013-mild-stream second layer): the single-paragraph prompt
 * ("be fair: any reasonably complete answer ... PASSES") let a reply whose
 * MAIN BODY was meta-narration about its own delivery sail through; it was
 * replayed verbatim, so the user received a reply *about* the previous reply.
 * The RULE list fixed it (single-paragraph PASSed the incident text,
 * RULE-list FAILs it 4/4 while genuine "done, here's what I did" summaries
 * still PASS 4/4).
 *
 * 2026-10-17 (user-confirmed evolution):
 * - meta-narration is NO LONGER a failure type — delivering the answer IS the
 *   job. RULE 1 keeps only the incident shape (a reply about a previous
 *   reply), and explicitly PASSes a summary that reports what it did.
 * - the judge must answer ONE LINE, machine-readable: `PASS` or
 *   `FAIL|<type>|<reason>`, so the process block can show a typed reason and
 *   the full text is persisted to disk for click-to-open.
 *
 * These tests pin both: the 261013 protection survives, and the new output
 * contract (types + reason budget) is present.
 */

describe('buildVerificationJudgePrompt', () => {
  it('RULE 1 still names the self-referential-reply signals (261013-mild-stream)', () => {
    const prompt = buildVerificationJudgePrompt('请补充设置页面方案', 'draft text')

    expect(prompt).toContain('RULE 1')
    expect(prompt).toContain('refers to earlier delivery instead of answering now')
    // The incident's own tell: the reply says it is only a supplement.
    expect(prompt).toContain('"其余内容维持原样"')
    expect(prompt).toContain('"my previous reply already delivered this; this only adds ..."')
  })

  it('RULE 1 explicitly PASSes a genuine done-summary (meta-narration is not a failure type)', () => {
    const prompt = buildVerificationJudgePrompt('u', 'c')

    expect(prompt).toContain('done, here is what I did')
    expect(prompt).toContain('MUST PASS')
    // No narration category in the failure-type list.
    expect(prompt).not.toContain('meta-narration')
  })

  it('RULE 2 keeps the multi-step incomplete check', () => {
    const prompt = buildVerificationJudgePrompt('完成任务 1-5', 'done')

    expect(prompt).toContain('RULE 2')
    expect(prompt).toContain('type: incomplete')
    // The blocked-items exception survives.
    expect(prompt).toContain('EXCEPTION')
    expect(prompt).toContain('missing permission')
  })

  it('RULE 3/4 keep the prior fault conditions', () => {
    const prompt = buildVerificationJudgePrompt('请写一份设置页方案', '草稿')

    expect(prompt).toContain('RULE 3')
    expect(prompt).toContain('type: off-topic')
    expect(prompt).toContain('RULE 4')
    expect(prompt).toContain('type: truncated')
  })

  it('states the single-line output contract with the exact type slugs', () => {
    const prompt = buildVerificationJudgePrompt('u', 'c')

    expect(prompt).toContain('FAIL|<type>|<one short reason>')
    // Advertised types must match the code's slugs byte-for-byte.
    for (const type of Object.values(JUDGE_FAIL_TYPE)) {
      expect(prompt).toContain(type)
    }
    expect(prompt).toContain(String(JUDGE_REASON_MAX_CHARS))
  })

  it('embeds the user message and candidate in tags', () => {
    const userMsg = '补充并完善设置页面改动方案，也可以删掉不合理的部分'
    const candidate = '我上一轮的最终回复已经完整交付了原请求……'
    const prompt = buildVerificationJudgePrompt(userMsg, candidate)

    expect(prompt).toContain(`<user>\n${userMsg}\n</user>`)
    expect(prompt).toContain(`<reply>\n${candidate}\n</reply>`)
  })

  it('keeps the instruction body compact (flash-grade judge)', () => {
    const body = buildVerificationJudgePrompt('x'.repeat(1000), 'y'.repeat(1000))
      .split("USER'S MESSAGE:")[0]!
    expect(body.length).toBeLessThan(4000)
  })
})
