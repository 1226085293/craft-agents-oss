/**
 * Streaming degeneracy detector
 *
 * Catches the failure mode where a model's output devolves into a repetition
 * loop WHILE IT IS STILL STREAMING — e.g. the 2026-10-15 incident (session
 * 261013-mild-stream) where a single assistant message emitted "执行。" × 165
 * and burned 204.6 seconds of stream time (3,829 output tokens at ~19 tok/s)
 * before anybody noticed.
 *
 * Why a new detector instead of reusing defense/repetition-detector.ts:
 *   - `detectRepetitionLoop` runs ONCE at `agent_end` (whole-turn granularity).
 *     The stop-loss window for a mid-stream degeneration is inside the stream;
 *     by agent_end the damage is already done.
 *   - Its `MIN_UNIT_LENGTH = 40` misses short-unit loops ("执行。" is 3 chars).
 *
 * Design principle: content-agnostic. The statistical signature of a
 * degenerate loop is DIVERSITY COLLAPSE, not any particular phrase — the
 * repeated string differs every incident. So the detector uses n-gram
 * repetition statistics only. No word lists, no hardcoded phrases.
 *
 * Detection: within a sliding tail window, the share of n-grams that are
 * repeats of an earlier n-gram. Healthy output (code dumps, tables, verbatim
 * quoting, recurring prose idioms) keeps repeating structure LOCAL — phrase-
 * level recurrence spreads across the whole reply, so a bounded tail never
 * reaches the degenerate ratio. A loop repeats the SAME window over and over,
 * driving the ratio to ~1.
 *
 * Two conditions must hold simultaneously (AND) to bound false positives:
 *   1. `distinctRatio < DISTINCT_RATIO_MAX` — >= 90% of windows are repeats
 *   2. `topGramCount >= MIN_TOP_GRAM_COUNT` — the most frequent n-gram
 *      repeats at least 20 times (a structural echo can depress the ratio
 *      briefly but cannot sustain 20 copies of one window)
 *
 * Throttling: the check runs only every `CHECK_INTERVAL_CHARS` characters of
 * newly streamed text, and the state machine fires AT MOST ONCE per streamed
 * message (`alreadyFired`), so a loop cannot queue a storm of corrections.
 */

/** N-gram width in characters. 10 chars spans "执行。" (3) and "好的。" (3). */
export const NGRAM_SIZE = 10;
/** Characters of the judged tail. Bounds both memory and CPU per check. */
export const TAIL_WINDOW_CHARS = 2000;
/** Check every N new characters of streamed text. */
export const CHECK_INTERVAL_CHARS = 500;
/** Degenerate when the share of distinct n-grams drops below this. */
export const DISTINCT_RATIO_MAX = 0.1;
/** ...and the most frequent n-gram repeats at least this many times. */
export const MIN_TOP_GRAM_COUNT = 20;
/** Minimum number of sampled windows before the ratio means anything. */
export const MIN_SAMPLED_WINDOWS = 20;

export interface DegeneracyVerdict {
  /** True when the streamed text looks like a repetition loop. */
  readonly isDegenerate: boolean;
  /** Share of sampled windows that were repeats (1 = every window a repeat). */
  readonly distinctRatio: number;
  /** How many times the most frequent n-gram appeared. */
  readonly topGramCount: number;
  /** Total windows sampled in the judged tail. */
  readonly sampledWindows: number;
}

/**
 * Judge a single tail string for repetition-loop degeneracy.
 * Pure function — no state, no I/O. Exported for unit tests.
 *
 * The floor is on SAMPLED WINDOWS, not characters: a 3-char unit loop like
 * "执行。" only needs ~200 chars to produce 20 windows, and that is exactly
 * the incident shape we must catch. A character floor would exclude the
 * shortest, most aggressive loops.
 */
