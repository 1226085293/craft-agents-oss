import { afterEach, describe, expect, it } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildTurnsFromMessages,
  DEFAULT_JUDGE_HISTORY_TURNS,
  loadJudgeTurnContext,
  type TranscriptMessage,
} from './turn-intent.ts'

const dirs: string[] = []
function makeSessionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'turn-intent-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function writeTranscript(dir: string, messages: TranscriptMessage[]): string {
  const path = join(dir, 'session.jsonl')
  writeFileSync(path, messages.map((m) => `${JSON.stringify(m)}\n`).join(''), 'utf8')
  return path
}

const user = (content: string, extra: Partial<TranscriptMessage> = {}): TranscriptMessage => ({
  type: 'user',
  content,
  timestamp: 1,
  ...extra,
})
const assistant = (content: string, extra: Partial<TranscriptMessage> = {}): TranscriptMessage => ({
  type: 'assistant',
  content,
  timestamp: 2,
  ...extra,
})

describe('buildTurnsFromMessages', () => {
  it('splits turns at real user messages and merges guidance into its turn', () => {
    const turns = buildTurnsFromMessages([
      user('第一轮请求', { timestamp: Date.parse('2026-10-31T19:11:27.647Z') }),
      assistant('第一轮回复'),
      user('恢复自动化功能', { isGuidance: true, timestamp: Date.parse('2026-10-31T19:12:37.269Z') }),
      assistant('第一轮终稿'),
      user('第二轮请求'),
      assistant('第二轮回复'),
    ])

    expect(turns).toHaveLength(2)
    // The current-turn user list = opening request + guidance, in order.
    expect(turns[0]!.messages).toEqual([
      { at: '2026-10-31T19:11:27.647Z', text: '第一轮请求' },
      { at: '2026-10-31T19:12:37.269Z', text: '恢复自动化功能', guidance: true },
    ])
    expect(turns[0]!.replies.map((r) => r.text)).toEqual(['第一轮回复', '第一轮终稿'])
    expect(turns[1]!.messages.map((m) => m.text)).toEqual(['第二轮请求'])
    expect(turns[1]!.replies.map((r) => r.text)).toEqual(['第二轮回复'])
  })

  it('ignores intermediate assistant bubbles and system injections', () => {
    const turns = buildTurnsFromMessages([
      user('Continue the previous user request that was interrupted by a restart'),
      user('.'),
      user('真实请求'),
      assistant('中间思考', { isIntermediate: true }),
      assistant('最终回复'),
    ])

    expect(turns).toHaveLength(1)
    expect(turns[0]!.messages.map((m) => m.text)).toEqual(['真实请求'])
    expect(turns[0]!.replies.map((r) => r.text)).toEqual(['最终回复'])
  })
})

