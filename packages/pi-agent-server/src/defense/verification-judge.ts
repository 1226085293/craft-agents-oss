/**
 * verification-judge.ts
 *
 * Verification judge invocation with retry (2026-10-13 user spec).
 *
 * Previously a judge that was UNAVAILABLE (upstream timeout / quota /
 * transport error / empty response) caused a fail-OPEN: the captured final
 * text was delivered unverified. The user spec: when the judge request
 * times out, the next step must RE-RUN the verification until it succeeds
 * or fails — each skip surfaced as a process-block line
 * ("Verification skipped (reason) — retrying N/M"), then the next line is
 * another skip / success / fail.
 *
 * This module owns the retry loop; the caller (doVerificationCheck) wires
 * `runAttempt` to the LLM query and `onSkip` to the subprocess→main
 * `verification_skip` event that the UI renders as a process block.
 *
 * Exhaustion is NOT a fail-open: after `maxAttempts` unavailable attempts
 * the verdict is null and the caller follows the FAILED lane (follow-up
 * resume; the resume chain is bounded by SessionLifecycle chain caps).
 */

export const DEFAULT_VERIFICATION_JUDGE_MAX_ATTEMPTS = 3;
export const DEFAULT_VERIFICATION_JUDGE_RETRY_DELAY_MS = 1_000;

export interface VerificationJudgeOptions {
  /** Single judge call. Non-empty trimmed text = a usable verdict. Throws = attempt fault. */
  runAttempt: (prompt: string) => Promise<string | null>;
  /**
   * Called BEFORE each retry (attempt is the failed attempt, 1-based) so the
   * UI can render a "Verification skipped (reason) — retrying N/M" process
   * block. Not called after the final failed attempt.
   */
  onSkip: (attempt: number, totalAttempts: number, reason: string) => void | Promise<void>;
  /** Delay between attempts (ms); scaled linearly by attempt ordinal. */
  delay: (ms: number) => Promise<void>;
  /** Max judge attempts (default 3). */
  maxAttempts?: number;
  /** Base retry delay in ms (default 1000); actual delay = base * attempt. */
  retryDelayMs?: number;
}

export interface VerificationJudgeOutcome {
  /** Parsed verdict text, or null when all attempts were unavailable. */
  verdict: string | null;
  /** Attempts consumed (the successful one, or maxAttempts on exhaustion). */
  attemptsUsed: number;
  /** Fault description of the last failed attempt ('' when it succeeded). */
  lastFault: string;
}

export async function runVerificationJudge(
  prompt: string,
  options: VerificationJudgeOptions,
): Promise<VerificationJudgeOutcome> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_VERIFICATION_JUDGE_MAX_ATTEMPTS;
  const baseDelay = options.retryDelayMs ?? DEFAULT_VERIFICATION_JUDGE_RETRY_DELAY_MS;

  let lastFault = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let verdict: string | null = null;
    try {
      const result = await options.runAttempt(prompt);
      if (result != null && result.trim().length > 0) {
        return { verdict: result, attemptsUsed: attempt, lastFault: '' };
      }
      lastFault = 'empty judge response';
    } catch (error) {
      lastFault = error instanceof Error ? error.message : String(error);
    }
    if (attempt < maxAttempts) {
      await options.onSkip(attempt, maxAttempts, lastFault);
      await options.delay(baseDelay * attempt);
    }
  }
  return { verdict: null, attemptsUsed: maxAttempts, lastFault };
}