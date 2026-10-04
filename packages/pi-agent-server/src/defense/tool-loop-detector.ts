/**
 * Layer 2b — Tool-call no-progress (busy-loop) detector.
 *
 * Catches the failure mode the silence-based stall watchdog cannot: a turn
 * that keeps emitting events (thinking + identical tool call + identical
 * result) for hours — 2026-10-03 incident (session 261001-active-eclipse:
 * ~250 identical iterations at ~7s/round over 1h+ while 19 auto-compactions
 * erased the "already done" memory after every handful of rounds).
 *
 * The watchdog only detects SILENCE; every ~7s event kept pushing its idle
 * deadline back forever. This detector complements it: busy progress without
 * progress (identical call + identical result, N times) is a dead loop even
 * though events flow steadily.
 *
 * Intervention model — the intervention lands at the NEXT identical call
 * (denied before execution, via the shared PreToolUse choke point):
 *
 *   call 1..N-1  identical (fingerprint + result digest) → recorded, no-op
 *   call N        → DENY: execution is blocked, the instructive message is
 *                   fed to the model as the tool result ("no progress — stop
 *                   repeating; decide the next distinct step or finish")
 *   calls N+1…    each identical retry re-triggers the deny; the streak
 *                   keeps growing so after `abortAfterExtraRepeats` more
 *                   the turn is hard-ABORTED (stall-abort attribution,
 *                   defense still evaluates the stop)
 *
 * Hard cap (one turn, first turn included — unlike the resume-chain
 * budget, which exempts the first turn):
 *   - `maxTurnToolCalls`   total tool calls in one turn (default 500)
 *
 * There is intentionally NO wall-clock cap: long legitimate turns
 * (multi-hour refactors / test runs) must not be killed just for taking
 * time. No-progress busy loops are caught by the repeat-fingerprint streak
 * logic instead, which only fires on repeated IDENTICAL calls with
 * identical results. The cap default is tuned to sit above legitimate
 * heavy turns (tens to low hundreds of calls) while still bounding
 * pathological busy loops (the incident loop ran 250+ identical
 * iterations in ~1h).
 *
 * Env-tunable: CRAFT_PI_MAX_TURN_TOOL_CALLS.
 */
import type { ToolCallLike } from './complexity-score.ts';

export interface ToolLoopIntervention {
  level: 'deny' | 'abort';
  /** Instructive text fed back to the model (deny) or surfaced to the user (abort). */
  message: string;
  /** How many consecutive identical calls (including this one) are in flight. */
  repeats: number;
  /** When set by a busy-abort, the host should mark the stop as system-initiated. */
  interrupt?: () => void;
}

export interface ToolLoopDetectorOptions {
  /** Consecutive identical (fingerprint+result) calls before the next one is denied. Default 4. */
  repeatThreshold?: number;
  /** Additional denied repeats before hard abort. Default 2. */
  abortAfterExtraRepeats?: number;
  /** Hard cap of tool calls in ONE turn (first turn included). Default 500. */
  maxTurnToolCalls?: number;
}

const DEFAULTS: Required<ToolLoopDetectorOptions> = {
  repeatThreshold: 4,
  abortAfterExtraRepeats: 2,
  maxTurnToolCalls: Number(process.env.CRAFT_PI_MAX_TURN_TOOL_CALLS ?? 500),
};

/** Collapse whitespace so trivial formatting differences don't split fingerprints. */
export function normalizeCommand(cmd: string): string {
  return cmd.trim().replace(/\s+/g, ' ');
}

/**
 * Stable fingerprint of a tool call: name + identifying args.
 *
 * Bash: the normalized command is the whole identity. Other tools: all
 * non-underscore (non-UI-metadata) args, sorted and string-truncated.
 *
 * NOTE on statelessness: two identical calls to state-dependent tools can
 * legitimately differ (e.g. reading a file between edits) — the detector keys
 * on CONSECUTIVE identical (fingerprint + result digest) pairs, so a genuine
 * state change produces a different result digest and resets the streak.
 */
export function fingerprintToolCall(
  call: ToolCallLike & { args?: Record<string, unknown> },
): string {
  const name = (call.type || 'unknown').toLowerCase();
  if (name === 'bash') return `bash:${normalizeCommand(call.command ?? '')}`;
  const args = call.args;
  if (args && Object.keys(args).length > 0) {
    const keys = Object.keys(args).filter((k) => !k.startsWith('_')).sort();
    const parts = keys.map((k) => {
      let v: string;
      try {
        v = JSON.stringify(args[k]);
      } catch {
        v = String(args[k]);
      }
      if (v.length > 200) v = `${v.slice(0, 200)}…`;
      return `${k}=${v}`;
    });
    return `${name}:${parts.join('|')}`;
  }
  return name;
}

