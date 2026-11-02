import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProgressRecord } from '../progress-journal.ts'
import {
  buildTurnLogs,
  copyTurnLogsForBranch,
  isRealUserMessage,
  renderTurnLog,
  turnLogFileName,
  writeTurnLogs,
} from '../turn-log.ts'
import type { TurnLogData, TurnSessionMessage } from '../turn-log.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

// ============================================================================
// Fixtures
// ============================================================================

function rec(partial: Partial<ProgressRecord> & { kind: ProgressRecord['kind'] }): ProgressRecord {
  return {
    version: 1,
    timestamp: '2026-10-16T06:00:00.000Z',
    ...partial,
  }
}

/** Minimal but realistic session.jsonl records. */
function sess(partial: Partial<TurnSessionMessage>): TurnSessionMessage {
  return { type: 'tool', timestamp: 1792140000000, ...partial }
}

/** The three fake-message shapes observed in the wild. */
const FAKE_MSG_VARIANTS = [
  'Continue the previous user request that was interrupted by an application restart or agent shutdown.\n\nOriginal user request:\n.\n\nImportant recovery instructions:…',
  '.',
  '. \n\n<system-reminder>The previous assistant response was interrupted by the user and may be incomplete.</system-reminder>',
]

// ============================================================================
// isRealUserMessage
// ============================================================================

describe('isRealUserMessage', () => {
  it('accepts a normal user message', () => {
    expect(isRealUserMessage('继续检查')).toBe(true)
  })

  it('accepts a message whose real intent survives after stripping the system reminder', () => {
    const msg = '3\n\n<system-reminder>The previous assistant response was interrupted by the user and may be incomplete. Do not repeat or continue the interrupted response unless asked. Focus on the new message above.</system-reminder>'
    expect(isRealUserMessage(msg)).toBe(true)
  })

  it('rejects the recovery injection', () => {
    expect(isRealUserMessage(FAKE_MSG_VARIANTS[0]!)).toBe(false)
  })

  it('rejects a lone dot', () => {
    expect(isRealUserMessage('.')).toBe(false)
  })

  it('rejects pure punctuation and whitespace', () => {
    expect(isRealUserMessage('...')).toBe(false)
    expect(isRealUserMessage('。')).toBe(false)
    expect(isRealUserMessage('   \n\t ')).toBe(false)
    expect(isRealUserMessage('？')).toBe(false)
  })

  it('rejects empty / null / undefined', () => {
    expect(isRealUserMessage('')).toBe(false)
    expect(isRealUserMessage(null)).toBe(false)
    expect(isRealUserMessage(undefined)).toBe(false)
  })

  it('rejects a system-reminder-only message', () => {
    const msg = '<system-reminder>The previous assistant response was interrupted by the user and may be incomplete.</system-reminder>'
    expect(isRealUserMessage(msg)).toBe(false)
  })
})

// ============================================================================
// buildTurnLogs
// ============================================================================

