/**
 * prompt-settle.ts
 *
 * Fresh-turn entry guard (2026-11-03, session 261103-early-carbon).
 *
 * `AgentSession.prompt()` behaves differently depending on whether the session
 * is currently streaming:
 *
 * - idle      → appends the user message and starts a run;
 * - streaming → with `streamingBehavior: 'followUp'` it does NOT append the
 *               message at all, it only QUEUES it, and the queue drains when
 *               the CURRENT run ends.
 *
 * The subprocess used to pass `followUp` unconditionally. When the host believed
 * a session was idle while the previous run had not actually settled (an
 * aborted/recreated backend whose prompt still got dispatched), the user's
 * message never became the turn's prompt: the model answered the PREVIOUS
 * message, and the queued text was injected minutes later — mid-turn, right
 * after a complete final answer — so the model redid the work and the user saw
 * two replies.
 *
 * Mid-turn delivery has its own channel (`steer`), so a `prompt` that arrives
 * while streaming always means the previous run did not settle. Settle it, and
 * never silently convert a user turn into a queued follow-up.
 */

export interface PromptSettleSession {
  readonly isStreaming: boolean
  abort(): Promise<void>
}

export interface PromptSettleHooks {
  /** Diagnostics sink (the subprocess passes its debugLog). */
  log?: (message: string) => void
  /** Max time to wait for the session to settle (default 3000ms). */
  settleTimeoutMs?: number
}

/** How long the busy self-heal waits for the previous run to settle. */
export const DEFAULT_BUSY_SETTLE_TIMEOUT_MS = 3000;
const BUSY_SETTLE_POLL_MS = 50;

/**
 * Abort whatever run is still unwinding inside the SDK, then wait (bounded)
 * for the session to actually become idle.
 *
 * Returns true when the session settled inside the window. Returns false when
 * it is still streaming at the deadline — the caller must NOT re-issue a
 * prompt then; a prompt against a still-busy SDK would throw the same busy
 * rejection and no self-heal progress was made.
 */
export async function abortAndWaitForIdle(
  session: PromptSettleSession,
  hooks: PromptSettleHooks = {},
): Promise<boolean> {
  const timeoutMs = hooks.settleTimeoutMs ?? DEFAULT_BUSY_SETTLE_TIMEOUT_MS;
  hooks.log?.(`[prompt] aborting to settle the previous run (busy self-heal, ${timeoutMs}ms window)`);
  try {
    await session.abort();
  } catch (err) {
    // An abort that throws (already aborted / SDK disposed) is not fatal:
    // the polling loop below decides whether the session actually settled.
    hooks.log?.(`[prompt] settle abort failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const deadline = Date.now() + timeoutMs;
  while (session.isStreaming && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, BUSY_SETTLE_POLL_MS));
  }
  if (session.isStreaming) {
    hooks.log?.(`[prompt] still streaming after ${timeoutMs}ms — reporting the original failure instead of re-issuing`);
    return false;
  }
  return true;
}

/**
 * Make sure `session` is idle so the next `prompt()` starts a REAL turn.
 *
 * - Idle session: no-op.
 * - Streaming session: abort the stale run. If it is still streaming
 *   afterwards, throw — the caller must NOT queue the message as a follow-up;
 *   the host surfaces the error and replays the message through its own queue,
 *   where it keeps its user-turn semantics.
 */
export async function settleStreamingSessionBeforePrompt(
  session: PromptSettleSession,
  hooks: PromptSettleHooks = {},
): Promise<void> {
  if (!session.isStreaming) return

  hooks.log?.('[prompt] fresh turn arrived while the previous run was still streaming — aborting it first')
  try {
    await session.abort()
  } catch (err) {
    // An abort that throws (already aborted / SDK disposed) is not fatal: the
    // isStreaming check below decides whether the turn can start.
    hooks.log?.(`[prompt] abort before fresh prompt failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (session.isStreaming) {
    throw new Error(
      'Agent is still processing a previous turn — refusing to queue a fresh user turn as a follow-up',
    )
  }
}
