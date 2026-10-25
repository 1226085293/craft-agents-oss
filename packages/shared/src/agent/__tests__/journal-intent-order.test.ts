/**
 * 2026-10-20 tidy-willow — two verification defects found on the real session
 * 261018-noble-shoal (2026-10-20):
 *
 * 1. The verification judge read the WRONG user message: `progress.jsonl` is
 *    rewritten by trimToLimits() with the protected latest request MOVED TO
 *    THE TOP, so physical line order is no longer chronological. Reading
 *    "last line" returned 13:09's question while the user's actual message
 *    was 13:30's — the judge then called a correct answer "答非所问"
 *    round after round.
 * 2. A FAIL→resume round never received the judge's reason, so the model
 *    could only re-emit/reword the same answer and FAIL again.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadLatestUserRequest } from '../progress-journal.ts'

function writeJournal(dir: string, lines: unknown[]): void {
  writeFileSync(join(dir, 'progress.jsonl'), lines.map(l => `${JSON.stringify(l)}\n`).join(''), 'utf8')
}

describe('loadLatestUserRequest ordering (2026-10-20 tidy-willow)', () => {
  it('picks the LATEST request by timestamp, not by physical line order', () => {
    // The exact shape of 261018-noble-shoal: trimToLimits() hoisted the newest
    // request to line 0 while older requests trail below it.
    const dir = mkdtempSync(join(tmpdir(), 'journal-order-'))
    try {
      writeJournal(dir, [
        { version: 1, timestamp: '2026-10-20T13:30:57.037Z', kind: 'user_request', text: '为什么我添加的提供商在你重启dev实例后消失了？' },
        { version: 1, timestamp: '2026-10-20T07:54:07.148Z', kind: 'user_request', text: '就是你漏了！原型设计就有探测模型！' },
        { version: 1, timestamp: '2026-10-20T13:09:01.386Z', kind: 'user_request', text: '为什么提供商预设类型卡片里面的必选参数为空？' },
      ])
      const latest = loadLatestUserRequest(dir)
      expect(latest).toBe('为什么我添加的提供商在你重启dev实例后消失了？')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps chronological behavior for a normal append-only ledger', () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-order-'))
    try {
      writeJournal(dir, [
        { version: 1, timestamp: '2026-10-20T09:00:00.000Z', kind: 'user_request', text: 'first question' },
        { version: 1, timestamp: '2026-10-20T09:05:00.000Z', kind: 'user_request', text: 'second question' },
      ])
      expect(loadLatestUserRequest(dir)).toBe('second question')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accumulates only the guidance that belongs to the latest request', () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-order-'))
    try {
      writeJournal(dir, [
        { version: 1, timestamp: '2026-10-20T09:00:00.000Z', kind: 'user_request', text: 'older request' },
        { version: 1, timestamp: '2026-10-20T09:01:00.000Z', kind: 'guidance', text: 'stale steer from the older turn' },
        { version: 1, timestamp: '2026-10-20T09:10:00.000Z', kind: 'user_request', text: 'current request' },
        { version: 1, timestamp: '2026-10-20T09:11:00.000Z', kind: 'guidance', text: 'steer that belongs to the current turn' },
      ])
      const latest = loadLatestUserRequest(dir)
      expect(latest).toContain('current request')
      expect(latest).toContain('steer that belongs to the current turn')
      expect(latest).not.toContain('stale steer from the older turn')
      expect(latest).not.toContain('older request')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
