import { describe, expect, it } from 'bun:test'
import { parseJudgeVerdict } from './judge-verdict.ts'

describe('parseJudgeVerdict', () => {
  it('parses a bare PASS', () => {
    expect(parseJudgeVerdict('PASS')).toEqual({ pass: true })
  })

  it('parses PASS with padding / prose prefix', () => {
    expect(parseJudgeVerdict('  PASS  ')).toEqual({ pass: true })
    expect(parseJudgeVerdict('The verdict is: PASS')).toEqual({ pass: true })
    expect(parseJudgeVerdict('pass')).toEqual({ pass: true })
  })

  it('parses FAIL|<type>|<reason>', () => {
    expect(parseJudgeVerdict('FAIL|incomplete|只完成了步骤1，步骤2-5未执行')).toEqual({
      pass: false,
      type: 'incomplete',
      reason: '只完成了步骤1，步骤2-5未执行',
    })
  })

  it('keeps pipes inside the reason', () => {
    expect(parseJudgeVerdict('FAIL|off-topic|回答的是构建流程，与问题无关 | 请重试')).toEqual({
      pass: false,
      type: 'off-topic',
      reason: '回答的是构建流程，与问题无关 | 请重试',
    })
  })

  it('tolerates a preamble line before the verdict', () => {
    const raw = 'Let me consider.\nFAIL|truncated|回复在句子中间中断'
    expect(parseJudgeVerdict(raw)).toEqual({
      pass: false,
      type: 'truncated',
      reason: '回复在句子中间中断',
    })
  })

  it('FAIL with no structure degrades to other with the raw text as reason', () => {
    expect(parseJudgeVerdict('FAIL')).toEqual({ pass: false, type: 'other', reason: '' })
    expect(parseJudgeVerdict('FAIL judged not acceptable')).toEqual({
      pass: false,
      type: 'other',
      reason: 'judged not acceptable',
    })
  })

  it('unknown type slug degrades to other but keeps the reason', () => {
    expect(parseJudgeVerdict('FAIL|weird_type|原因在这')).toEqual({
      pass: false,
      type: 'other',
      reason: '原因在这',
    })
    // No reason: the raw type text is preserved instead of being dropped.
    expect(parseJudgeVerdict('FAIL|weird_type')).toEqual({
      pass: false,
      type: 'other',
      reason: 'weird_type',
    })
  })

  it('empty / null input is a FAIL with empty reason (caller decides the label)', () => {
    expect(parseJudgeVerdict('')).toEqual({ pass: false, type: 'other', reason: '' })
    expect(parseJudgeVerdict(null)).toEqual({ pass: false, type: 'other', reason: '' })
    expect(parseJudgeVerdict(undefined)).toEqual({ pass: false, type: 'other', reason: '' })
  })

  it('every known type round-trips', () => {
    for (const type of ['incomplete', 'off-topic', 'truncated', 'other']) {
      const v = parseJudgeVerdict(`FAIL|${type}|r`)
      expect(v.pass).toBe(false)
      if (!v.pass) expect(v.type).toBe(type)
    }
  })
})
