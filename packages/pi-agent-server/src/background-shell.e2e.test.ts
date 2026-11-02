import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalBashOperations } from '@earendil-works/pi-coding-agent'
import { withAutoBackground } from './background-shell.ts'

// The package's `exports` map does not expose `./core`, but the file is on disk
// and we need the SDK's REAL executor (not a re-implementation) for this test.
const sdkCore = await import(
  new URL(
    '../../../node_modules/@earendil-works/pi-coding-agent/dist/core/index.js',
    import.meta.url,
  ).href
)
const executeBashWithOperations = sdkCore.executeBashWithOperations as (
  command: string,
  cwd: string,
  operations: unknown,
  options?: unknown,
) => Promise<{ output: string; exitCode?: number }>

/**
 * End-to-end reproduction of the background-handoff crash.
 *
 * `executeBashWithOperations` is the SDK's real bash executor: it wires
 * `onData` to `child.stdout.on('data', …)` and pipes every chunk through
 * `new TextDecoder().decode(chunk, { stream: true })`. When the wrapper handed
 * it a *string* (the synthetic handoff message), the next chunk threw
 * "TextDecoder.decode expects an ArrayBuffer or TypedArray", which surfaced as
 * an uncaughtException and `process.exit(1)` — i.e. the whole session died
 * ~30s into any long-running command.
 *
 * This test spawns real processes through both layers, so a regression fails
 * here instead of in a user's session.
 */

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'craft-bg-e2e-'))
}

function readLog(dir: string): string {
  const logDir = join(dir, 'background-shells')
  const files = readdirSync(logDir)
  return files.map((f) => readFileSync(join(logDir, f), 'utf8')).join('')
}

describe('withAutoBackground + real SDK bash executor', () => {
  it('hands off a long command without breaking the SDK decoder', async () => {
    const dir = tempDir()
    const local = createLocalBashOperations()
    const wrapped = withAutoBackground(local, { sessionDir: dir, thresholdMs: 300 })

    // Sleeps past the threshold, then keeps writing — the post-handoff output is
    // exactly the chunk that used to hit a poisoned decoder.
    const result = await executeBashWithOperations(
      'sleep 1; echo after-handoff',
      dir,
      wrapped,
      {},
    )

    expect(result.output).toContain('shell_id: shell_')
    expect(result.output).toContain('output_file:')

    // Let the still-running child flush into the log, then check it landed.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(readLog(dir)).toContain('after-handoff')

    rmSync(dir, { recursive: true, force: true })
  }, 20_000)

  it('passes normal fast commands straight through with byte-identical output', async () => {
    const dir = tempDir()
    const local = createLocalBashOperations()
    const wrapped = withAutoBackground(local, { sessionDir: dir, thresholdMs: 10_000 })

    const result = await executeBashWithOperations(
      'printf "héllo\\nworld\\n"',
      dir,
      wrapped,
      {},
    )

    expect(result.exitCode).toBe(0)
    // Non-ASCII included on purpose: a mangled decode would corrupt it.
    expect(result.output).toContain('héllo')
    expect(result.output).toContain('world')
    expect(result.output).not.toContain('shell_id:')

    rmSync(dir, { recursive: true, force: true })
  }, 20_000)
})

describe('onBackgroundExit (wake-up signal for handed-off shells)', () => {
  it('fires once with the real exit code after a handed-off shell finishes', async () => {
    const dir = tempDir()
    const local = createLocalBashOperations()
    const exits: Array<{ shellId: string; logFile: string; command: string; exitCode: number | null }> = []
    const wrapped = withAutoBackground(local, {
      sessionDir: dir,
      thresholdMs: 300,
      onBackgroundExit: (info) => exits.push(info),
    })

    // Handed off at 300ms, then exits on its own shortly after.
    await executeBashWithOperations('sleep 1; echo done-later', dir, wrapped, {})
    await new Promise((resolve) => setTimeout(resolve, 1800))

    expect(exits.length).toBe(1)
    expect(exits[0]!.shellId).toMatch(/^shell_/)
    expect(exits[0]!.exitCode).toBe(0)
    expect(exits[0]!.command).toContain('done-later')
    expect(readLog(dir)).toContain('done-later')

    rmSync(dir, { recursive: true, force: true })
  }, 20_000)

  it('does not fire for a command that finished before the threshold', async () => {
    const dir = tempDir()
    const local = createLocalBashOperations()
    const exits: unknown[] = []
    const wrapped = withAutoBackground(local, {
      sessionDir: dir,
      thresholdMs: 10_000,
      onBackgroundExit: (info) => exits.push(info),
    })

    await executeBashWithOperations('echo fast', dir, wrapped, {})
    await new Promise((resolve) => setTimeout(resolve, 200))

    // Nothing was handed off, so there is no background task to wake anyone for.
    expect(exits.length).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  }, 20_000)
})
