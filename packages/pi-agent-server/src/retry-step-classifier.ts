/**
 * Retry-step classification for handleRetry (2026-10-13, session
 * 261008-plain-stag). Extracted as a pure module so the re-runnable
 * whitelist and the SDK busy-rejection detector are unit-testable without
 * driving the whole pi-agent-server subprocess.
 *
 * Background (the incident): the retry ladder fires `retry`, handleRetry
 * inspects the LAST transcript message and decides whether `agent.continue()`
 * can re-run the model step. The whitelist originally accepted only
 * stopReason='error' (failed step) and empty clean stops. The 2026-10-13
 * turn was killed mid-drain by a busy-abort, stamping an EMPTY
 * stopReason='aborted' step — the whitelist refused it and every later rung
 * died with "Cannot retry: the current turn has no re-runnable model step.",
 * looping in the background forever.
 */

export type AbortReason = 'user' | 'system' | null;

export interface LastAssistantShape {
  stopReason?: string | null;
  content?: Array<{ type?: string; text?: unknown }> | string | null;
  errorMessage?: string | null;
}

export type RetryStepVerdict =
  /** Cannot re-run: surface "no re-runnable model step". */
  | { kind: 'refuse' }
  /** Strip the unusable assistant message, then continue(). */
  | { kind: 'strip'; why: 'failed_step' | 'empty_clean_stop' | 'system_aborted' }
  /** Keep the delivered reply in context; continue() drains pending follow-ups. */
  | { kind: 'drain_pending' };

/**
 * Decide whether the LAST assistant transcript message is a re-runnable
 * model step for the retry ladder.
 *
 * @param am Last assistant message shape (transcript tail).
 * @param abortReason Persistent abort attribution ('user' | 'system' | null).
 * @param pendingFollowUps Live queued follow-up count (0 when none).
 */
export function classifyRetryStep(
  am: LastAssistantShape,
  abortReason: AbortReason,
  pendingFollowUps: number,
): RetryStepVerdict {
  const hasVisibleText = Array.isArray(am.content)
    && am.content.some((c) => c?.type === 'text' && String(c.text ?? '').trim().length > 0);

  // 1. stopReason='error' — the SDK committed the FAILED model step.
  const isFailedStep = am.stopReason === 'error';
  // 2. A clean stop with NO visible text — empty terminal response.
  const isEmptyCleanStop = (am.stopReason === 'stop' || am.stopReason === 'length') && !hasVisibleText;
  // 3. (2026-10-13) A SYSTEM-aborted step with NO visible text — the SAME
  //    empty shape a stall/busy abort stamps; re-runnable ONLY when the
  //    attribution is affirmative 'system' (stall watchdog / retry-busy /
  //    tool-loop guard). 'user' stays terminal (P0 rule: never revive a
  //    deliberately stopped turn) and null (unknown origin) also refuses —
  //    conservative: without proof of a system abort, do not re-run a turn
  //    whose stop might have been deliberate.
  const isEmptySystemAborted = am.stopReason === 'aborted' && !hasVisibleText && abortReason === 'system';

  if (isFailedStep || isEmptyCleanStop || isEmptySystemAborted) {
    return {
      kind: 'strip',
      why: isFailedStep
        ? 'failed_step'
        : isEmptySystemAborted
          ? 'system_aborted'
          : 'empty_clean_stop',
    };
  }

  // Silent-stream recovery (2026-10-07): a DELIVERED reply while queued
  // follow-ups are still pending — continue() drains them within the SAME
  // turn without stripping (the delivered reply stays in context).
  if (pendingFollowUps > 0) {
    return { kind: 'drain_pending' };
  }

  // Anything else (real reply, user-stopped run, tool-call step) is terminal.
  return { kind: 'refuse' };
}

/**
 * SDK busy-rejection detector. agent.continue() rejects with
 * "Agent is already processing. Wait for completion before continuing." when
 * ANOTHER model step is in flight — the queued-follow-up drain or a previous
 * retry's continue(). That is a COORDINATION signal, not a fault: the
 * in-flight run is the legitimate recovery owner and its own model events
 * settle the main-process ladder. Suppressing the abort here is the root fix
 * for the 261008-plain-stag incident — the busy-abort killed the drain
 * mid-run and stamped an empty aborted step that wedged the ladder forever.
 */
export function isSdkBusyRejection(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes('already processing') || m.includes('wait for completion') || m.includes('already busy');
}
