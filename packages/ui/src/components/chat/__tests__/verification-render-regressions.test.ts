/**
 * 2026-10-19 tidy-willow — four regressions in how a verification cycle
 * renders, all reproduced from the REAL transcript of session
 * 261016-true-sparrow (indices 2804-2812: four consecutive `verification_failed`
 * rows each followed by a byte-identical 1734-char resume).
 *
 * 1. 校验失败（<类型>） label  — the row must carry statusParams.failType so
 *    turn-utils can localize it through chat.verificationFailType.*.
 * 2. clickable reasonPath      — the row must carry statusParams.reasonPath so
 *    the persisted attempt-NNN-<type>.txt opens like any other txt.
 * 3. 重复回答                  — byte-identical follow-up resumes collapse into
 *    ONE process step.
 * 4. verdict survives a resume — the verdict row stays attached to the turn the
 *    failed cycle belonged to instead of being swallowed when the next resume
 *    re-opens a turn.
 */
import { describe, it, expect } from 'bun:test'
import { groupMessagesByTurn, type AssistantTurn } from '../turn-utils'
import type { Message } from '@craft-agent/core'

let seq = 0
function msg(partial: Partial<Message> & { role: Message['role'] }): Message {
  seq += 1
  return {
    id: `m-${seq}`,
    content: '',
    timestamp: 1792345400000 + seq * 1000,
    ...partial,
  } as Message
}

/** The 1734-char resume body the model re-emitted four times in a row. */
function resumeBody(): string {
  return '已提交 `64cd4533`。这三个问题全是 UI 层的。\n\n---\n\n## 根因\n\nstatusParams 丢了。\n'.repeat(12)
}

function verificationSteps(turn: AssistantTurn) {
  return turn.activities.filter(a => a.type === 'status' && a.statusType === 'verification')
}

