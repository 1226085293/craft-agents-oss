/**
 * Layer 2 — Session Lifecycle
 *
 * Finite state machine for post-stop evaluation and resume.
 *
 * Resume means appending "evaluation result + incomplete items" to the SAME
 * session transcript (not rebuilding context). Guardrails prevent infinite
 * resume loops and no-progress (stuck) resumes.
 */

export enum State {
  IDLE = 'idle',
  RUNNING = 'running',
  EVALUATING = 'evaluating',
  RESUME_READY = 'resume_ready',
  RESUMING = 'resuming',
  DONE = 'done',
  FAILED = 'failed',
  ABORTED = 'aborted',
}

const TRANSITIONS: Record<State, State[]> = {
  // IDLE -> ABORTED: the user can stop a turn before any tool call runs;
  // an explicit abort must be representable from every non-terminal state.
  [State.IDLE]: [State.RUNNING, State.ABORTED],
  [State.RUNNING]: [State.EVALUATING, State.DONE, State.FAILED, State.ABORTED],
  [State.EVALUATING]: [State.RESUME_READY, State.DONE, State.FAILED],
  [State.RESUME_READY]: [State.RESUMING],
  [State.RESUMING]: [State.EVALUATING, State.DONE, State.FAILED, State.ABORTED],
  [State.DONE]: [],
  [State.FAILED]: [],
  [State.ABORTED]: [],
};

export interface SessionLifecycleOptions {
  /** Maximum number of resume attempts before FAILED. */
  maxResumes?: number;
  /** Maximum total tool iterations before ABORTED. */
  maxIterations?: number;
  /** Maximum wall-clock duration in ms before ABORTED. */
  maxDurationMs?: number;
}