describe('buildTurnLogs', () => {
  it('splits progress records into real turns and folds system injections as interruptions', () => {
    const progress: ProgressRecord[] = [
      rec({ kind: 'user_request', timestamp: '2026-10-16T06:53:23.000Z', text: '第一轮真实请求' }),
      rec({ kind: 'tool_start', timestamp: '2026-10-16T06:54:00.000Z', callId: 'c1', toolName: 'Read', argsSummary: 'a.ts' }),
      rec({ kind: 'tool_result', timestamp: '2026-10-16T06:54:01.000Z', callId: 'c1', toolName: 'Read', resultSummary: 'file content' }),
      // System recovery injection — NOT a new turn.
      rec({ kind: 'user_request', timestamp: '2026-10-16T06:55:00.000Z', text: FAKE_MSG_VARIANTS[0] }),
      // Empty abort artifact — NOT a new turn.
      rec({ kind: 'user_request', timestamp: '2026-10-16T06:56:00.000Z', text: '.' }),
      // Real second turn.
      rec({ kind: 'user_request', timestamp: '2026-10-16T07:00:00.000Z', text: '第二轮' }),
      rec({ kind: 'conclusion', timestamp: '2026-10-16T07:01:00.000Z', text: 'done' }),
    ]

    const turns = buildTurnLogs(progress, [])
    expect(turns).toHaveLength(2)

    const t1 = turns[0]!
    expect(t1.turnIndex).toBe(1)
    expect(t1.userMessage).toBe('第一轮真实请求')
    expect(t1.interruptions).toHaveLength(2)
    expect(t1.interruptions[0]!.text).toContain('Continue the previous user request')
    expect(t1.interruptions[1]!.text).toBe('.')
    expect(t1.turnEndIso).toBe('2026-10-16T07:00:00.000Z')
    expect(t1.tools).toHaveLength(1)

    const t2 = turns[1]!
    expect(t2.turnIndex).toBe(2)
    expect(t2.userMessage).toBe('第二轮')
    expect(t2.turnEndIso).toBeNull() // open turn
    expect(t2.conclusions).toHaveLength(1)
  })

  it('enriches tool results with FULL text from session.jsonl when available', () => {
    const progress: ProgressRecord[] = [
      rec({ kind: 'user_request', text: 'x' }),
      rec({ kind: 'tool_start', timestamp: '2026-10-16T06:54:00.000Z', callId: 'c-full', toolName: 'Bash', argsSummary: 'ls' }),
      rec({ kind: 'tool_result', timestamp: '2026-10-16T06:54:10.000Z', callId: 'c-full', toolName: 'Bash', resultSummary: 'truncated…' }),
      // Result truncated in progress (1200 cap) but full in session.jsonl.
      rec({ kind: 'tool_start', timestamp: '2026-10-16T06:55:00.000Z', callId: 'c-sum', toolName: 'Bash', argsSummary: 'ls2' }),
      rec({ kind: 'tool_result', timestamp: '2026-10-16T06:55:05.000Z', callId: 'c-sum', toolName: 'Bash', resultSummary: 'summary-only' }),
      rec({ kind: 'user_request', text: 'y' }),
    ]
    const session: TurnSessionMessage[] = [
      sess({ type: 'tool', toolUseId: 'c-full', toolResult: 'FULL RESULT 10000 chars'.padEnd(10000, '!'), timestamp: Date.parse('2026-10-16T06:54:10.000Z') }),
    ]

    const turns = buildTurnLogs(progress, session)
    const tools = turns[0]!.tools
    expect(tools).toHaveLength(2)
    expect(tools[0]!.resultSource).toBe('full')
    expect(tools[0]!.resultText).toContain('FULL RESULT')
    expect(tools[0]!.resultText!.length).toBe(10000)
    expect(tools[0]!.durationMs).toBe(10_000)
    // Fallback: no session record → truncated summary.
    expect(tools[1]!.resultSource).toBe('summary')
    expect(tools[1]!.resultText).toBe('summary-only')
  })

  it('collects multiple assistant bubbles per turn and excludes intermediate drafts', () => {
    const progress: ProgressRecord[] = [
      rec({ kind: 'user_request', timestamp: '2026-10-16T06:53:23.000Z', text: 'x' }),
      rec({ kind: 'guidance', timestamp: '2026-10-16T06:55:00.000Z', text: '顺带看看 B' }),
      rec({ kind: 'user_request', timestamp: '2026-10-16T07:00:00.000Z', text: 'y' }),
    ]
    const session: TurnSessionMessage[] = [
      sess({ type: 'assistant', content: 'draft thinking', isIntermediate: true, timestamp: Date.parse('2026-10-16T06:54:00.000Z') }),
      sess({ type: 'assistant', content: '回复一：A 完成', isIntermediate: false, timestamp: Date.parse('2026-10-16T06:56:00.000Z') }),
      sess({ type: 'assistant', content: '回复二：B 也完成', isIntermediate: false, timestamp: Date.parse('2026-10-16T06:58:00.000Z') }),
      sess({ type: 'assistant', content: '下一轮的回复', isIntermediate: false, timestamp: Date.parse('2026-10-16T07:05:00.000Z') }),
    ]

    const turns = buildTurnLogs(progress, session)
    const t1 = turns[0]!
    expect(t1.assistantReplies).toHaveLength(2)
    expect(t1.assistantReplies[0]!.text).toBe('回复一：A 完成')
    expect(t1.assistantReplies[1]!.text).toBe('回复二：B 也完成')
    expect(t1.guidance).toHaveLength(1)
    // The next turn's reply lands in turn 2, not turn 1.
    expect(turns[1]!.assistantReplies).toHaveLength(1)
    expect(turns[1]!.assistantReplies[0]!.text).toBe('下一轮的回复')
  })

  it('handles a tool_result without a matching tool_start', () => {
    const progress: ProgressRecord[] = [
      rec({ kind: 'user_request', text: 'x' }),
      rec({ kind: 'tool_result', timestamp: '2026-10-16T06:54:10.000Z', callId: 'orphan', toolName: 'Read', resultSummary: 'orphan result' }),
    ]
    const turns = buildTurnLogs(progress, [])
    expect(turns[0]!.tools).toHaveLength(1)
    expect(turns[0]!.tools[0]!.startedIso).toBe('2026-10-16T06:54:10.000Z')
    expect(turns[0]!.tools[0]!.durationMs).toBeUndefined()
  })

  it('ignores a system injection that arrives before any real turn', () => {
    const progress: ProgressRecord[] = [
      rec({ kind: 'user_request', text: '.' }),
      rec({ kind: 'user_request', timestamp: '2026-10-16T07:00:00.000Z', text: '真正的第一条' }),
    ]
    const turns = buildTurnLogs(progress, [])
    expect(turns).toHaveLength(1)
    expect(turns[0]!.userMessage).toBe('真正的第一条')
    expect(turns[0]!.interruptions).toHaveLength(0)
  })
})