/**
 * Digest of a completed tool result: enough to tell "same output" apart
 * without keeping full results around. Errors digest to a constant — an
 * erroring call never builds a no-progress streak on its own (the next
 * identical-fingerprint success/error pair is compared against it).
 */
export function digestResult(result: string | undefined, isError: boolean): string {
  if (isError) return 'error';
  const norm = (result ?? '').replace(/\s+/g, ' ').trim();
  if (!norm) return '(empty)';
  return `${norm.length}:${norm.slice(0, 128)}`;
}

export class ToolLoopDetector {
  private readonly opts: Required<ToolLoopDetectorOptions>;
  private turnToolCallCount = 0;
  private lastFingerprint = '';
  private lastResultDigest = '';
  private consecutiveRepeats = 0;

  constructor(options: ToolLoopDetectorOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
  }

  /** Called at the start of every turn (handlePrompt). */
  resetTurn(): void {
    this.turnToolCallCount = 0;
    this.lastFingerprint = '';
    this.lastResultDigest = '';
    this.consecutiveRepeats = 0;
  }

  /**
   * Call before executing a tool (PreToolUse choke point).
   * Returns the intervention that should PREVENT this call:
   * - abort: busy call-count cap or repeated denies
   * - deny: this call would be the Nth consecutive identical repetition
   */
  recordStart(call: ToolCallLike & { args?: Record<string, unknown> }): ToolLoopIntervention | null {
    this.turnToolCallCount += 1;
    if (this.turnToolCallCount > this.opts.maxTurnToolCalls) {
      return {
        level: 'abort',
        message: `Turn aborted: exceeded ${this.opts.maxTurnToolCalls} tool calls in one turn (busy-limit guardrail).`,
        repeats: this.turnToolCallCount,
      };
    }

    const fp = fingerprintToolCall(call);
    if (fp !== this.lastFingerprint) return null;

    // Same fingerprint as the streak head: this call would extend the run.
    const streak = this.consecutiveRepeats + 1;
    const denyThreshold = this.opts.repeatThreshold;
    const abortStreak = denyThreshold + this.opts.abortAfterExtraRepeats;
    if (streak >= abortStreak) {
      this.consecutiveRepeats = streak;
      return {
        level: 'abort',
        message: `Turn aborted: ${streak} consecutive identical tool calls with no progress.`,
        repeats: streak,
      };
    }
    if (streak >= denyThreshold) {
      this.consecutiveRepeats = streak;
      return {
        level: 'deny',
        message:
          `BLOCKED: this exact call was already executed ${streak - 1} times in a row with identical results — no progress. ` +
          `Do NOT repeat it. Summarize what the identical outputs already established, decide the NEXT distinct step, or finish the task.`,
        repeats: streak,
      };
    }
    return null;
  }

  /**
   * Call at tool_execution_end with the call's fingerprint (cached at start)
   * and the result digest. Pure state update — interventions happen at the
   * next call's recordStart.
   */
  recordCompletion(fingerprint: string, resultDigest: string): void {
    if (fingerprint === this.lastFingerprint && resultDigest === this.lastResultDigest) {
      this.consecutiveRepeats += 1;
    } else {
      this.consecutiveRepeats = 1;
      this.lastFingerprint = fingerprint;
      this.lastResultDigest = resultDigest;
    }
  }
}

/**
 * P2 guard (optional plan item 5): a built-in tool invoked with an empty
 * parameter object (e.g. `{ command: {} }`) fails upstream schema
 * validation with a cryptic "Validation failed for tool bash". Feed the
 * model an instructive result instead — usually the task is already done
 * and the model should stop calling tools. Applies to BUILT-IN tools only
 * (proxy/MCP tools may legitimately have an empty schema).
 */
export function isEmptyArgs(input: Record<string, unknown> | null | undefined): boolean {
  // Underscore-prefixed keys are craft-metadata transport (e.g. _displayName
  // / _intent) — not real tool arguments. A call carrying ONLY metadata
  // counts as empty.
  if (!input) return true;
  return !Object.keys(input).some((k) => !k.startsWith('_'));
}

export function shouldRejectEmptyArgs(toolName: string, input: Record<string, unknown> | null | undefined): boolean {
  if (toolName.startsWith('mcp__')) return false;
  return isEmptyArgs(input);
}

export function emptyArgsMessage(toolName: string): string {
  return (
    `Validation failed for tool '${toolName}': you sent an empty parameter object. ` +
    `Either call it with the arguments from its schema, or — if the task is already complete — ` +
    `stop calling tools, summarize the result, and finish the turn.`
  );
}