/** Simple deterministic hash (FNV-1a) for resume-context fingerprints. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export class SessionLifecycle {
  private state: State;
  private resumeCount = 0;
  private iterations = 0;

  private lastResumeHash: string | null = null;
  private startedAt: number;
  /**
   * Ladder lane (2026-10-06): while the MAIN-PROCESS RETRY LADDER owns the
   * recovery of empty terminal responses, the 24h retry loop must not be
   * cut short by the defense chain caps (maxIterations/maxDurationMs
   * anchor at the first resume) — those caps bound FOLLOWUP resume chains,
   * not ladder retries. The flag is set per-turn by the evaluator; it does
   * not suppress terminal states (DONE/FAILED/ABORTED still win).
   */
  private ladderLaneActive = false;
  /** Wall-clock time of the FIRST resume in the current chain (null until
   *  then). The loop-bounding guardrails measure against THIS, not the turn
   *  start: a long healthy first segment (20+ min research with browser
   *  tools) must not eat into the resume budget — the caps exist to bound
   *  RESUME LOOPS, and the chain only begins once the first resume fires.
   *  See the 2026-08-23 incident: a 320 s turn was aborted on the 300 s
   *  cap even though the resumed segment itself was only ~3 min and healthy. */
  private chainStartedAt: number | null = null;
  /** Tool iterations counted SINCE the first resume (chain-local). */
  private chainIterations = 0;
  private readonly maxResumes: number;
  private readonly maxIterations: number;
  private readonly maxDurationMs: number;

  constructor(options: SessionLifecycleOptions = {}) {
    this.state = State.IDLE;
    this.maxResumes = options.maxResumes ?? 3;
    this.maxIterations = options.maxIterations ?? 50;
    this.maxDurationMs = options.maxDurationMs ?? 300_000;
    this.startedAt = Date.now();
  }

  getState(): State {
    return this.state;
  }

  /**
   * Enable the ladder lane for this turn: chain caps no longer bound
   * post-resume stops (the main retry ladder owns the schedule/cap for
   * empty-response recovery). Idempotent; cleared on reset.
   */
  markLadderLane(): void {
    this.ladderLaneActive = true;
  }

  /**
   * Ladder handoff (2026-10-06): advance the FSM to RESUME_READY WITHOUT
   * consuming a resume slot — the retry is driven by the main-process
   * ladder (its own 1s/5s/10s/30s/60s/5m/10m schedule + 24h cap), not the
   * defense chain budget. The next post-stop evaluation re-enters via
   * RESUMING → EVALUATING exactly like a followUp resume.
   *
   * IDEMPOTENT (2026-10-16, 261016-soft-channel): a turn can hit the ladder
   * lane MORE THAN ONCE — each empty terminal response routes through this
   * handoff. The second round finds the FSM already parked at RESUME_READY
   * (the first handoff's state, never left because the ladder — not
   * markResumed — owns the continuation), and the old code called
   * transition(RESUME_READY) from RESUME_READY, which TRANSITIONS forbids
   * (RESUME_READY only allows → RESUMING). That threw
   * `Illegal state transition: resume_ready -> resume_ready`, the evaluator
   * caller swallowed it, and the main process never received the error event
   * that arms the retry ladder — the ladder stalled on "重试 1 次后恢复"
   * with no further retries. Re-entering the same lane is a no-op by
   * construction, so return the current state instead of transitioning.
   */
  markLadderHandoff(): State {
    if (this.isTerminal()) return this.state;
    // Already parked in this lane — re-entry is a no-op, not a new handoff.
    if (this.state === State.RESUME_READY) return this.state;
    if (this.state === State.IDLE) this.transition(State.RUNNING);
    if (this.state === State.RUNNING) this.transition(State.EVALUATING);
    if (this.state === State.EVALUATING) return this.transition(State.RESUME_READY);
    // From RESUMING (or any other non-terminal state): take the normal
    // evaluate path back into RESUME_READY, mirroring a followUp resume.
    if (this.state === State.RESUMING) this.transition(State.EVALUATING);
    return this.transition(State.RESUME_READY);
  }

  /**
   * Ladder re-issue (2026-10-18, 261017-copper-copper): the FSM was parked at
   * RESUME_READY by markLadderHandoff(), and the main-process retry ladder has
   * now re-issued the model step (`retry` command → agent.continue()). That
   * re-issue IS the resume the handoff deferred, so advance RESUME_READY →
   * RESUMING; the retried run's post-stop evaluation then re-enters through
   * the normal RESUMING → EVALUATING path.
   *
   * Without this the FSM stayed parked at RESUME_READY for the whole retried
   * run, and the next evaluation crashed with
   * `Illegal state transition: resume_ready -> resume_ready` (the reply had
   * already been delivered; the crash was routed into the retry ladder, which
   * can never re-run a real reply — the turn hung until the user stopped it).
   *
   * No-op in every other state: a plain stream-error retry never parked the
   * FSM (the turn is still RUNNING) and must keep its normal path.
   *
   * @returns true when the FSM was parked at RESUME_READY and was advanced.
   */
  markLadderResumed(): boolean {
    if (this.state !== State.RESUME_READY) return false;
    this.transition(State.RESUMING);
    return true;
  }

  getResumeCount(): number {
    return this.resumeCount;
  }

  getIterations(): number {
    return this.iterations;
  }

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  isTerminal(): boolean {
    return this.state === State.DONE || this.state === State.FAILED || this.state === State.ABORTED;
  }

  private transition(next: State): State {
    const allowed = TRANSITIONS[this.state];
    if (!allowed.includes(next)) {
      throw new Error(`Illegal state transition: ${this.state} -> ${next}`);
    }
    this.state = next;
    return this.state;
  }

  /**
   * Whether the turn is inside a resume chain (an automatic defense resume
   * has already happened). The iteration/duration guardrails exist to bound
   * RESUME LOOPS, not to police healthy single turns — a long serial tool
   * chain (20+ min builds) must keep full protection instead of silently
   * losing it at the cap. Stall detection (silence-based kill in the host)
   * already bounds runaway turns.
   */
  private inResumeChain(): boolean {
    if (this.ladderLaneActive && !this.isTerminal()) return false;
    return this.chainStartedAt !== null || this.resumeCount > 0;
  }

  /** Chain-local wall-clock budget consumed since the first resume. */
  private chainElapsedMs(): number {
    return this.chainStartedAt === null ? 0 : Date.now() - this.chainStartedAt;
  }

  /** Record a tool call iteration. ABORTs only when a resume loop exceeds its budget. */
  recordIteration(): State {
    if (this.isTerminal()) return this.state;
    if (this.state === State.IDLE) {
      this.transition(State.RUNNING);
    }
    this.iterations += 1;
    // Guardrails apply only inside resume chains: the first turn is
    // unbounded (bounded by stall detection instead). See inResumeChain().
    if (!this.inResumeChain()) {
      return this.state;
    }
    // Count chain-local iterations only — pre-resume tool calls are part of
    // the (unbounded) first segment, not the resume loop.
    if (this.chainStartedAt !== null) {
      this.chainIterations += 1;
    }
    if (this.chainIterations > this.maxIterations) {
      return this.transition(State.ABORTED);
    }
    if (this.chainElapsedMs() > this.maxDurationMs) {
      return this.transition(State.ABORTED);
    }
    return this.state;
  }

  /**
   * Called when the agent stops. Returns 'run' if the stop is normal,
   * 'evaluate' if post-stop evaluation must run, or 'abort' if guardrails fired.
   *
   * `complexityNeedsEvaluation` should be the concrete early-stop signal
   * (wrote without read-back) — high complexity alone does not force evaluation.
   */
  onStop(complexityNeedsEvaluation: boolean): 'run' | 'evaluate' | 'abort' {
    if (this.isTerminal()) return 'abort';
    // Same policy as recordIteration(): caps bound resume chains only, and
    // the chain budget is measured from the FIRST resume — a long first
    // segment never counts against the loop caps.
    if (this.inResumeChain() &&
        (this.chainIterations > this.maxIterations || this.chainElapsedMs() > this.maxDurationMs)) {
      this.transition(State.ABORTED);
      return 'abort';
    }
    if (this.state === State.RESUMING) {
      // After a resume turn, always evaluate again to decide whether done.
      this.transition(State.EVALUATING);
      return complexityNeedsEvaluation ? 'evaluate' : 'run';
    }
    if (this.state === State.IDLE) {
      this.transition(State.RUNNING);
    }
    if (complexityNeedsEvaluation) {
      if (this.state === State.RUNNING) {
        this.transition(State.EVALUATING);
      }
      return 'evaluate';
    }
    return 'run';
  }

  /**
   * Decide whether to resume given the resume context.
   * - Returns RESUME_READY when a resume is allowed.
   * - Returns FAILED when the resume cap is reached or the context shows no
   *   progress (fault-lane recovery only).
   *
   * `opts.verificationLane` (2026-10-12): verification-class follow-ups
   * bypass BOTH FAILED gates — the no-progress hash check AND the maxResumes
   * cap — and do not consume a resume slot. Verification is a delivery
   * iteration, not a recovery budget: a FAILed judge resumes with the SAME
   * delivery-step message, and that verify→repair→re-verify iteration is
   * unbounded by design (it ends on PASS → replay delivery, a genuine
   * fault-class stop, the user stopping the turn, or the chain guardrails
   * below). The chain budget is still anchored on the first resume so the
   * time/iteration fail-safes keep governing an endless re-verify loop.
   */
  decideResume(resumeContext: string, opts?: { verificationLane?: boolean }): State {
    // 2026-10-18 (261017-copper-copper): defensive normalization — the ladder
    // handoff parks the FSM at RESUME_READY while the MAIN-PROCESS ladder owns
    // the continuation (it never calls markResumed). If a post-stop evaluation
    // reaches this decision from that parked state (e.g. the retried run ended
    // with a real reply and a long-turn verification signal), the final
    // transition(RESUME_READY) — or a cap-driven transition(FAILED) — is
    // illegal from RESUME_READY and threw, derailing an already-delivered turn
    // into the retry ladder. Normalize to the EVALUATING position the caller
    // would have been in had onStop() run after a resume; every path below is
    // then legal. (markLadderResumed() in the retry path makes this
    // unreachable in normal operation; this guard keeps the FSM contract from
    // turning a coding bug into a hung turn.)
    if (this.state === State.RESUME_READY) {
      this.transition(State.RESUMING);
      this.transition(State.EVALUATING);
    }
    const hash = fnv1a(resumeContext);
    const lane = opts?.verificationLane === true;
    if (!lane && this.resumeCount >= this.maxResumes) {
      return this.transition(State.FAILED);
    }
    if (!lane && this.lastResumeHash === hash) {
      // Same context resumed twice → no progress → fail instead of looping.
      return this.transition(State.FAILED);
    }
    this.lastResumeHash = hash;
    if (!lane) this.resumeCount += 1;
    // Anchor the chain budget at the FIRST resume (both lanes): from here on,
    // iterations and wall-clock time count toward the loop caps.
    if (this.chainStartedAt === null) {
      this.chainStartedAt = Date.now();
      this.chainIterations = 0;
    }
    return this.transition(State.RESUME_READY);
  }

  /** Mark that a resume message has been appended to the session. */
  markResumed(): State {
    return this.transition(State.RESUMING);
  }

  /** Normal completion. */
  markDone(): State {
    return this.transition(State.DONE);
  }

  /** Failure. */
  markFailed(): State {
    return this.transition(State.FAILED);
  }

  /**
   * User-initiated abort. Terminal for this turn: no post-stop evaluation,
   * no resume — an explicit stop must never be overridden by heuristics.
   */
  markAborted(): State {
    if (this.isTerminal()) return this.state;
    return this.transition(State.ABORTED);
  }

  /**
   * Reset the FSM to a fresh IDLE state for a new prompt turn.
   * Clears counters and re-anchors the start timestamp.
   */
  reset(): void {
    this.state = State.IDLE;
    this.resumeCount = 0;
    this.iterations = 0;
    this.lastResumeHash = null;
    this.startedAt = Date.now();
    this.chainStartedAt = null;
    this.chainIterations = 0;
  }
}