// ============================================================================
// renderTurnLog + file naming + writeTurnLogs
// ============================================================================

function sampleTurn(): TurnLogData {
  return {
    turnIndex: 5,
    turnStartIso: '2026-10-16T09:30:51.000Z',
    turnEndIso: null,
    userMessage: '继续检查',
    guidance: [{ iso: '2026-10-16T09:33:02.000Z', text: '看看日志' }],
    interruptions: [{ iso: '2026-10-16T09:31:10.000Z', text: 'Continue the previous user request…' }],
    tools: [{
      callId: 'c1', toolName: 'Bash', argsSummary: 'ls -la',
      startedIso: '2026-10-16T09:31:20.000Z', endedIso: '2026-10-16T09:31:29.000Z',
      durationMs: 9000, resultText: 'total 42\n…', resultSource: 'full',
    }, {
      callId: 'c2', toolName: 'Bash', argsSummary: 'tail -5',
      startedIso: '2026-10-16T09:32:00.000Z', endedIso: '2026-10-16T09:32:03.000Z',
      durationMs: 3000, resultText: 'truncated…', resultSource: 'summary',
    }],
    assistantReplies: [{ iso: '2026-10-16T09:35:22.000Z', text: '完成。' }],
    conclusions: [{ iso: '2026-10-16T09:35:24.000Z', text: 'checked' }],
  }
}

describe('renderTurnLog', () => {
  it('renders all sections in order', () => {
    const md = renderTurnLog(sampleTurn())
    const order = ['# Turn 5', '## User message', '## Mid-turn guidance', '## Interruptions', '## Process blocks', '## Assistant replies', '## Conclusion']
    let last = -1
    for (const head of order) {
      const idx = md.indexOf(head)
      expect(idx).toBeGreaterThan(-1)
      expect(idx).toBeGreaterThan(last)
      last = idx
    }
    expect(md).toContain('9.0s')
    expect(md).toContain('3.0s')
    expect(md).toContain('result source: truncated summary')
    expect(md).toContain('## Assistant replies')
  })

  it('escapes triple backticks inside results so the code fence stays intact', () => {
    const turn = sampleTurn()
    turn.tools[0]!.resultText = 'a ``` b'
    const md = renderTurnLog(turn)
    expect(md).toContain('``\u200b`')
  })
})

describe('turnLogFileName', () => {
  it('is Windows-safe and index-padded', () => {
    expect(turnLogFileName(sampleTurn())).toBe('2026-10-16T09-30-51-005.md')
  })
})

describe('writeTurnLogs', () => {
  it('writes each turn once and never overwrites existing files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-turnlog-'))
    dirs.push(dir)
    const turns = [sampleTurn(), { ...sampleTurn(), turnIndex: 6, turnStartIso: '2026-10-16T10:00:00.000Z' }]

    const first = writeTurnLogs(dir, turns)
    expect(first).toBe(2)
    const files = readdirSync(join(dir, 'turns')).sort()
    expect(files).toEqual(['2026-10-16T09-30-51-005.md', '2026-10-16T10-00-00-006.md'])

    const content = readFileSync(join(dir, 'turns', files[0]!), 'utf8')
    expect(content).toContain('继续检查')

    // Re-run: nothing new written, files untouched.
    const second = writeTurnLogs(dir, turns)
    expect(second).toBe(0)
    expect(readFileSync(join(dir, 'turns', files[0]!), 'utf8')).toBe(content)
  })

  it('writes nothing for an empty turn list and still succeeds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-turnlog-'))
    dirs.push(dir)
    expect(writeTurnLogs(dir, [])).toBe(0)
    expect(existsSync(join(dir, 'turns'))).toBe(false)
  })
})

