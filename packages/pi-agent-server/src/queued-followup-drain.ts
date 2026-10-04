/**
 * Queued follow-up drain scheduler (2026-10-07, session 261007-lean-bamboo).
 *
 * Background — the golden-swamp design (2026-09-06) annotated `agent_end`
 * with `queuedFollowUpPending=true` on the assumption that the Pi SDK would
 * re-check its steering/follow-up queue AFTER the loop ended and call
 * `agent.continue()` itself. It does not: the SDK only re-checks the queue
 * at the START of a model round (tool-result boundaries / round starts),
 * never at loop termination. So a steer that is queued MID-STREAM of the
 * final model round survives to agent_end with pending>0, nobody drains it,
 * the main process holds its event queue open on the annotation, and the
 * turn hangs on "Thinking..." until the 300s stall watchdog.
 *
 * Fix: when the subprocess annotates an agent_end with pending messages, it
 * schedules the drain itself — the same `agent.continue()` call that
 * handleRetry's drain path uses. The drain splices the queued guidance as a
 * user message and answers it within the SAME turn; the main process keeps
 * its queue open (queuedFollowUpHeld) until the drained reply's terminal
 * stop (the 261007-active-wren adapter fix promotes that reply to the final
 * result bubble).
 *
 * This helper is pure scheduling so it can be unit-tested with an injected
 * timer and a fake session — index.ts owns logging and error surfacing.
 */
export interface DrainableSession {
  /** Live count of queued steering/follow-up messages (SDK AgentSession). */
  pendingMessageCount?: number;
  agent: {
    continue(): Promise<void>;
  };
}

export interface ScheduleDrainOptions {
  /** Delay before the drain check (ms). Default 100 — mirrors the SDK's own
   *  compaction-drain setTimeout(…, 100) so in-flight agent_end event
   *  forwarding is not starved. */
  delayMs?: number;
  /** Injectable timer for tests (default: global setTimeout). */
  timer?: (fn: () => void, ms: number) => unknown;
  /** Called at drain start with the pending count (index.ts logs this). */
  onDrain?: (pending: number) => void;
  /** Called if agent.continue() rejects (index.ts surfaces + logs). */
  onDrainError?: (message: string) => void;
}

/**
 * Schedule an `agent.continue()` drain for a session that ended its agent
 * loop with queued messages. Fires only if messages are STILL pending when
 * the timer runs (an in-loop drain that already consumed them — the
 * 261007-active-wren shape — makes this a no-op).
 *
 * Returns a cancel function (no-ops the pending fire).
 */
export function scheduleQueuedFollowUpDrain(
  session: DrainableSession,
  options: ScheduleDrainOptions = {},
): () => void {
  const delayMs = options.delayMs ?? 100;
  const timer =
    options.timer ??
    ((fn: () => void, ms: number) => setTimeout(fn, ms));

  let cancelled = false;
  timer(() => {
    if (cancelled) return;
    const pending = session.pendingMessageCount ?? 0;
    if (pending <= 0) return;
    options.onDrain?.(pending);
    session.agent
      .continue()
      .catch((error: unknown) => {
        options.onDrainError?.(error instanceof Error ? error.message : String(error));
      });
  }, delayMs);

  return () => {
    cancelled = true;
  };
}
