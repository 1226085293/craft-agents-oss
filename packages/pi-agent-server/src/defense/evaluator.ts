/**
 * DefenseEvaluator
 *
 * Orchestrates Layer 2 post-stop evaluation:
 * - signal detection → whether a post-stop check is needed (fault-class
 *   early stops + forced long-turn verification)
 * - session-lifecycle → FSM + resume guardrails
 *
 * Layer 1 (system-discipline) is applied at prompt-build time via
 * withExecutionDiscipline(); Layer 3 (idle-word regex) was removed per
 * issue #1 — regex cannot judge semantics and produced false positives.
 */

import { type ToolCallLike } from './complexity-score.ts';
import { SessionLifecycle, State, type SessionLifecycleOptions } from './session-lifecycle.ts';

export interface DefenseEvaluationResult {
  /** Whether the post-stop evaluation ran. */
  evaluated: boolean;
  /** Whether a resume is required (early-stop suspected — fault-class signal). */
  shouldResume: boolean;
  /** Human-readable resume message to append to the session. */
  resumeMessage?: string;
  /**
   * Verification-class signal: the turn finished with content that must be
   * semantically verified before delivery (wrote-without-readback, or a
   * force-verified long turn). The caller runs a program-side verification
   * check: PASS → replay the captured final text as the single reply;
   * FAIL → only then queue the follow-up (shouldResume semantics apply).
   */
  verifyRequired?: boolean;
  /** Why verification is required (diagnostics / UI). */
  verifyReason?: string;
  /** Final FSM state after evaluation. */
  state: State;
  /** Failure reason when state === FAILED. */
  failureReason?: string;
  /** Which signal(s) triggered the resume decision (diagnostics). */
  reason?: string;
  /**
   * True when the resume decision is owned by the MAIN-PROCESS RETRY LADDER
   * (empty terminal response, 2026-10-06 spec): the caller must NOT queue a
   * defense followUp — instead it emits an error event so the ladder arms,
   * and the ladder's re-issue strips the empty assistant message and
   * re-runs the model step. This decision did not consume a resume slot.
   */
  emptyResponseOwned?: boolean;
}

export interface DefenseOptions extends SessionLifecycleOptions {
  /** Master switch. When false, DefenseEvaluator is a no-op. */
  enabled?: boolean;
  /**
   * Route EMPTY terminal responses (clean stop with no visible text) to the
   * MAIN-PROCESS RETRY LADDER instead of the defense followUp lane
   * (2026-10-06 spec: all model-layer failures enter the retry mechanism).
   * An empty terminal response is a transient upstream fault — the ladder
   * re-issues the SAME model step (strip + continue) on its
   * 1s/5s/10s/30s/60s/5m/10m schedule with the 24h loop cap, while
   * content-quality faults (repetition loop, truncation)
   * stay on the defense followUp lane.
   * Ladder-routed empty responses do NOT consume a defense resume slot, so
   * the 24h retry loop is not cut short by maxResumes.
   */
  ladderOwnsEmptyResponse?: boolean;
  /**
   * Verification-class thresholds (user-configurable; defaults below).
   * A turn that meets EITHER threshold is treated as a long turn and gets a
   * forced program-side final-reply verification (the only verify-class
   * trigger now; the write-without-readback signal was removed).
   * - minSteps: tool/activity count in the turn (the number of process-card
   *   rows the UI shows) — default 50.
   * - minDurationMs: elapsed wall-clock in the turn — default 5 minutes.
   */
  verifyMinSteps?: number;
  verifyMinDurationMs?: number;
}

const DEFAULT_VERIFY_MIN_STEPS = 50;
const DEFAULT_VERIFY_MIN_DURATION_MS = 5 * 60 * 1000;

/**
 * User-facing stop notice for defense FAILED stops (2026-10-04
 * polished-canyon): when the post-stop evaluation ends a turn WITHOUT
 * recovery (state=failed, resume cap exhausted), the main process must be
 * told WHY — otherwise the UI process block ends silently, with no reason
 * shown (unlike a manual stop, which at least says "Response
 * interrupted"). Returns null for recoverable / non-terminal results so
 * healthy stops stay silent.
 */
