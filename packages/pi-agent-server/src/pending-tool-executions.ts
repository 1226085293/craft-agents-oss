/**
 * Pending proxy-tool executions (subprocess side).
 *
 * A proxy tool's `execute()` awaits a promise that only settles when the main
 * process replies with `tool_execute_response`. Before 2026-10-18 that promise
 * had NO timeout and no abort path: a hung host-side tool (e.g. a browser CDP
 * screenshot that never returns) left the promise pending forever, so the Pi
 * SDK's `activeRun` never cleared and every later prompt died with
 * "Agent is already processing a prompt". The retry ladder then looped on
 * "Cannot retry: the current turn has no re-runnable model step".
 *
 * This module makes every pending execution terminally bounded:
 *   - `create()` arms a hard timeout (the caller passes the tool's budget);
 *   - `resolve()` settles a normal host reply;
 *   - `rejectAll()` aborts every in-flight execution (stall watchdog / user
 *     stop / server shutdown) so the SDK can append an error toolResult and
 *     end the run instead of hanging.
 */

export interface PendingToolResult {
  content: string;
  isError: boolean;
}

interface PendingEntry {
  resolve: (result: PendingToolResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  /** True for a tool that is actually executing (not a speculative prefetch). */
  active: boolean;
}

export class PendingToolExecutions {
  private readonly entries = new Map<string, PendingEntry>();

  get size(): number {
    return this.entries.size;
  }

  /**
   * True when at least one REAL tool execution is in flight. Speculative
   * prefetches do NOT count: a prefetch pending while the model stream is
   * silent must not mask a dead turn (the stall watchdog stays armed).
   */
  hasActiveTool(): boolean {
    for (const entry of this.entries.values()) {
      if (entry.active) return true;
    }
    return false;
  }

  has(requestId: string): boolean {
    return this.entries.has(requestId);
  }

  /**
   * Register a pending execution and return the promise the proxy tool awaits.
   * `timeoutMs <= 0` disables the timer (callers should always pass a budget;
   * the escape hatch exists for tests only).
   */
  create(
    requestId: string,
    timeoutMs: number,
    opts?: { active?: boolean },
  ): Promise<PendingToolResult> {
    return new Promise<PendingToolResult>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          // The entry may already have been settled (resolve/rejectAll) — only
          // the still-registered one times out.
          if (!this.entries.has(requestId)) return;
          this.entries.delete(requestId);
          reject(new Error(
            `Tool execution timed out after ${Math.max(1, Math.round(timeoutMs / 1000))}s (no response from host).`,
          ));
        }, timeoutMs)
        : null;
      // NOTE: deliberately NOT unref'd. In a subprocess whose only pending
      // work is this promise (and in unit tests), an unref'd timer lets the
      // event loop go idle and the timeout never fires — the exact hang this
      // module exists to prevent. The timer is cleared on every settle path.
      this.entries.set(requestId, { resolve, reject, timer, active: opts?.active !== false });
    });
  }

  /** Settle one execution with the host's result. Returns false when unknown. */
  resolve(requestId: string, result: PendingToolResult): boolean {
    const entry = this.entries.get(requestId);
    if (!entry) return false;
    this.entries.delete(requestId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(result);
    return true;
  }

  /**
   * Reject every in-flight execution. Used by the stall watchdog and user
   * abort so the SDK's tool promise settles and the run can end cleanly.
   * Returns the number of executions rejected.
   */
  rejectAll(reason: string): number {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) {
      if (entry.timer) clearTimeout(entry.timer);
      try {
        entry.reject(new Error(reason));
      } catch {
        // A reject handler must never break the abort path.
      }
    }
    return entries.length;
  }

  /** Clear without rejecting (process teardown; the process is exiting). */
  clear(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.entries.clear();
  }
}