describe('verification rendering regressions (2026-10-19 tidy-willow)', () => {
  it('1. carries failType on the failed row so the typed label renders', () => {
    const turns = groupMessagesByTurn([
      msg({ role: 'user', content: '重建' }),
      msg({ role: 'status', content: 'Verifying final reply…', statusType: 'verification' }),
      msg({
        role: 'info',
        content: 'Verification failed — continuing',
        statusType: 'verification_failed',
        statusParams: { failType: 'incomplete', attempt: 1 },
      }),
    ])
    const step = verificationSteps(turns[1] as AssistantTurn)[0]
    expect(step).toBeDefined()
    expect(step!.statusParams?.failType).toBe('incomplete')
    expect(step!.status).toBe('error')
  })

  it('2. carries reasonPath on the failed row so the reason file is openable', () => {
    const reasonPath = 'C:\sessions\261016-true-sparrow\verification\attempt-001-incomplete.txt'
    const turns = groupMessagesByTurn([
      msg({ role: 'user', content: '重建' }),
      msg({ role: 'status', content: 'Verifying final reply…', statusType: 'verification' }),
      msg({
        role: 'info',
        content: 'Verification failed — continuing',
        statusType: 'verification_failed',
        statusParams: { failType: 'incomplete', reasonPath, attempt: 1 },
      }),
    ])
    const step = verificationSteps(turns[1] as AssistantTurn)[0]
    expect(step!.statusParams?.reasonPath).toBe(reasonPath)
  })

  it('2b. keeps params when the live status row was folded into the info', () => {
    // Reload path: the transient status row is gone, so the info row RECREATES
    // the verdict card — it must not lose the params on that path either.
    const turns = groupMessagesByTurn([
      msg({ role: 'user', content: '重建' }),
      msg({
        role: 'info',
        content: 'Verification failed — continuing',
        statusType: 'verification_failed',
        statusParams: { failType: 'off-topic', reasonPath: 'C:/s/verification/attempt-002-off-topic.txt' },
      }),
    ])
    const step = verificationSteps(turns[1] as AssistantTurn)[0]
    expect(step!.statusParams?.failType).toBe('off-topic')
    expect(step!.statusParams?.reasonPath).toBe('C:/s/verification/attempt-002-off-topic.txt')
  })

  it('3. collapses byte-identical follow-up resumes into one step', () => {
    const body = resumeBody()
    const turns = groupMessagesByTurn([
      msg({ role: 'user', content: '重建' }),
      msg({ role: 'status', content: 'Verifying final reply…', statusType: 'verification' }),
      msg({ role: 'info', content: 'Verification failed — continuing', statusType: 'verification_failed', statusParams: { failType: 'incomplete' } }),
      msg({ role: 'assistant', content: body, isIntermediate: true, turnId: 'pi-turn-2__m66' }),
      msg({ role: 'info', content: 'Verification failed — continuing', statusType: 'verification_failed', statusParams: { failType: 'incomplete' } }),
      msg({ role: 'assistant', content: body, isIntermediate: true, turnId: 'pi-turn-2__m67' }),
      msg({ role: 'info', content: 'Verification failed — continuing', statusType: 'verification_failed', statusParams: { failType: 'incomplete' } }),
      msg({ role: 'assistant', content: body, isIntermediate: true, turnId: 'pi-turn-2__m68' }),
      msg({ role: 'info', content: 'Verification failed — continuing', statusType: 'verification_failed', statusParams: { failType: 'incomplete' } }),
      msg({ role: 'assistant', content: body, isIntermediate: true, turnId: 'pi-turn-2__m69' }),
    ])
    const allTurns = turns.filter(t => t.type === 'assistant') as AssistantTurn[]
    const steps = allTurns.flatMap(t =>
      t.activities.filter(a => a.type === 'intermediate' && a.content === body)
    )
    expect(steps).toHaveLength(1)
  })

  it('3b. keeps genuinely different intermediate steps as separate rows', () => {
    const turns = groupMessagesByTurn([
      msg({ role: 'user', content: '重建' }),
      msg({ role: 'assistant', content: '第一步：编译', isIntermediate: true }),
      msg({ role: 'assistant', content: '第二步：打包', isIntermediate: true }),
      msg({ role: 'assistant', content: '第三步：安装', isIntermediate: true }),
      msg({ role: 'assistant', content: '全部完成', isIntermediate: false }),
    ])
    const steps = (turns[1] as AssistantTurn).activities.filter(a => a.type === 'intermediate')
    expect(steps).toHaveLength(3)
    expect((turns[1] as AssistantTurn).response?.text).toBe('全部完成')
  })

  it('4. keeps the verdict rows in the turn they belong to across resumes', () => {
    // The real transcript alternates failed-row → resume → failed-row …
    // every verdict must survive and be visible in the assembled turn.
    const turns = groupMessagesByTurn([
      msg({ role: 'user', content: '重建' }),
      msg({ role: 'status', content: 'Verifying final reply…', statusType: 'verification' }),
      msg({
        role: 'info',
        content: 'Verification failed — continuing',
        statusType: 'verification_failed',
        statusParams: { failType: 'incomplete', attempt: 1 },
      }),
      msg({ role: 'assistant', content: '补充：第一步已完成', isIntermediate: true, turnId: 'pi-turn-2__m66' }),
      msg({
        role: 'info',
        content: 'Verification failed — continuing',
        statusType: 'verification_failed',
        statusParams: { failType: 'incomplete', attempt: 2 },
      }),
      msg({ role: 'assistant', content: '全部完成，已重建', isIntermediate: false, turnId: 'pi-turn-2__m70' }),
    ])
    const assistantTurn = turns[turns.length - 1] as AssistantTurn
    const steps = verificationSteps(assistantTurn)
    expect(steps.length).toBeGreaterThanOrEqual(1)
    for (const step of steps) {
      expect(step.statusParams?.failType).toBe('incomplete')
    }
    expect(assistantTurn.response?.text).toBe('全部完成，已重建')
  })

  it('5. renders ONE row per verification round instead of overwriting', () => {
    // The reported regression: a 5-round FAIL cycle rendered a single stale
    // line because every verdict matched the FIRST pending verification row.
    // Each round must keep its own row (attempt 1..N) so the user really sees
    // 回答 / 校验失败 / 回答 / 校验失败 …
    const rows: Message[] = [msg({ role: 'user', content: '重建' })]
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      // Each round opens its own live status row (the subprocess emits one
      // "Verifying final reply…" per cycle) — this is what made the legacy
      // first-match-always-wins behaviour overwrite round 1 repeatedly.
      rows.push(msg({
        role: 'status',
        content: 'Verifying final reply…',
        statusType: 'verification',
        turnId: `pi-turn-2__m${65 + attempt}`,
      }))
      rows.push(msg({
        role: 'info',
        content: 'Verification failed — continuing',
        statusType: 'verification_failed',
        statusParams: {
          failType: 'incomplete',
          reasonPath: `C:/s/verification/attempt-00${attempt}-incomplete.txt`,
          attempt,
        },
      }))
      rows.push(msg({
        role: 'assistant',
        content: `第 ${attempt} 次尝试仍未完成`,
        isIntermediate: true,
        turnId: `pi-turn-2__m${66 + attempt}`,
      }))
    }
    const turns = groupMessagesByTurn(rows)
    const assistantTurn = turns[turns.length - 1] as AssistantTurn
    const steps = verificationSteps(assistantTurn)
    expect(steps).toHaveLength(5)
    expect(steps.map(s => s.statusParams?.attempt)).toEqual([1, 2, 3, 4, 5])
    for (const step of steps) {
      expect(step.statusParams?.failType).toBe('incomplete')
      expect(String(step.statusParams?.reasonPath)).toContain('verification/attempt-')
      expect(step.status).toBe('error')
    }
  })

  it('6. keeps one row per failed round even when every round reports attempt=1', () => {
    // 261018-noble-shoal (2026-10-20) real regression: the subprocess reset
    // its attempt counter on every follow-up resume, so ALL rounds carried
    // attempt=1 (ten failures across six cycles in the transcript, every one
    // of them attempt 1). Attempt-based matching collapsed rounds 2..N into
    // round 1 — the exact "第二个校验失败没有出现" report.
    const rows: Message[] = [msg({ role: 'user', content: '修 API 地址' })]
    for (let i = 1; i <= 3; i += 1) {
      rows.push(msg({
        role: 'info',
        content: 'Verification failed — continuing',
        statusType: 'verification_failed',
        statusParams: {
          failType: i === 1 ? 'off-topic' : 'incomplete',
          reasonPath: 'C:/s/verification/attempt-001-off-topic.txt',
          attempt: 1,
        },
      }))
      rows.push(msg({
        role: 'assistant',
        content: `第 ${i} 次补充`,
        isIntermediate: true,
        turnId: `pi-turn-1__m${10 + i}`,
      }))
    }
    const turns = groupMessagesByTurn(rows)
    const assistantTurn = turns[turns.length - 1] as AssistantTurn
    const steps = verificationSteps(assistantTurn)
    expect(steps).toHaveLength(3)
    expect(steps.every(s => s.status === 'error')).toBe(true)
    expect(steps[0].statusParams?.failType).toBe('off-topic')
    expect(steps[1].statusParams?.failType).toBe('incomplete')
  })

  it('7. appends the stabilized pass instead of overwriting the failed row', () => {
    // 261018-noble-shoal (2026-10-20) real regression: the stop-loss pass
    // ("内容已稳定，重试无法改变结果—按现状交付") carries
    // statusParams={stabilized:1} and NO attempt. The no-attempt fallback
    // used to match the FIRST verification row, so the failed row became a
    // pass line the moment the final bubble landed.
    const turns = groupMessagesByTurn([
      msg({ role: 'user', content: '修 API 地址' }),
      msg({
        role: 'info',
        content: 'Verification failed — continuing',
        statusType: 'verification_failed',
        statusParams: {
          failType: 'off-topic',
          reasonPath: 'C:/s/verification/attempt-001-off-topic.txt',
          attempt: 1,
        },
      }),
      msg({ role: 'assistant', content: '补充', isIntermediate: true, turnId: 'pi-turn-1__m11' }),
      msg({
        role: 'info',
        content: 'Verification passed — delivering final reply',
        statusType: 'verification_passed',
        statusParams: { stabilized: 1 },
      }),
      msg({ role: 'assistant', content: '最终交付', isIntermediate: false, turnId: 'pi-turn-1__m12' }),
    ])
    const assistantTurn = turns[turns.length - 1] as AssistantTurn
    const steps = verificationSteps(assistantTurn)
    expect(steps).toHaveLength(2)
    expect(steps[0].status).toBe('error')
    expect(steps[0].statusParams?.failType).toBe('off-topic')
    expect(steps[1].status).toBe('completed')
    expect(steps[1].statusParams?.stabilized).toBe(1)
    expect(assistantTurn.response?.text).toBe('最终交付')
  })

  it('8. still settles the open live row when a verdict matches it', () => {
    // Live-path guard for the new rule: the pending "Verifying final reply…"
    // row (status running) must absorb its verdict in place instead of
    // duplicating, even though the live status row carries no attempt.
    const turns = groupMessagesByTurn([
      msg({ role: 'user', content: '重建' }),
      msg({ role: 'status', content: 'Verifying final reply…', statusType: 'verification' }),
      msg({
        role: 'info',
        content: 'Verification failed — continuing',
        statusType: 'verification_failed',
        statusParams: {
          failType: 'incomplete',
          reasonPath: 'C:/s/verification/attempt-001-incomplete.txt',
          attempt: 1,
        },
      }),
    ])
    const assistantTurn = turns[1] as AssistantTurn
    const steps = verificationSteps(assistantTurn)
    expect(steps).toHaveLength(1)
    expect(steps[0].status).toBe('error')
    expect(steps[0].statusParams?.failType).toBe('incomplete')
  })
})
