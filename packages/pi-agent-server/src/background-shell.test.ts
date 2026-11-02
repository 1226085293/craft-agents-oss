import { describe, it, expect } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withAutoBackground } from './background-shell.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'craft-bg-shell-'))
}

describe('withAutoBackground', () => {
  it('hands off after the threshold and keeps writing to the log file', async () => {
    const dir = tempDir()
    const chunks: string[] = []
    let finish!: () => void

    const operations = {
      exec: (_command: string, _dir: string, opts: any) =>
        new Promise<{ exitCode: number }>((resolve) => {
          opts.onData?.('partial output\n')
          finish = () => {
            opts.onData?.('done\n')
            resolve({ exitCode: 0 })
          }
        }),
    }

    const wrapped = withAutoBackground(operations, { sessionDir: dir, thresholdMs: 30 })
    const result = await wrapped.exec('slow-command', dir, {
      onData: (chunk: string) => chunks.push(chunk),
    })

    expect(result.exitCode).toBe(0)
    const synthetic = chunks.join('')
    expect(synthetic).toContain('shell_id: shell_')
    expect(synthetic).toContain('output_file:')

    const logDir = join(dir, 'background-shells')
    const files = readdirSync(logDir)
    expect(files.length).toBe(1)

    finish()
    await new Promise((resolve) => setTimeout(resolve, 30))
    const log = readFileSync(join(logDir, files[0]!), 'utf8')
    expect(log).toContain('partial output')
    expect(log).toContain('done')

    rmSync(dir, { recursive: true, force: true })
  })

  it('does not synthesize a background result for a fast command', async () => {
    const dir = tempDir()
    const chunks: string[] = []

    const operations = {
      exec: (_command: string, _dir: string, opts: any) =>
        new Promise<{ exitCode: number }>((resolve) => {
          opts.onData?.('quick output\n')
          resolve({ exitCode: 0 })
        }),
    }

    const wrapped = withAutoBackground(operations, { sessionDir: dir, thresholdMs: 50 })
    const result = await wrapped.exec('fast-command', dir, {
      onData: (chunk: string) => chunks.push(chunk),
    })

    expect(result.exitCode).toBe(0)
    expect(chunks.join('')).toBe('quick output\n')
    expect(existsSync(join(dir, 'background-shells'))).toBe(false)

    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * Regression: the SDK pipes `onData` straight into `TextDecoder.decode()`, so
   * this wrapper must never hand it a string. Doing so used to throw
   * "TextDecoder.decode expects an ArrayBuffer or TypedArray" on the next
   * stdout chunk and kill the whole pi subprocess via uncaughtException.
   */
  it('only ever passes bytes to onData (TextDecoder-safe) — before and after handoff', async () => {
    const dir = tempDir()
    const received: unknown[] = []
    const decoder = new TextDecoder()
    const decoded: string[] = []
    let pushMore!: () => void

    const operations = {
      exec: (_command: string, _dir: string, opts: any) =>
        new Promise<{ exitCode: number }>((resolve) => {
          // Real shell data arrives as bytes from child.stdout 'data' events.
          opts.onData?.(Buffer.from('early bytes\n', 'utf8'))
          pushMore = () => {
            opts.onData?.(Buffer.from('late bytes\n', 'utf8'))
            resolve({ exitCode: 0 })
          }
        }),
    }

    const wrapped = withAutoBackground(operations, { sessionDir: dir, thresholdMs: 30 })
    await wrapped.exec('slow-command', dir, {
      onData: (chunk: unknown) => {
        received.push(chunk)
        // Exactly what the SDK does with each chunk.
        decoded.push(decoder.decode(chunk as Uint8Array, { stream: true }))
      },
    })

    // A chunk that arrives AFTER the handoff must still be bytes.
    pushMore()
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(received.length).toBeGreaterThan(0)
    for (const chunk of received) {
      expect(chunk instanceof Uint8Array).toBe(true)
    }
    expect(decoded.join('')).toContain('early bytes')
    expect(decoded.join('')).toContain('shell_id: shell_')
    expect(decoded.join('')).toContain('late bytes')

    rmSync(dir, { recursive: true, force: true })
  })

  it('propagates a failure that happens before the threshold', async () => {
    const dir = tempDir()
    const operations = {
      exec: () => Promise.reject(new Error('spawn failed')),
    }

    const wrapped = withAutoBackground(operations, { sessionDir: dir, thresholdMs: 50 })
    await expect(wrapped.exec('bad-command', dir, {})).rejects.toThrow('spawn failed')

    rmSync(dir, { recursive: true, force: true })
  })
})