export function buildDefenseStopNotice(
  result: Pick<DefenseEvaluationResult, 'state' | 'shouldResume' | 'verifyRequired' | 'reason' | 'failureReason'>,
): { reason: string; message: string } | null {
  if (result.state !== State.FAILED || result.shouldResume || result.verifyRequired) return null;
  return {
    reason: result.reason || 'defense_failed',
    message: `Automatic recovery unavailable — the automatic recovery attempts for this turn are exhausted. The turn has stopped without a final response; send a message to continue.`,
  };
}

export class DefenseEvaluator {
  private readonly enabled: boolean;
  private readonly lifecycle: SessionLifecycle;
  private readonly verifyMinSteps: number;
  private readonly verifyMinDurationMs: number;
  /** Ladder lane (2026-10-06): empty terminal responses are owned by the main retry ladder. */
  private readonly ladderOwnsEmptyResponse: boolean;
  private toolCalls: ToolCallLike[] = [];

  constructor(options: DefenseOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.lifecycle = new SessionLifecycle(options);
    this.verifyMinSteps = options.verifyMinSteps ?? DEFAULT_VERIFY_MIN_STEPS;
    this.verifyMinDurationMs = options.verifyMinDurationMs ?? DEFAULT_VERIFY_MIN_DURATION_MS;
    this.ladderOwnsEmptyResponse = options.ladderOwnsEmptyResponse ?? false;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Whether a post-stop evaluation is safe to run right now.
   * Returns false when disabled or when the lifecycle is already terminal
   * (a previous agent_end in the same turn settled the FSM).
   */
  canEvaluate(): boolean {
    return this.enabled && !this.lifecycle.isTerminal();
  }

  /** Record a tool call for scoring. No-op when disabled. */
  recordToolCall(call: ToolCallLike): void {
    if (!this.enabled) return;
    this.toolCalls.push(call);
    this.lifecycle.recordIteration();
  }

  /** Record a bash command (convenience wrapper). */
  recordBash(command: string): void {
    this.recordToolCall({ type: 'bash', command });
  }

  /** Reset tool-call buffer for a new turn. */
  resetTurn(): void {
    this.toolCalls = [];
    this.lifecycle.reset();
  }

  /** Human-readable summary of which resume signal(s) fired (diagnostics). */
  private describeSignals(
    silentStop: boolean,
    emptyResponse: boolean,
    repetitionLoop: boolean,
    truncatedFinal: boolean,
    verifyRequired = false,
  ): string {
    const parts: string[] = [];
    if (silentStop) parts.push('silentStop');
    if (emptyResponse) parts.push('emptyResponse');
    if (repetitionLoop) parts.push('repetitionLoop');
    if (truncatedFinal) parts.push('truncatedFinal');
    if (verifyRequired) parts.push('verify');
    return parts.join('+') || 'none';
  }

  /**
   * Post-stop evaluation. Returns whether a resume should be queued.
   *
   * `lastAssistantMessage` is the final assistant message from agent_end
   * (when available). A turn whose assistant produced no visible text and
   * was not user-aborted is treated as a silent stop — the strongest
   * early-stop signal there is, regardless of tool history.
   *
   * `endsWithEmptyResponse` flags the pathological case where the FINAL
   * assistant message carries NO visible content at all. Observed variants:
   * finish_reason=stop with 0 output tokens (gateway fault); finish_reason=
   * length with output burned on invisible reasoning (max_tokens
   * truncation); and finish_reason=stop with thinking-only content (the
   * 2026-10-01 incidents, 261001-ready-sunset / 261001-calm-pond: a clean
   * stop that emitted only a reasoning block the user can never see).
   * All are silent deliveries, not real completions. Unlike silent-stop
   * (which scans the whole run), this signal anchors strictly on the last
   * message: earlier progress updates in a long tool chain must not mask
   * it (2026-08-22 incidents).
   *
   * `hasRepetitionLoop` flags the degeneration case where the FINAL
   * assistant message carries text, but that text devolved into a
   * repetition loop (a large share of exact-duplicate lines/sentences).
   * Such a reply is a model failure, not an answer — it must resume like
   * an empty response (2026-08-28 incident: 213K chars of 874 repeats).
   *
   * `truncatedFinal` flags the case where the FINAL assistant message hit
   * the max_tokens cap (stopReason='length') AFTER emitting some visible
   * text — the reply was cut off mid-sentence and is likely incomplete.
   * endsWithEmptyResponse misses this (it needs NO visible block), so
   * truncation is its own early-stop signal (2026-10-01 incident: a final
   * reply truncated to `...用户要的是"连` was delivered as-is).
   */
  evaluate(lastAssistantMessage?: {
    hasVisibleText: boolean;
    /** Whether the terminal assistant message has visible text suitable for verification delivery. */
    hasFinalText?: boolean;
    /** Pi SDK stop reason; upstream errors must not enter post-stop recovery. */
    stopReason?: string;
    aborted: boolean;
    endsWithEmptyResponse?: boolean;
    hasRepetitionLoop?: boolean;
    /** True when the final hit the max_tokens cap (stopReason='length'). */
    truncatedFinal?: boolean;
    /** True when the abort was issued by the stall watchdog, not the user. */
    stallAborted?: boolean;
  }): DefenseEvaluationResult {
    if (!this.enabled) {
      return { evaluated: false, shouldResume: false, state: State.IDLE };
    }

    const stallAborted = lastAssistantMessage?.stallAborted === true;

    // Transport/provider errors are not candidate replies. Let the SDK retry
    // lane or its terminal error own this outcome; running Defense here could
    // turn an EOF into a misleading verification/recovery turn.
    if (lastAssistantMessage?.stopReason === 'error') {
      return { evaluated: false, shouldResume: false, state: this.lifecycle.getState() };
    }

    // P0 guardrail (2026-08-22): a user abort is an explicit intent to stop.
    // It must short-circuit EVERY resume signal — not just silentStop. Before
    // this guard, a turn aborted mid-task with an empty final reply (or any
    // other early-stop signal) was automatically resumed via followUp(), reviving a
    // task the user had deliberately stopped and letting it keep mutating
    // files. Abort wins over all heuristics.
    //
    // Stall-watchdog exception (2026-09-08 fit-pulsar incident): the watchdog
    // kills stalled turns via session.abort(), stamping the identical
    // stopReason='aborted'. That abort is an infrastructure fault, NOT user
    // intent — treat it as an early-stop signal and evaluate (guardrails
    // below still bound resumes).
    if (lastAssistantMessage?.aborted === true && !stallAborted) {
      this.lifecycle.markAborted();
      return {
        evaluated: true,
        shouldResume: false,
        state: this.lifecycle.getState(),
      };
    }

    // Silent-stop detection: the turn ended without any assistant-visible
    // text. The user sees nothing — indistinguishable from a hang. Not
    // triggered on user aborts (that's intentional interruption) — but a
    // stall-watchdog abort IS such a hang (system-initiated, not intent), so
    // it triggers silent stop like any other infra fault.
    const silentStop =
      lastAssistantMessage != null
      && !lastAssistantMessage.hasVisibleText
      && (!lastAssistantMessage.aborted || stallAborted);

    // Empty terminal response: the very last model call returned zero tokens
    // with a clean stop — an infrastructure fault, not an intentional finish.
    // Independent of silentStop because long tool chains legitimately produce
    // progress text early, which makes run-wide hasVisibleText useless here.
    const emptyResponse = lastAssistantMessage?.endsWithEmptyResponse === true;

    // Degeneration loop: the final message is full of repeated text. Carries
    // visible text, so silentStop/emptyResponse miss it; the reply is a
    // model failure and must trigger a resume just like an empty response.
    const repetitionLoop = lastAssistantMessage?.hasRepetitionLoop === true;

    // Truncated-but-non-empty final (2026-10-01 incident): the reply hit the
    // max_tokens cap (stopReason='length') AFTER emitting some visible text,
    // so it was cut off mid-sentence. endsWithEmptyResponse misses this (it
    // needs NO visible block); the truncation is a genuine early-stop and the
    // reply must be completed, not delivered as-is.
    const truncatedFinal = lastAssistantMessage?.truncatedFinal === true;

    // Fault-class signals: genuine early-stop infrastructure faults (stall
    // kill, no visible text, empty terminal model call, degeneration loop,
    // mid-sentence truncation). These keep the
    // ORIGINAL LLM-completion flow: a followUp resume message asks the model
    // to finish/repair the reply. Verification NEVER applies to fault class
    // — there is no finished content to verify.
    const faultClass =
      stallAborted || silentStop || emptyResponse || repetitionLoop || truncatedFinal;

    // Verification-class signal (user decision, 2026-10-05): a FORCED long
    // turn — the turn met EITHER threshold (step count ≥ verifyMinSteps OR
    // elapsed ≥ verifyMinDurationMs; OR semantics, configurable). This is
    // the ONLY verification-class trigger now; a plain write-without-
    // read-back no longer forces verification (S1 removed). These are NOT
    // faults: the content may be fine. Instead of blindly resuming, the turn
    // gets a program-side verification: an LLM check on whether the final
    // reply is a valid answer to the user's message. PASS → the captured
    // final text is replayed AS the single final reply (no second LLM
    // bubble); FAIL → only then follow up (LLM continues).
    const longTurn =
      this.lifecycle.getIterations() >= this.verifyMinSteps
      || this.lifecycle.elapsedMs() >= this.verifyMinDurationMs;
    // Legacy direct evaluator callers provide hasVisibleText only. The Pi
    // server passes hasFinalText explicitly so earlier commentary/tool-call
    // text can never be mistaken for a terminal candidate.
    const hasFinalText = lastAssistantMessage?.hasFinalText ?? lastAssistantMessage?.hasVisibleText ?? false;
    // Verification-class signal (user decision, 2026-10-12): as long as the
    // stop satisfies the verification conditions — a deliverable final
    // candidate, not a fault, and the long-turn threshold met — verification
    // fires, WITHOUT a per-turn attempt budget (the 2026-10-05
    // "verify-once-per-turn" cap is removed). A FAILed verification resumes
    // via followUp and the repair round gets verified AGAIN — the long-turn
    // signal is a TURN-LEVEL accumulator (iterations/elapsed only grow), so
    // every qualifying stop re-enters verification until the reply passes.
    // There is NO verification attempt limit: the verification lane consumes
    // no recovery slot and bypasses the maxResumes gate (see decideResume);
    // the loop ends only on PASS → replay delivery, a genuine fault-class
    // stop, the user stopping the turn, or the chain time/iteration caps.
    const verifyRequired = hasFinalText && !faultClass && longTurn;
    // If a verification signal fires without a deliverable final candidate,
    // preserve the ordinary follow-up recovery path instead of opening a
    // program-side verification hold.
    const resumeWithoutCandidate = !hasFinalText && longTurn;

    // A stall-watchdog abort is itself an early-stop signal: the turn was
    // killed mid-flight, so evaluation must run even when no other signal
    // fired (e.g. visible text was already produced earlier in the run).
    const needsEvaluation =
      faultClass || verifyRequired || resumeWithoutCandidate;
    const stop = this.lifecycle.onStop(needsEvaluation);

    if (stop === 'abort') {
      return {
        evaluated: false,
        shouldResume: false,
        state: State.ABORTED,
      };
    }

    // Rule-based evaluation: only concrete early-stop signals warrant an
    // automatic resume — a fault-class early stop (silent stop with no
    // output, empty terminal reply, repetition loop, truncation, or a
    // stall-watchdog kill) or a forced long-turn
    // verification. stallAborted bypasses this gate even when visible text
    // was produced earlier in the run (faultClass covers it): the watchdog
    // killed a mid-flight turn, so "already said something" must not read
    // as done.
    if (stop === 'run' || (!faultClass && !verifyRequired && !resumeWithoutCandidate)) {
      this.lifecycle.markDone();
      return {
        evaluated: true,
        shouldResume: false,
        state: this.lifecycle.getState(),
      };
    }

    // needsEvaluation: build resume context and decide. Verification runs on
    // its own lane (verificationLane): it does NOT consume a recovery slot
    // and bypasses both FAILED gates (maxResumes + no-progress hash) — a
    // FAILed verification resumes (repair → re-verify) indefinitely until
    // the reply passes, a fault-class stop takes over, the user stops the
    // turn, or the chain guardrails (time/iteration caps) fire.
    const resumeMessage = buildResumeMessage(silentStop, emptyResponse, repetitionLoop, truncatedFinal, stallAborted);

    // Ladder lane (2026-10-06 spec: all model-layer failures enter the
    // retry mechanism): an EMPTY terminal response is a transient upstream
    // fault — route it to the MAIN-PROCESS RETRY LADDER instead of the
    // defense followUp lane. The caller emits an error event (ladder arms)
    // and the ladder's re-issue strips the empty assistant message and
    // re-runs the SAME model step on its 1s/5s/10s/30s/60s/5m/10m
    // schedule (24h loop cap). Content-quality faults (repetition loop,
    // truncation) keep the followUp lane.
    // The ladder handoff consumes no defense resume slot, so the retry
    // loop is not cut short by maxResumes.
    const ladderLane =
      this.ladderOwnsEmptyResponse &&
      emptyResponse &&
      !repetitionLoop &&
      !truncatedFinal &&
      !stallAborted;
    if (ladderLane) {
      this.lifecycle.markLadderLane();
      const ladderState = this.lifecycle.markLadderHandoff();
      return {
        evaluated: true,
        shouldResume: true,
        resumeMessage,
        emptyResponseOwned: true,
        state: ladderState,
        reason: this.describeSignals(silentStop, emptyResponse, repetitionLoop, truncatedFinal, false),
      };
    }

    const decision = this.lifecycle.decideResume(resumeMessage, verifyRequired ? { verificationLane: true } : undefined);
    if (decision === State.FAILED) {
      return {
        evaluated: true,
        shouldResume: false,
        state: State.FAILED,
        failureReason: 'Resume cap reached or no progress across consecutive resumes',
        reason: this.describeSignals(silentStop, emptyResponse, repetitionLoop, truncatedFinal, verifyRequired),
      };
    }

    this.lifecycle.markResumed();
    if (verifyRequired) {
      return {
        evaluated: true,
        shouldResume: false,
        verifyRequired: true,
        verifyReason: 'force-long-turn',
        resumeMessage,
        state: this.lifecycle.getState(),
        reason: this.describeSignals(silentStop, emptyResponse, repetitionLoop, truncatedFinal, verifyRequired),
      };
    }

    return {
      evaluated: true,
      shouldResume: true,
      resumeMessage,
      state: this.lifecycle.getState(),
      reason: this.describeSignals(silentStop, emptyResponse, repetitionLoop, truncatedFinal, verifyRequired),
    };
  }
}

/**
 * Build the verification-delivery resume message.
 *
 * Resume ≠ rerun: the message appends a **verification delivery** step to the
 * SAME session transcript.
 *
 * 2026-10-13 261013-mild-stream lesson — the previous wording asked the model
 * to "judge whether your final reply corresponds … if it does NOT correspond,
 * state the reason in one short line, then continue". Two bad outcomes were
 * observed on a real FAIL → resume cycle:
 *
 * 1. The model read "then continue" as "continue the investigation", and
 *    re-ran the four tool calls it had already completed minutes earlier in
 *    the SAME turn (grep/sed/head on the same targets) — ~1 minute of wasted
 *    work producing identical results.
 * 2. Instead of a clean reply, it produced META-NARRATION about its own
 *    delivery ("my previous final reply already fully delivered the original
 *    request … now adding the list of ..."). That narration is what the
 *    judge then saw and PASSed, so it was replayed verbatim as THE final
 *    reply: the user received a reply *about* the previous reply.
 *
 * The rewrite therefore inverts the framing: the FIRST instruction is "write
 * the complete final reply now", and the checklist operates on the CONTENT
 * (already answered? tools already run?) instead of on the delivery act. Two
 * explicit prohibitions are added and repeated for emphasis:
 * - do NOT narrate the verification/repair process (no "my previous reply
 *   ...", "now adding ...", "as requested earlier ...");
 * - do NOT re-run investigation steps already completed in this turn.
 *
 * Per-signal lines below remain judgment aids ("why this check fired"), not
 * new work orders: extra work happens only on the "does not correspond"
 * branch.
 */
function buildResumeMessage(
  silentStop: boolean,
  emptyResponse: boolean,
  repetitionLoop: boolean,
  truncatedFinal: boolean,
  stallAborted = false,
): string {
  const lines: string[] = [
    '[Defense] Verification delivery step — deliver, do NOT re-run the task.',
    `Write the COMPLETE final reply to the user's message NOW. Your output must be the ` +
      `reply itself, ready for the user to read — not a description of it.`,
    // P1-①: the meta-narration prohibition has to name the failure mode, or
    // the model keeps "reporting" on its delivery instead of delivering.
    `Do NOT write narration about the delivery process: no "my previous reply already ` +
      `delivered ...", no "now adding ...", no "in addition to what I said before ...". ` +
      `Just give the answer.`,
    // P0: "continue the task" read as "re-investigate from scratch" is what
    // duplicated the completed tool calls. Bound the resume to the DELTA.
    `You already did the research for this turn: the tool calls and searches you ran ` +
      `earlier in this conversation ARE done — use their results and do NOT run them ` +
      `again. Only fill a gap you can point to concretely.`,
    `If an earlier draft of your reply is already complete and correct, output that reply ` +
      `verbatim. Otherwise output the corrected/merged version in full — never a patch, ` +
      `diff, or "changes since last time".`,
    `Signals that triggered this verification step (context, not new work):`,
  ];
  if (stallAborted) {
    lines.push(
      `- Your turn was ABORTED BY THE SYSTEM (stall watchdog: no activity for a long time, ` +
      `a long-running tool was killed mid-execution) — NOT by the user. Your final reply ` +
      `is therefore incomplete and does NOT correspond. Check whether the interrupted work ` +
      `actually completed (files written, partial output, processes still running) before ` +
      `redoing anything, then continue the task from exactly where it left off. Prefer ` +
      `re-running the interrupted step in smaller, resumable pieces.`,
    );
  }
  if (emptyResponse) {
    lines.push(
      `- Your previous model call returned an EMPTY response (no visible content; ` +
      `likely an upstream fault or max_tokens truncation burning invisible reasoning) — ` +
      `NOT an intentional completion. No final reply exists to verify, so it does NOT ` +
      `correspond: report your current progress, then pick up exactly where you left off.`,
    );
  }
  if (repetitionLoop) {
    lines.push(
      `- Your previous reply devolved into a REPETITION LOOP (a large share of the output ` +
      `was exact-duplicate text) — a model degeneration, not an answer. It does NOT ` +
      `correspond to the user's message: give the user a concise, non-repetitive reply ` +
      `covering the outstanding points.`,
    );
  }
  if (truncatedFinal) {
    lines.push(
      `- Your previous reply was CUT OFF by the output token limit (max_tokens) — it ` +
      `likely ends mid-sentence or mid-thought and is incomplete. If it already fully ` +
      `answers the user's message, simply re-deliver it verbatim. Otherwise continue it ` +
      `from exactly where it was cut off (no redoing completed work, no new analysis ` +
      `beyond finishing the thought).`,
    );
  }
  if (silentStop) {
    lines.push(
      `- Your previous turn ended WITHOUT any visible reply to the user. No final reply ` +
      `exists to verify, so it does NOT correspond: report your current ` +
      `progress/status to the user now, then continue any remaining work.`,
    );
  }
  lines.push(`- Do NOT repeat already completed steps.`);
  return lines.join('\n');
}
