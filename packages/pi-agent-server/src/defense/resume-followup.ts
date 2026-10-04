/**
 * Defense-resume delivery guarantee
 *
 * `session.followUp(msg)` only ENQUEUES the resume message. It is drained by
 * the SDK's post-run loop (`_handlePostAgentRun` → `agent.continue()`) — but
 * that loop is only active WHILE the original prompt run is unwinding.
 *
 * Two delivery paths exist:
 *
 * 1. Synchronous post-stop resume (defenseResumePending): the followUp is
 *    queued DURING agent_end dispatch, before the post-run loop exits — the
 *    SDK's own loop drains it. (2026-08-23 incident fix.)
 *
 * 2. Verification-FAIL fallback: the followUp is queued LATER, after the
 *    async judge LLM call. By then the post-run loop has exited, the agent
 *    is idle, and NOTHING consumes the queue. The main process holds its
 *    event queue open on `defense_resume_status { resumed: true }` and waits
 *    for resumed-turn events that never come — the session freezes until
 *    the 600s stall watchdog (2026-10-04 incident, session
 *    261004-tall-nickel: "verification FAILED — falling back to follow-up",
 *    then 10 minutes of silence).
 *
 * `drainQueuedFollowUp` closes that gap: when the session is idle, kick the
 * continuation explicitly so the queued followUp actually runs.
 */

/** Minimal AgentSession surface required for delivery guarantee. */
export interface ResumeSessionLike {
  /** True while an agent run (or its post-run loop) is active. */
  readonly isStreaming: boolean;
  agent: {
    /** Continue from the current transcript, draining queued follow-ups. */
    continue(): Promise<void>;
  };
}

export type FollowUpDrainResult =
  /** An active run (or the SDK post-run loop) will drain the queue. */
  | 'drained-by-sdk'
  /** The session was idle; the continuation was started explicitly. */
  | 'explicit-continue'
  /** A run became active between the idle check and the continue call —
   *  it will drain the queue; the resumed turn's events flow with it. */
  | 'busy-will-drain'
  /** The continuation could not be started — the caller must report
   *  `resumed: false` so the main process finalizes its held queue early
   *  instead of hanging on the idle watchdog. */
  | 'failed';

/**
 * Ensure a just-queued defense followUp gets processed.
 *
 * Must be called AFTER `session.followUp(msg)` resolved. Fire-and-forget
 * callers should handle the result (reporting `failed` as `resumed: false`).
 */
export async function drainQueuedFollowUp(session: ResumeSessionLike): Promise<FollowUpDrainResult> {
  // An active run drains the followUp queue itself (the SDK loop polls
  // getFollowUpMessages() before final agent_end; the post-run loop calls
  // agent.continue() while it is still alive).
  if (session.isStreaming) {
    return 'drained-by-sdk';
  }
  try {
    await session.agent.continue();
    return 'explicit-continue';
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // We raced a run that just started (e.g. the user's next prompt): its
    // post-run loop will drain the queue — not a delivery failure.
    if (msg.includes('already processing')) {
      return 'busy-will-drain';
    }
    return 'failed';
  }
}
