import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** A shell command running longer than this is handed off to the background. */
export const AUTO_BACKGROUND_MS = 30_000

interface BashExecResult {
  exitCode: number
}

interface BashOperationsInput {
  // pi-coding-agent's local shell can report a null exit code (for example
  // when the child is terminated by a signal). The wrapper only uses the
  // promise to detect completion, so accepting the wider shape is safe; the
  // returned operations keep the SDK's narrower `exitCode: number` contract.
  exec: (command: string, dir: string, opts: any) => Promise<{ exitCode: number | null }>
}

interface BashOperations {
  exec: (command: string, dir: string, opts: any) => Promise<BashExecResult>
}

/**
 * Wrap the local Bash operations so a command that is still running after
 * `thresholdMs` is handed off:
 *
 * - its output keeps flowing into `<sessionDir>/background-shells/<id>.log`
 * - the tool call returns immediately with a synthetic result containing
 *   `shell_id: <id>` (the existing `shell_backgrounded` detector matches it)
 * - the original process is not killed, and `SessionManager.killShell` can
 *   still stop it by command string
 *
 * IMPORTANT — `opts.onData` is a BYTE sink, not a text sink: the SDK wires it
 * straight to `child.stdout.on('data', …)` and decodes it with
 * `new TextDecoder().decode(chunk)`. Passing a string (which this wrapper used
 * to do) throws "TextDecoder.decode expects an ArrayBuffer or TypedArray" on
 * the *next* stdout chunk, surfacing as an uncaughtException that kills the
 * whole pi subprocess. So: forward the raw chunk untouched, and decode a copy
 * only for our own log/buffer.
 *
 * The handoff timer is independent of the SDK's 300s command timeout: the SDK
 * clears its timer when `exec` resolves, so the still-running process no longer
 * gets killed at the 300s mark.
 */
export function withAutoBackground(
  operations: BashOperationsInput,
  options: {
    sessionDir?: string
    thresholdMs?: number
    /**
     * Called once when a shell that was ALREADY handed off to the background
     * finally exits. Without this nobody observes the exit: the tool call
     * returned at the threshold, so the model had no way to learn the result
     * and fell back to sleeping/polling. The wake-up path (task_completed →
     * nudge → new turn) needs this signal.
     */
    onBackgroundExit?: (info: { shellId: string; logFile: string; command: string; exitCode: number | null; error?: string }) => void
  } = {},
): BashOperations {
  const thresholdMs = options.thresholdMs ?? AUTO_BACKGROUND_MS
  const decoder = new TextDecoder()

  return {
    exec(command, dir, opts) {
      const sdkOnData = typeof opts?.onData === 'function'
        ? (opts.onData as (chunk: unknown) => void)
        : undefined
      const baseDir = options.sessionDir ?? process.env.CRAFT_SESSION_DIR ?? dir
      const logDir = join(baseDir, 'background-shells')
      const shellId = `shell_${randomUUID().replace(/-/g, '').slice(0, 12)}`
      const logFile = join(logDir, `${shellId}.log`)

      let logStream: ReturnType<typeof createWriteStream> | undefined
      let handedOff = false
      let buffered = ''
      let resolveHandoff!: (result: BashExecResult) => void
      let rejectHandoff!: (error: unknown) => void
      const handoff = new Promise<BashExecResult>((resolve, reject) => {
        resolveHandoff = resolve
        rejectHandoff = reject
      })

      const ensureLog = () => {
        if (!logStream) {
          mkdirSync(logDir, { recursive: true })
          // Create the file synchronously so callers/UI can find it immediately;
          // createWriteStream only opens asynchronously.
          writeFileSync(logFile, '', { flag: 'a' })
          logStream = createWriteStream(logFile, { flags: 'a' })
        }
        return logStream
      }

      /** Record a chunk of text for the handoff log / any later reader. */
      const recordText = (text: string) => {
        if (!text) return
        if (handedOff) ensureLog().write(text)
        else buffered += text
      }

      // Byte-level tap: forward to the SDK exactly what the shell produced, and
      // keep a decoded copy for the background log.
      const tapOnData = (chunk: unknown) => {
        try {
          if (typeof chunk === 'string') {
            // Defensive: some operation implementations hand over decoded text.
            recordText(chunk)
            sdkOnData?.(Buffer.from(chunk, 'utf8'))
            return
          }
          if (chunk instanceof Uint8Array) {
            recordText(decoder.decode(chunk, { stream: true }))
          }
          sdkOnData?.(chunk)
        } catch {
          // Never let bookkeeping break the shell: forwarding is best-effort.
        }
      }

      const original = operations.exec(command, dir, { ...opts, onData: tapOnData })

      const timer = setTimeout(() => {
        const log = ensureLog()
        if (buffered) log.write(buffered)
        buffered = ''
        const seconds = Math.round(thresholdMs / 1000)
        const synthetic =
          `Command is still running after ${seconds}s and was moved to the background.\n` +
          `shell_id: ${shellId}\n` +
          `output_file: ${logFile}\n` +
          `You will be notified automatically when it finishes — do NOT sleep, poll, or re-run the command to wait for it. Continue with other work, or end your turn.\n`
        handedOff = true
        // The SDK's sink takes bytes — hand it the message as UTF-8 bytes so the
        // model sees it in the tool result.
        try {
          sdkOnData?.(Buffer.from(synthetic, 'utf8'))
        } catch {
          // Sink already torn down; the log still has the pointer.
        }
        resolveHandoff({ exitCode: 0 })
      }, thresholdMs)

      void original
        .then((result) => {
          if (!handedOff) {
            resolveHandoff({ exitCode: 0 })
            return
          }
          // The handoff already returned to the model; this is the real exit.
          logStream?.write('')
          try {
            options.onBackgroundExit?.({
              shellId,
              logFile,
              command,
              exitCode: result?.exitCode ?? null,
            })
          } catch {
            // A reporting failure must never crash the shell wrapper.
          }
        })
        .catch((error) => {
          if (handedOff) {
            const message = error instanceof Error ? error.message : String(error)
            ensureLog().write(`\n[background-shell] failed: ${message}\n`)
            try {
              options.onBackgroundExit?.({ shellId, logFile, command, exitCode: null, error: message })
            } catch {
              // ignore
            }
          } else {
            rejectHandoff(error)
          }
        })
        .finally(() => {
          logStream?.end()
        })

      return handoff.finally(() => {
        if (!handedOff) clearTimeout(timer)
      })
    },
  }
}