describe('loadJudgeTurnContext', () => {
  it('returns the CURRENT turn plus the previous three turns (newest last)', () => {
    const dir = makeSessionDir()
    writeTranscript(dir, [
      user('第1轮'), assistant('回复1'),
      user('第2轮'), assistant('回复2'),
      user('第3轮'), assistant('回复3'),
      user('第4轮'), assistant('回复4'),
      user('第5轮——本轮'),
    ])

    const ctx = loadJudgeTurnContext({ sessionDir: dir, fallbackUserMessage: '第5轮——本轮' })

    expect(ctx.current.map((m) => m.text)).toEqual(['第5轮——本轮'])
    expect(ctx.history).toHaveLength(DEFAULT_JUDGE_HISTORY_TURNS)
    expect(ctx.history!.map((t) => t.messages[0]!.text)).toEqual(['第2轮', '第3轮', '第4轮'])
    expect(ctx.history!.map((t) => t.reply?.text)).toEqual(['回复2', '回复3', '回复4'])
  })

  it('keeps this turn guidance in the current list (quiet-jasmine shape)', () => {
    const dir = makeSessionDir()
    writeTranscript(dir, [
      user('上一轮请求'), assistant('上一轮回复'),
      user('做B，但是我记得还有会话路径改变事件触发器', { timestamp: Date.parse('2026-10-31T19:16:57.885Z') }),
      user('补充：别忘了触发器', { isGuidance: true, timestamp: Date.parse('2026-10-31T19:18:00.000Z') }),
    ])

    const ctx = loadJudgeTurnContext({
      sessionDir: dir,
      fallbackUserMessage: '做B，但是我记得还有会话路径改变事件触发器',
    })

    expect(ctx.current.map((m) => m.text)).toEqual([
      '做B，但是我记得还有会话路径改变事件触发器',
      '补充：别忘了触发器',
    ])
    expect(ctx.current[1]!.guidance).toBe(true)
    expect(ctx.history!.map((t) => t.messages[0]!.text)).toEqual(['上一轮请求'])
  })

  it('never promotes a previous turn to the current turn when the transcript lags', () => {
    // The main process persists asynchronously: the newest turn on disk can
    // still be the PREVIOUS one. The prompt we received is authoritative.
    const dir = makeSessionDir()
    writeTranscript(dir, [
      user('上一轮的请求：把项目放在所有会话上面'),
      assistant('上一轮回复'),
    ])

    const ctx = loadJudgeTurnContext({ sessionDir: dir, fallbackUserMessage: '做B，但是我记得还有会话路径改变事件触发器' })

    expect(ctx.current.map((m) => m.text)).toEqual(['做B，但是我记得还有会话路径改变事件触发器'])
    expect(ctx.history!.map((t) => t.messages[0]!.text)).toEqual(['上一轮的请求：把项目放在所有会话上面'])
  })

  it('falls back to the transcript when no prompt text is available', () => {
    const dir = makeSessionDir()
    writeTranscript(dir, [user('仅有的一轮')])

    const ctx = loadJudgeTurnContext({ sessionDir: dir })

    expect(ctx.current.map((m) => m.text)).toEqual(['仅有的一轮'])
    expect(ctx.history ?? []).toEqual([])
  })

  it('degrades to the prompt alone when the transcript is missing or empty', () => {
    const dir = makeSessionDir()
    expect(loadJudgeTurnContext({ sessionDir: dir, fallbackUserMessage: '兜底请求' })).toEqual({
      current: [{ text: '兜底请求' }],
      history: [],
    })
    expect(loadJudgeTurnContext({ sessionDir: null, fallbackUserMessage: '兜底请求' }).current).toEqual([
      { text: '兜底请求' },
    ])
    expect(loadJudgeTurnContext({ sessionDir: dir }).current).toEqual([])
  })

  it('tolerates a torn trailing line while the writer is mid-append', () => {
    const dir = makeSessionDir()
    const path = writeTranscript(dir, [user('上一轮'), assistant('回复上一轮'), user('本轮')])
    appendFileSync(path, '{"type":"assistant","content":"半截', 'utf8')

    const ctx = loadJudgeTurnContext({ sessionDir: dir, fallbackUserMessage: '本轮' })

    expect(ctx.current.map((m) => m.text)).toEqual(['本轮'])
    expect(ctx.history!.map((t) => t.messages[0]!.text)).toEqual(['上一轮'])
  })

  it('grows the tail window so an oversized turn never hides its own message', () => {
    // Measured in production: one turn reached 4.47 MB of transcript, i.e. its
    // opening message sat outside a fixed 4 MB tail window. The reader must
    // widen instead of silently losing this turn's intent.
    const dir = makeSessionDir()
    const filler: TranscriptMessage[] = []
    for (let i = 0; i < 3_000; i++) {
      filler.push({ type: 'tool', content: 'x'.repeat(2_000), timestamp: i })
    }
    writeTranscript(dir, [
      user('上一轮请求'), assistant('上一轮回复'),
      user('超长回合的请求'),
      user('超长回合内的引导', { isGuidance: true }),
      ...filler,
    ])

    const ctx = loadJudgeTurnContext({ sessionDir: dir, fallbackUserMessage: '超长回合的请求' })

    expect(ctx.current.map((m) => m.text)).toEqual(['超长回合的请求', '超长回合内的引导'])
    expect(ctx.history!.map((t) => t.messages[0]!.text)).toEqual(['上一轮请求'])
  })
})