/**
 * A forked branch copies messages but not `turns/`. context-relief builds its
 * zero-LLM checkpoint from turn files, so without them /compact falls back to
 * an LLM summary of the whole copied history (2026-10-18: 5.6MB / 2060 msgs
 * → 65s). The fork must carry the parent's turns up to the branch point.
 */
describe('copyTurnLogsForBranch', () => {
  function seedTurns(): string {
    const src = mkdtempSync(join(tmpdir(), 'craft-branch-src-'))
    dirs.push(src)
    mkdirSync(join(src, 'turns'), { recursive: true })
    writeFileSync(join(src, 'turns', '2026-10-18T09-00-00-001.md'), 'first')
    writeFileSync(join(src, 'turns', '2026-10-18T10-00-00-002.md'), 'second')
    writeFileSync(join(src, 'turns', '2026-10-18T11-00-00-003.md'), 'third')
    return src
  }

  it('copies turns at-or-before the branch point, skips later ones', () => {
    const src = seedTurns()
    const dest = mkdtempSync(join(tmpdir(), 'craft-branch-dst-'))
    dirs.push(dest)
    // Branch point 10:30Z → keeps 09:00 and 10:00, drops 11:00.
    const copied = copyTurnLogsForBranch(src, dest, Date.UTC(2026, 9, 18, 10, 30, 0))
    expect(copied).toBe(2)
    expect(readdirSync(join(dest, 'turns')).sort()).toEqual([
      '2026-10-18T09-00-00-001.md',
      '2026-10-18T10-00-00-002.md',
    ])
    expect(readFileSync(join(dest, 'turns', '2026-10-18T09-00-00-001.md'), 'utf8')).toBe('first')
  })

  it('copies everything when the branch point is unknown', () => {
    const src = seedTurns()
    const dest = mkdtempSync(join(tmpdir(), 'craft-branch-dst-'))
    dirs.push(dest)
    expect(copyTurnLogsForBranch(src, dest, undefined)).toBe(3)
  })

  it('is idempotent and never overwrites an existing branch file', () => {
    const src = seedTurns()
    const dest = mkdtempSync(join(tmpdir(), 'craft-branch-dst-'))
    dirs.push(dest)
    expect(copyTurnLogsForBranch(src, dest, Date.UTC(2026, 9, 18, 12, 0, 0))).toBe(3)
    expect(copyTurnLogsForBranch(src, dest, Date.UTC(2026, 9, 18, 12, 0, 0))).toBe(0)
  })

  it('returns 0 when the source has no turns directory', () => {
    const src = mkdtempSync(join(tmpdir(), 'craft-branch-src-'))
    const dest = mkdtempSync(join(tmpdir(), 'craft-branch-dst-'))
    dirs.push(src, dest)
    expect(copyTurnLogsForBranch(src, dest, Date.now())).toBe(0)
  })
})

// ============================================================================
// Closing a finished turn (turn-end archiving)
// ============================================================================

describe('buildTurnLogs — closing a finished turn', () => {
  const start = '2026-10-16T06:00:00.000Z'

  it('stamps the last turn end when the caller archives a finished turn', () => {
    const progress: ProgressRecord[] = [
      rec({ kind: 'user_request', text: 'hi', timestamp: start }),
      rec({ kind: 'conclusion', text: 'done', timestamp: '2026-10-16T06:00:10.000Z' }),
    ]
    const messages: TurnSessionMessage[] = [
      sess({
        type: 'assistant',
        content: 'answer',
        isIntermediate: false,
        timestamp: Date.parse('2026-10-16T06:00:10.000Z'),
      }),
    ]

    const turns = buildTurnLogs(progress, messages, { closeOpenTurnAt: '2026-10-16T06:00:12.000Z' })

    expect(turns).toHaveLength(1)
    expect(turns[0]!.turnEndIso).toBe('2026-10-16T06:00:12.000Z')
    // The end is stamped AFTER attribution, so the reply that finished the turn
    // must still belong to it.
    expect(turns[0]!.assistantReplies).toHaveLength(1)
  })

  it('leaves the open turn open when no close timestamp is given', () => {
    const progress: ProgressRecord[] = [rec({ kind: 'user_request', text: 'hi', timestamp: start })]
    const turns = buildTurnLogs(progress, [])
    expect(turns).toHaveLength(1)
    expect(turns[0]!.turnEndIso).toBeNull()
  })
})
