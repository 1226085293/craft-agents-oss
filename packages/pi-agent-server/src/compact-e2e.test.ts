import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * END-TO-END smoke of the real compact IPC path against the BUILT bundle:
 * init → prompt (real session build) → /compact, with a local mock OpenAI
 * endpoint whose timing is controllable (slow vs fast compaction).
 *
 * Covers the three policies with real SDK calls — no mocks for
 * waitForCompaction/translate (those are unit-tested in compaction-policy
 * tests; here they run through handleCompact, session.compact() and the
 * actual JSONL protocol):
 *   T3  W-ceiling honest error  ("still in progress" reaches the client)
 *   T2  guard after completion  (Already compacted, waited=false → error)
 *   T1  translation window      (Already compacted, waited=true → success
 *       carrying the persisted record's tokensBefore)
 */

const packageDir = dirname(import.meta.dir)
const bundlePath = join(packageDir, 'dist', 'index.js')
const RUN_TIMEOUT_MS = 120_000
let scratchDir: string

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Mock OpenAI-compatible streaming endpoint (timing controllable)
// ---------------------------------------------------------------------------
let mockPort = 0
let mockServer: http.Server | null = null
let nextFirstChunkDelay = 1_000
let nextChunkInterval = 400
let nextChunkCount = 4

function startMock(): Promise<void> {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      if (req.url !== '/v1/chat/completions' || req.method !== 'POST') {
        res.writeHead(404).end()
        return
      }
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const firstDelay = nextFirstChunkDelay
        const interval = nextChunkInterval
        const chunks = nextChunkCount
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        let sent = 0
        const stream = () => {
          if (sent >= chunks) {
            // Terminal chunk: the openai-completions parser requires an
            // explicit finish_reason before [DONE], or the compactor fails
            // with "Stream ended without finish_reason".
            const term = {
              id: 'chatcmpl-e2e',
              object: 'chat.completion.chunk',
              created: Date.now(),
              model: 'd4f0731',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            }
            res.write(`data: ${JSON.stringify(term)}\n\n`)
            res.write('data: [DONE]\n\n')
            res.end()
            return
          }
          sent++
          const payload = {
            id: 'chatcmpl-e2e',
            object: 'chat.completion.chunk',
            created: Date.now(),
            model: 'd4f0731',
            choices: [
              {
                index: 0,
                delta: { content: sent === 1 ? 'Compaction summary line. ' : `Segment ${sent}. ` },
                finish_reason: null,
              },
            ],
          }
          res.write(`data: ${JSON.stringify(payload)}\n\n`)
          setTimeout(stream, interval)
        }
        setTimeout(stream, firstDelay)
      })
    })
    mockServer.listen(0, '127.0.0.1', () => {
      mockPort = (mockServer!.address() as { port: number }).port
      resolve()
    })
  })
}

/** Set the mock's timing for the NEXT request. */
function scheduleMockTiming(firstChunkDelayMs: number, chunkIntervalMs: number, chunkCount: number): void {
  nextFirstChunkDelay = firstChunkDelayMs
  nextChunkInterval = chunkIntervalMs
  nextChunkCount = chunkCount
}

// ---------------------------------------------------------------------------
// Bundle harness with mid-stream message injection
// ---------------------------------------------------------------------------
interface BundleHandle {
  send(msg: object): void
  waitFor(match: (out: string) => boolean, timeoutMs?: number): Promise<string>
  close(): void
}

function createOfflineEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: scratchDir,
    USERPROFILE: scratchDir,
    XDG_CONFIG_HOME: scratchDir,
    TMPDIR: scratchDir,
    TEMP: scratchDir,
    TMP: scratchDir,
  }
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT'] as const) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return env
}