export function judgeTail(tail: string): DegeneracyVerdict {
  const no = (): DegeneracyVerdict => ({
    isDegenerate: false, distinctRatio: 1, topGramCount: 0, sampledWindows: 0,
  });

  const counts = new Map<string, number>();
  let sampled = 0;
  let distinct = 0;
  for (let i = 0; i + NGRAM_SIZE <= tail.length; i += 1) {
    const gram = tail.slice(i, i + NGRAM_SIZE);
    const prev = counts.get(gram) ?? 0;
    if (prev === 0) distinct += 1;
    counts.set(gram, prev + 1);
    sampled += 1;
  }
  if (sampled < MIN_SAMPLED_WINDOWS) return no();

  let topGramCount = 0;
  for (const c of counts.values()) if (c > topGramCount) topGramCount = c;

  const distinctRatio = distinct / sampled;
  const isDegenerate =
    distinctRatio < DISTINCT_RATIO_MAX && topGramCount >= MIN_TOP_GRAM_COUNT;

  return { isDegenerate, distinctRatio, topGramCount, sampledWindows: sampled };
}

/** Correction message queued when degeneracy is detected mid-stream. */
export const DEGENERACY_CORRECTION =
  'Your previous output degenerated into repeated text without making progress. ' +
  'Stop. Re-read the original task, then produce the next distinct piece of work — ' +
  'or a final answer if the task is already satisfied.';

/** UI status line shown in the process block when degeneracy is detected. */
/**
 * UI status text for the process-block row.
 *
 * The renderer localizes this row from its `statusType`
 * ('degeneracy_detected' -> chat.degeneracyDetected), so this English string is
 * only the pipeline-side fallback — it is what a reloaded/persisted row would
 * show if no i18n resource were available. Keep it in sync with the en key.
 */
export const DEGENERACY_STATUS_TEXT =
  'Model output degenerate (repeated text, no progress) - correction sent';

/**
 * Per-stream message state machine.
 *
 * One instance tracks ONE assistant message's streamed text. A new instance
 * must be created for each message (see `StreamingDegeneracyTracker`).
 */
export class StreamingDegeneracyState {
  /** All text streamed so far for this message. */
  text = '';
  /** Characters at the last check — drives the CHECK_INTERVAL throttle. */
  private lastCheckLen = 0;
  /** Latched: at most one detection per streamed message. */
  private fired = false;

  /**
   * Feed newly streamed visible text.
   * @returns the verdict when this chunk completed a check, else null.
   */
  append(chunk: string): DegeneracyVerdict | null {
    this.text += chunk;
    if (this.fired) return null;
    if (this.text.length - this.lastCheckLen < CHECK_INTERVAL_CHARS) return null;
    this.lastCheckLen = this.text.length;
    const tail = this.text.slice(-TAIL_WINDOW_CHARS);
    const verdict = judgeTail(tail);
    if (verdict.isDegenerate) {
      this.fired = true;
      return verdict;
    }
    // Report the check result even when not degenerate so callers can log
    // ratios during telemetry calibration without re-running the judge.
    return verdict;
  }

  /** Whether this message already fired (used for logging/tests). */
  get hasFired(): boolean {
    return this.fired;
  }

  /** Total characters streamed for this message (diagnostics/logging). */
  get currentChars(): number {
    return this.text.length;
  }
}

/**
 * Tracks the currently streaming assistant message and hands out per-message
 * state. Resets on every `message_start` so each stream is judged fresh.
 */
export class StreamingDegeneracyTracker {
  private current: StreamingDegeneracyState | null = null;

  /** Begin a new assistant message stream. */
  reset(): void {
    this.current = new StreamingDegeneracyState();
  }

  /** Total characters streamed for the current message (0 before any). */
  get currentChars(): number {
    return this.current?.text.length ?? 0;
  }

  /**
   * Feed streamed text for the current message.
   * Returns the verdict only on the chunk that first trips detection
   * (null on all other chunks, including non-degenerate checks).
   */
  feed(chunk: string): DegeneracyVerdict | null {
    if (this.current === null) this.reset();
    const verdict = this.current!.append(chunk);
    if (verdict?.isDegenerate) return verdict;
    return null;
  }
}
