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
 * 2026-11-01 (quiet-jasmine):
 * - RULE 0: only the CURRENT turn is a requirement; previous turns are
 *   reference-only. The failure mode it kills is grading this turn's reply
 *   against the previous turn's message.
 * - The current turn's user messages (opening request + every mid-turn
 *   guidance) are rendered as ONE ordered, timestamped list; history turns
 *   render `<user>`…`<result>` with timestamps, per the user's layout spec.
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
    expect(prompt).not.toContain('meta-narration')
  })

  it('RULE 2 keeps the multi-step incomplete check', () => {
    const prompt = buildVerificationJudgePrompt('完成任务 1-5', 'done')

    expect(prompt).toContain('RULE 2')
    expect(prompt).toContain('type: incomplete')
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
    for (const type of Object.values(JUDGE_FAIL_TYPE)) {
      expect(prompt).toContain(type)
    }
    expect(prompt).toContain(String(JUDGE_REASON_MAX_CHARS))
  })

  it('embeds the current user message and candidate in tags', () => {
    const userMsg = '补充并完善设置页面改动方案，也可以删掉不合理的部分'
    const candidate = '我上一轮的最终回复已经完整交付了原请求……'
    const prompt = buildVerificationJudgePrompt(userMsg, candidate)

    expect(prompt).toContain(`<user>\n${userMsg}\n</user>`)
    expect(prompt).toContain(`<reply>\n${candidate}\n</reply>`)
  })

  it('RULE 0 makes the previous turns reference-only (quiet-jasmine regression)', () => {
    const prompt = buildVerificationJudgePrompt('做B，但是我记得还有会话路径改变事件触发器', 'done')

    expect(prompt).toContain('RULE 0')
    expect(prompt).toContain('ONLY the CURRENT TURN states what must be delivered')
    expect(prompt).toContain('PREVIOUS TURNS are reference material, NOT requirements')
    expect(prompt).toContain('never return FAIL because the reply does not (re-)cover an item raised in a previous turn')
  })

  it('merges the current turn guidance into the current user list, in order', () => {
    const prompt = buildVerificationJudgePrompt(
      {
        current: [
          { at: '2026-10-31T19:11:27.647Z', text: '左1把项目放在所有会话上面' },
          { at: '2026-10-31T19:12:37.269Z', text: '恢复自动化功能，我没说要删除！', guidance: true },
        ],
      },
      'done',
    )

    const userBlock = prompt.slice(prompt.indexOf('<user>'), prompt.indexOf('</user>') + '</user>'.length)
    expect(userBlock).toContain('左1把项目放在所有会话上面')
    expect(userBlock).toContain('恢复自动化功能，我没说要删除！')
    // Ordered, timestamped, one line per user message. The stamp is rendered in
    // the process's local time (`bun test` runs with TZ=UTC), so assert the
    // shape rather than a fixed wall-clock value.
    expect(userBlock).toMatch(/<user>\n\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} · 左1把项目放在所有会话上面\n\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} · 恢复自动化功能，我没说要删除！\n<\/user>/)
    expect(userBlock.indexOf('左1把项目')).toBeLessThan(userBlock.indexOf('恢复自动化功能'))
  })

  it('renders history as reference-only <user>/<result> turns with timestamps', () => {
    const prompt = buildVerificationJudgePrompt(
      {
        current: [{ at: '2026-10-31T19:16:57.885Z', text: '做B' }],
        history: [
          {
            messages: [{ at: '2026-10-31T18:48:26.000Z', text: '设置固定在左下角' }],
            reply: { at: '2026-10-31T18:56:40.000Z', text: '已完成' },
          },
          {
            messages: [
              { at: '2026-10-31T19:11:27.647Z', text: '左1把项目放在所有会话上面' },
              { at: '2026-10-31T19:12:37.269Z', text: '恢复自动化功能', guidance: true },
            ],
            reply: { at: '2026-10-31T19:14:48.000Z', text: '已移到最前' },
          },
        ],
      },
      'done',
    )

    expect(prompt).toContain('PREVIOUS TURNS — REFERENCE ONLY')
    expect(prompt).toContain('<turn n="-2">')
    expect(prompt).toContain('<turn n="-1">')
    expect(prompt).toContain('<result>')
    expect(prompt).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} · 左1把项目放在所有会话上面/)
    expect(prompt).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} · 已移到最前/)
    // The reference turn's own guidance is kept inside its <user> block.
    expect(prompt).toMatch(/ · 恢复自动化功能\n<\/user>/)
    // Newest reference turn is rendered last.
    expect(prompt.indexOf('<turn n="-2">')).toBeLessThan(prompt.indexOf('<turn n="-1">'))
    // History sits between the current turn and the candidate.
    expect(prompt.indexOf('<history>')).toBeLessThan(prompt.indexOf('FINAL REPLY (assistant'))
  })

  it('omits the history block entirely when there is none', () => {
    const prompt = buildVerificationJudgePrompt({ current: [{ text: '第一轮' }] }, 'done')

    expect(prompt).not.toContain('<history>')
    expect(prompt).toContain('<user>\n第一轮\n</user>')
  })

  it('renders the candidate with its own timestamp', () => {
    const prompt = buildVerificationJudgePrompt(
      { current: [{ text: '本轮' }] },
      '候选回复正文',
      '2026-10-31T19:52:26.000Z',
    )

    expect(prompt).toMatch(/<reply>\n\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} · 候选回复正文\n<\/reply>/)
  })

  it('indents continuation lines so a multi-line message keeps one stamp', () => {
    const prompt = buildVerificationJudgePrompt(
      { current: [{ at: '2026-10-31T19:11:27.647Z', text: '一\n二' }] },
      'done',
    )

    expect(prompt).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} · 一\n  二/)
  })

  it('never drops a current-turn message, however chatty the turn is', () => {
    // A dropped mid-turn steer can be exactly the requirement the judge then
    // calls "missing" — so current-turn entries are never discarded.
    const current = Array.from({ length: 12 }, (_, i) => ({ text: `第${i + 1}条要求` }))
    const prompt = buildVerificationJudgePrompt({ current }, 'done')

    for (const entry of current) expect(prompt).toContain(entry.text)
    expect(prompt).not.toContain('(truncated)')
  })

  it('keeps a long single message that fits the per-entry cap (p99 = 3.7k chars)', () => {
    const text = 'x'.repeat(7_500)
    const prompt = buildVerificationJudgePrompt({ current: [{ text }] }, 'done')

    expect(prompt).toContain(text)
    expect(prompt).not.toContain('(truncated)')
  })

  it('truncates proportionally over the total budget and says truncation is not a retraction', () => {
    const current = [
      { text: 'y'.repeat(16_000) },
      { text: 'g'.repeat(9_000), guidance: true },
    ]
    const prompt = buildVerificationJudgePrompt({ current }, 'done')

    expect(prompt).toContain('(truncated)')
    // Both lines survive as requirements, even if abbreviated.
    expect(prompt).toContain('y'.repeat(100))
    expect(prompt).toContain('g'.repeat(100))
    expect(prompt).toContain('rendering limit of the judge, NOT the user withdrawing a requirement')
    expect(prompt).toContain('if you cannot tell whether a cut-off part was addressed, PASS')
  })

  it('marks abbreviated history as reference-only', () => {
    const prompt = buildVerificationJudgePrompt(
      {
        current: [{ text: '本轮' }],
        history: [{ messages: [{ text: 'h'.repeat(2_000) }], reply: { text: 'r'.repeat(2_000) } }],
      },
      'done',
    )

    expect(prompt).toContain('History above is abbreviated for length; it is reference only.')
  })

  it('never truncates the candidate reply', () => {
    const candidate = 'z'.repeat(20_000)
    const prompt = buildVerificationJudgePrompt({ current: [{ text: '本轮' }] }, candidate)

    expect(prompt).toContain(candidate)
  })

  it('keeps the instruction body compact (flash-grade judge)', () => {
    const body = buildVerificationJudgePrompt('x'.repeat(1000), 'y'.repeat(1000))
      .split('CURRENT TURN — WHAT THE USER ASKED NOW')[0]!
    expect(body.length).toBeLessThan(4000)
  })
})