function startBundle(extraEnv: Record<string, string> = {}): BundleHandle {
  const child: ChildProcess = spawn(process.execPath, [bundlePath], {
    cwd: scratchDir,
    env: { ...createOfflineEnvironment(), ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let output = ''
  const waiters: Array<{ match: (out: string) => boolean; resolve: (out: string) => void }> = []
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString()
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(output)) {
        const [w] = waiters.splice(i, 1)
        w.resolve(output)
      }
    }
  })
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  return {
    send: (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`),
    waitFor: (match, timeoutMs = RUN_TIMEOUT_MS) =>
      new Promise((resolve, reject) => {
        if (match(output)) return resolve(output)
        const w = { match, resolve }
        waiters.push(w)
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(w)
          if (idx >= 0) waiters.splice(idx, 1)
          reject(new Error(`waitFor timed out; output tail:\n${output.slice(-2500)}`))
        }, timeoutMs)
        w.resolve = (out: string) => {
          clearTimeout(timer)
          resolve(out)
        }
      }),
    close: () => {
      if (process.env.COMPACT_E2E_DUMP) {
        // Debug aid: show what the bundle actually emitted before teardown.
        // eslint-disable-next-line no-console
        console.log(`--- bundle output tail (${output.length} chars) ---\n${output.slice(-4000)}`)
      }
      child.kill()
    },
  }
}

async function initBundle(b: BundleHandle, extraEnv: Record<string, string> = {}): Promise<void> {
  b.send({
    type: 'init',
    apiKey: 'sk-e2e-mock',
    model: 'd4f0731',
    cwd: scratchDir,
    thinkingLevel: 'off',
    workspaceRootPath: scratchDir,
    sessionId: 'e2e-compact',
    sessionPath: scratchDir,
    workingDirectory: scratchDir,
    plansFolderPath: join(scratchDir, 'plans'),
    providerType: 'custom-endpoint',
    authType: 'api_key',
    baseUrl: `http://127.0.0.1:${mockPort}/v1`,
    customEndpoint: { api: 'openai-completions' as const, supportsImages: false },
    piAuth: { provider: 'custom-endpoint', credential: { type: 'api_key' as const, key: 'sk-e2e-mock' } },
    defaultContextWindow: 1_000_000,
    defenseEnabled: false,
  })
  await b.waitFor((out) => out.includes('"type":"ready"'))
}

/** Seed a real session large enough to compact: the SDK's keepRecentTokens
 *  default is 20k, and findCutPoint only yields a summary when the history
 *  exceeds it — smaller sessions hit "Nothing to compact (session too
 *  small)" (same behavior a real user would see). Four 30k-char turns ≈
 *  30k+ tokens of transcript. Agent turns emit agent_end events on the event
 *  stream; count them (the prompt id itself never echoes back). */
async function seedSession(b: BundleHandle): Promise<void> {
  const filler = 'x'.repeat(30_000)
  for (let i = 0; i < 4; i++) {
    scheduleMockTiming(30, 20, 2)
    b.send({
      type: 'prompt',
      id: `p-seed-${i}`,
      message: `${filler}\n\nLine ${i}: continue the document.`,
      systemPrompt: 'Be brief.',
    })
    const target = i + 1
    await b.waitFor(
      (out) => out.split('"type":"agent_end"').length - 1 >= target,
      30_000,
    )
  }
}

const skipBuild = process.env.E2E_SKIP_BUILD === '1'

beforeAll(async () => {
  if (!skipBuild) {
    const build = spawnSync('bun', ['run', 'build'], { cwd: packageDir, stdio: 'pipe', timeout: 180_000 })
    if (build.status !== 0) {
      throw new Error(`bundle build failed: ${(build.stderr?.toString() ?? build.stdout?.toString()).slice(-2000)}`)
    }
  }
  scratchDir = mkdtempSync(join(tmpdir(), 'pi-compact-e2e-'))
  mkdirSync(join(scratchDir, 'plans'), { recursive: true })
  await startMock()
})

