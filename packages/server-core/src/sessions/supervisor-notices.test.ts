import { describe, expect, it } from 'bun:test'
import { SupervisorNoticeQueue } from './supervisor-notices.ts'

/**
 * Two notices about one task are one message.
 *
 * The complaint these exist for: a task's retry budget is three attempts, and the supervisor
 * received a separate 「连续失败」 message for each — arriving while it was still busy, each one
 * interrupting the turn it was in. The result was a supervisor that answered the same fact three
 * times and never finished the first answer.
 */
describe('notices held for a busy supervisor', () => {
  it('keeps one entry per subject and sends the newest wording', () => {
    const queue = new SupervisorNoticeQueue()

    queue.hold('sup', 'T-1:failures', 'T-1 第一次交接未通过')
    queue.hold('sup', 'T-1:failures', 'T-1 第二次交接未通过')

    expect(queue.size('sup')).toBe(1)
    // The latest text wins: it carries the newer attempt count, which is what the reader acts on.
    expect(queue.take('sup')).toBe('T-1 第二次交接未通过')
  })

  it('keeps different subjects apart', () => {
    const queue = new SupervisorNoticeQueue()

    queue.hold('sup', 'T-1:failures', 'T-1 失败')
    queue.hold('sup', 'T-1:decision', 'T-1 等待拍板')
    queue.hold('sup', 'T-2:failures', 'T-2 失败')

    expect(queue.subjects('sup')).toEqual(['T-1:failures', 'T-1:decision', 'T-2:failures'])
  })

  it('hands everything over as one message', () => {
    const queue = new SupervisorNoticeQueue()
    queue.hold('sup', 'T-1:failures', 'T-1 失败')
    queue.hold('sup', 'T-2:idle', 'T-2 空闲')

    const batch = queue.take('sup')

    expect(batch).toContain('T-1 失败')
    expect(batch).toContain('T-2 空闲')
    // One message, so reading the batch costs one turn rather than one per notice.
    expect(queue.size('sup')).toBe(0)
  })

  it('has nothing to hand over when the session was free', () => {
    // A free supervisor gets the notice immediately; the queue must not also keep a copy, or the
    // same fact would arrive twice — once now, once when the turn it triggers ends.
    expect(new SupervisorNoticeQueue().take('sup')).toBeUndefined()
  })
})
