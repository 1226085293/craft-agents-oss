/**
 * Strategy attribution for log rows.
 *
 * A usage record now carries the group that actually served it, so the log
 * reads that field instead of inferring a group from provider+model. The
 * inference could not tell two groups apart when they shared a pair, and it
 * attributed connection probes — which are never routed — to whichever group
 * happened to cover their model.
 */

import { describe, test, expect } from 'bun:test'
import { buildLogs } from '../viewmodel'

const detail = (recent: Array<Record<string, unknown>>) => ({ recent }) as never

const row = (over: Record<string, unknown> = {}) => ({
  ts: 1,
  keyId: 'k',
  model: 'gpt-5',
  status: 'success',
  statusCode: 200,
  promptTokens: 1,
  completionTokens: 1,
  firstByteMs: 1,
  totalMs: 1,
  sessionId: 's',
  ...over,
})

describe('buildLogs strategy attribution', () => {
  test('stamps each row with the group that served it', () => {
    const rows = buildLogs([{ provider: 'p1', detail: detail([row({ strategy: 'fast' })]) }], (_p, id) => id)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.strategy).toBe('fast')
  })

  test('two groups over the same provider+model are still told apart', () => {
    // The old inference returned the first match for both rows.
    const rows = buildLogs([
      {
        provider: 'p1',
        detail: detail([row({ ts: 2, strategy: 'b' }), row({ ts: 1, strategy: 'a' })]),
      },
    ])
    expect(rows.map((r) => r.strategy).sort()).toEqual(['a', 'b'])
  })

  test('a connection probe is unattributed, not credited to a group', () => {
    // Probes carry an empty strategy because they never touch a group.
    const rows = buildLogs([
      { provider: 'p1', detail: detail([row({ strategy: '', kind: 'connection_test' })]) },
    ])
    expect(rows[0]!.strategy).toBe('—')
  })

  test('a row with no strategy field at all renders "—" instead of throwing', () => {
    const rows = buildLogs([{ provider: 'p1', detail: detail([row()]) }])
    expect(rows[0]!.strategy).toBe('—')
  })
})