afterAll(() => {
  mockServer?.close()
  if (scratchDir) {
    try {
      rmSync(scratchDir, { recursive: true, force: true })
    } catch {
      // Windows: leftover child handles can hold the dir briefly — same class
      // of EBUSY cleanup race as bundle-smoke; never fail the suite for it.
    }
  }
})

describe('compact e2e (real bundle + real SDK compact)', () => {
  it('T3: honest still-in-progress error while a prior compaction runs', async () => {
    const env = { CRAFT_PI_COMPACT_WAIT_TIMEOUT_MS: '1500' }
    const b = startBundle(env)
    try {
      await initBundle(b)
      await seedSession(b)
      // Compaction A: D ≈ 50 + 4×1000 = ~4.05s.
      scheduleMockTiming(50, 1000, 4)
      b.send({ type: 'compact', id: 'c-T3a' })
      await sleep(600) // A is mid-compaction; the pipeline is compacting now.
      // Retry B waits on A, hits its W=1.5s ceiling while A is still running
      // → honest error, delivered before any RPC timer could have fired.
      b.send({ type: 'compact', id: 'c-T3b' })
      const out = await b.waitFor((o) => o.includes('compact_result') && o.includes('c-T3b'))
      expect(out).toContain('"success":false')
      expect(out).toContain('still in progress')
      // A itself completes normally afterwards, unbothered by B's verdict.
      await b.waitFor((o) => o.includes('compact_result') && o.includes('c-T3a'), 15_000)
    } finally {
      b.close()
    }
  }, 30_000)

  it('T2: guard error (Already compacted, no wait) after a fast compaction lands', async () => {
    const env = {}
    const b = startBundle(env)
    try {
      await initBundle(b)
      await seedSession(b)
      // Fast compaction: D ≈ 50 + 2×30 = ~110ms.
      scheduleMockTiming(50, 30, 2)
      b.send({ type: 'compact', id: 'c-T2a' })
      // Wait until the compaction start/end events landed, then ask again.
      await b.waitFor((o) => o.includes('"type":"compaction_end"'))
      b.send({ type: 'compact', id: 'c-T2b' })
      const out = await b.waitFor((o) => o.includes('compact_result') && o.includes('c-T2b'))
      expect(out).toContain('"success":false')
      const tail = out.slice(out.lastIndexOf('c-T2b'))
      expect(tail).toContain('Already compacted')
      expect(tail).not.toContain('"note":"completed by the preceding compaction"')
    } finally {
      b.close()
    }
  }, 30_000)

  it('T1: translation — a retry inside the window succeeds with the persisted record', async () => {
    const env = { CRAFT_PI_COMPACT_WAIT_TIMEOUT_MS: '1500' }
    const b = startBundle(env)
    try {
      await initBundle(b)
      await seedSession(b)
      // Slow compaction D ≈ 50 + 5×1600 = ~8.05s; first compact trips W at 1.5s.
      scheduleMockTiming(50, 1600, 5)
      b.send({ type: 'compact', id: 'c-T1a' })
      // Wait for the compaction pipeline to actually start (compaction_start
      // event), THEN count the retry from that moment.
      await b.waitFor((o) => o.includes('"type":"compaction_start"'))
      // Retry at r ≈ 6.9s into D → wait window (D−r) ≈ 1.1s < W=1.5s → translation.
      await sleep(6_900)
      b.send({ type: 'compact', id: 'c-T1b' })
      const out = await b.waitFor(
        (o) => o.includes('compact_result') && o.includes('c-T1b'),
        60_000,
      )
      const tail = out.slice(out.lastIndexOf('c-T1b'))
      expect(tail).toContain('"success":true')
      expect(tail).toContain('"note":"completed by the preceding compaction"')
      expect(tail).toContain('"tokensBefore":')
      const tokensBefore = Number(tail.match(/"tokensBefore":(\d+)/)?.[1] ?? 0)
      expect(tokensBefore).toBeGreaterThan(0)
    } finally {
      b.close()
    }
  }, 90_000)
})