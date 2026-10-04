/**
 * DefenseEvaluator
 *
 * Orchestrates Layer 2 post-stop evaluation:
 * - complexity-score → whether evaluation is needed
 * - session-lifecycle → FSM + resume guardrails
 *
 * Layer 1 (system-discipline) is applied at prompt-build time via
 * withExecutionDiscipline(); Layer 3 (idle-word regex) was removed per
 * issue #1 — regex cannot judge semantics and produced false positives.
 */

import { complexityScore, type ToolCallLike } from './complexity-score.ts';
import { FsWatch, type FsWriteEvidence } from './fs-watch.ts';
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
}

export interface DefenseOptions extends SessionLifecycleOptions {
  /** Master switch. When false, DefenseEvaluator is a no-op. */
  enabled?: boolean;
  /** Working directory for filesystem write detection. */
  cwd?: string;
  /**
   * Verification-class thresholds (user-configurable; defaults below).
   * A turn that meets EITHER threshold is treated as a long turn and gets
   * the same forced final-reply verification as write-without-readback.
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
  const detail =
    result.reason === 'leakedToolCall'
      ? 'the model kept emitting tool calls as literal text on this channel and automatic retries are exhausted'
      : 'the automatic recovery attempts for this turn are exhausted';
  return {
    reason: result.reason || 'defense_failed',
    message: `Automatic recovery unavailable — ${detail}. The turn has stopped without a final response; send a message to continue.`,
  };
}

export class DefenseEvaluator {
  private readonly enabled: boolean;
  private readonly lifecycle: SessionLifecycle;
  private readonly fsWatch: FsWatch;
  private readonly cwd?: string;
  private readonly verifyMinSteps: number;
  private readonly verifyMinDurationMs: number;
  private toolCalls: ToolCallLike[] = [];
  private readOutputs: string[] = [];

  constructor(options: DefenseOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.cwd = options.cwd;
    this.fsWatch = new FsWatch();
    this.lifecycle = new SessionLifecycle(options);
    this.verifyMinSteps = options.verifyMinSteps ?? DEFAULT_VERIFY_MIN_STEPS;
    this.verifyMinDurationMs = options.verifyMinDurationMs ?? DEFAULT_VERIFY_MIN_DURATION_MS;
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

  /** Record a read-back output so writes followed by reads count as verified. */
  recordReadOutput(text: string): void {
    if (!this.enabled) return;
    if (text.trim().length > 0) {
      this.readOutputs.push(text);
    }
  }

  /** Reset tool-call buffer for a new turn. */
  resetTurn(): void {
    this.toolCalls = [];
    this.readOutputs = [];
    this.lifecycle.reset();
    // Anchor the fs mtime marker: anything modified after this point counts
    // as a turn-caused write, regardless of which tool/script did it.
    if (this.cwd) this.fsWatch.markTurnStart();
  }

  /**
   * Filesystem-fact write evidence for this turn (null when cwd unknown).
   * This is the ground truth for "did a write happen" — command-text regex
   * classification is only a fallback for when the scan is unavailable.
   */
  detectFsWrites(): FsWriteEvidence | null {
    if (!this.enabled || !this.cwd) return null;
    return this.fsWatch.detectWrites(this.cwd);
  }

  /** Human-readable summary of which resume signal(s) fired (diagnostics). */
  private describeSignals(
    hasWrite: boolean,
    fsEvidence: FsWriteEvidence | null,
    silentStop: boolean,
    emptyResponse: boolean,
    repetitionLoop: boolean,
    truncatedFinal: boolean,
    verifyRequired = false,
    leakedToolCall = false,
  ): string {
    const parts: string[] = [];
    if (silentStop) parts.push('silentStop');
    if (emptyResponse) parts.push('emptyResponse');
    if (repetitionLoop) parts.push('repetitionLoop');
    if (truncatedFinal) parts.push('truncatedFinal');
    if (leakedToolCall) parts.push('leakedToolCall');
    if (verifyRequired) parts.push('verify');
    if (hasWrite) {
      const fsFiles = fsEvidence?.modifiedFiles ?? [];
      parts.push(
        fsFiles.length > 0
          ? `fsWrite(${fsFiles.slice(0, 5).join(', ')}${fsFiles.length > 5 ? ', …' : ''})`
          : 'cmdWrite',
      );
    }
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
    /**
     * True when the FINAL assistant text contains leaked provider tool-call
     * markup (e.g. DeepSeek `｜DSML｜` blocks emitted as literal text). The
     * intended tool calls never executed and no valid final reply exists —
     * fault-class, like emptyResponse (2026-10-04 incident, 261004-tall-nickel).
     */
    hasLeakedToolCall?: boolean;
    /** Intended tool names extracted from the leaked markup (diagnostics). */
    leakedCallNames?: string[];
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
    // this guard, a turn aborted mid-task with write-without-readback (or an
    // empty final reply) was automatically resumed via followUp(), reviving a
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

    const complexity = complexityScore(this.toolCalls);
    // Merge separately-recorded read-back outputs into the verification check:
    // a read tool that returned content counts as a read-back even though the
    // tool-execution event payload may not carry it.
    const effectiveVerify = complexity.hasVerify || this.readOutputs.length > 0;

    // Ground-truth write detection: filesystem mtime evidence first,
    // command-text regex as fallback (e.g. writes outside cwd).
    //
    // ATTRIBUTION (2026-10-04 incident, 261004-tall-nickel): mtime evidence
    // cannot tell WHICH process modified a file. A worktree shared with other
    // sessions/indexers/watch processes poisons the signal — an unrelated
    // session's write to a test file forced a verification on a pure
    // read-only session. Only count files attributable to THIS session's own
    // tool activity (path correlation); when the turn has write-class
    // actions, keep all evidence conservatively.
    let fsEvidence = this.detectFsWrites();
    if (fsEvidence && fsEvidence.modifiedFiles.length > 0) {
      const attributed = attributeFsWrites(fsEvidence.modifiedFiles, this.toolCalls, complexity.hasWrite);
      fsEvidence = { ...fsEvidence, modifiedFiles: attributed };
    }
    const fsWrite = !!fsEvidence && fsEvidence.modifiedFiles.length > 0;
    const hasWrite = fsWrite || complexity.hasWrite;
    const writeUnverified = hasWrite && !effectiveVerify;

    // Leaked tool-call markup (fault-class): the model emitted provider
    // tool-call tokens as literal text; the calls never executed. No valid
    // final reply exists to verify — resume like an empty response.
    const leakedToolCall = lastAssistantMessage?.hasLeakedToolCall === true;
    const leakedCallNames = lastAssistantMessage?.leakedCallNames ?? [];

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
    // mid-sentence truncation, leaked tool-call markup). These keep the
    // ORIGINAL LLM-completion flow: a followUp resume message asks the model
    // to finish/repair the reply. Verification NEVER applies to fault class
    // — there is no finished content to verify.
    const faultClass =
      stallAborted || silentStop || emptyResponse || repetitionLoop || truncatedFinal || leakedToolCall;

    // Verification-class signals (user-approved redesign, 2026-10-02):
    // a) writes performed with no read-back evidence;
    // b) FORCED long turn — the turn met EITHER threshold (step count ≥
    //    verifyMinSteps OR elapsed ≥ verifyMinDurationMs; OR semantics,
    //    configurable). These are NOT faults: the content may be fine.
    // Instead of blindly resuming, the turn gets a program-side
    // verification: an LLM check on whether the final reply is a valid
    // answer to the user's message. PASS → the captured final text is
    // replayed AS the single final reply (no second LLM bubble); FAIL →
    // only then follow up (LLM continues).
    const longTurn =
      this.lifecycle.getIterations() >= this.verifyMinSteps
      || this.lifecycle.elapsedMs() >= this.verifyMinDurationMs;
    // Legacy direct evaluator callers provide hasVisibleText only. The Pi
    // server passes hasFinalText explicitly so earlier commentary/tool-call
    // text can never be mistaken for a terminal candidate.
    const hasFinalText = lastAssistantMessage?.hasFinalText ?? lastAssistantMessage?.hasVisibleText ?? false;
    const verifyRequired = hasFinalText && !faultClass && (writeUnverified || longTurn);
    // If a verification signal fires without a deliverable final candidate,
    // preserve the ordinary follow-up recovery path instead of opening a
    // program-side verification hold.
    const resumeWithoutCandidate = !hasFinalText && (writeUnverified || longTurn);

    // A stall-watchdog abort is itself an early-stop signal: the turn was
    // killed mid-flight, so evaluation must run even when no other signal
    // fired (e.g. visible text was already produced earlier in the run).
    const needsEvaluation =
      faultClass || verifyRequired || resumeWithoutCandidate || complexity.needsEvaluation;
    const stop = this.lifecycle.onStop(needsEvaluation);

    if (stop === 'abort') {
      return {
        evaluated: false,
        shouldResume: false,
        state: State.ABORTED,
      };
    }

    // Rule-based evaluation: only concrete early-stop signals warrant an
    // automatic resume — silent stop (no output at all), wrote-without-
    // read-back, or a stall-watchdog kill. High complexity alone is
    // informational. stallAborted bypasses this gate even when visible text
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

    // needsEvaluation: build resume context and decide. Verification also
    // consumes one FSM slot via decideResume — a FAIL ed verification
    // follows up (a real resume), and repeat fail→re-verify cycles must
    // respect maxResumes like any other loop.
    const resumeMessage = buildResumeMessage(hasWrite, fsEvidence, this.toolCalls, silentStop, emptyResponse, repetitionLoop, truncatedFinal, stallAborted, leakedToolCall, leakedCallNames);
    const decision = this.lifecycle.decideResume(resumeMessage);
    if (decision === State.FAILED) {
      return {
        evaluated: true,
        shouldResume: false,
        state: State.FAILED,
        failureReason: 'Resume cap reached or no progress across consecutive resumes',
        reason: this.describeSignals(hasWrite, fsEvidence, silentStop, emptyResponse, repetitionLoop, truncatedFinal, verifyRequired, leakedToolCall),
      };
    }

    this.lifecycle.markResumed();
    if (verifyRequired) {
      return {
        evaluated: true,
        shouldResume: false,
        verifyRequired: true,
        verifyReason: writeUnverified
          ? 'write-without-readback'
          : 'force-long-turn',
        resumeMessage,
        state: this.lifecycle.getState(),
        reason: this.describeSignals(hasWrite, fsEvidence, silentStop, emptyResponse, repetitionLoop, truncatedFinal, verifyRequired, leakedToolCall),
      };
    }

    return {
      evaluated: true,
      shouldResume: true,
      resumeMessage,
      state: this.lifecycle.getState(),
      reason: this.describeSignals(hasWrite, fsEvidence, silentStop, emptyResponse, repetitionLoop, truncatedFinal, verifyRequired, leakedToolCall),
    };
  }
}

/**
 * Attribute filesystem mtime evidence to THIS session's own tool activity.
 *
 * FsWatch observes mtime changes under cwd but cannot tell WHICH process
 * made them. A worktree shared with other sessions, indexers, or
 * build/watch processes poisons the "did a write happen" signal: an
 * unrelated session's write to `packages\messaging-gateway\...\renderer-
 * system-stop-notice.test.ts` forced a verification-delivery hold on a pure
 * read-only session that never touched that file (2026-10-04 incident,
 * session 261004-tall-nickel).
 *
 * Rules:
 * 1. Path correlation — a modified file is attributable when its path or
 *    basename is referenced by this session's own tool calls (write/edit
 *    `path` args, bash command text).
 * 2. Write-class fallback — when the turn performed write-class actions
 *    (write/edit tool calls or write-like bash commands), keep ALL evidence:
 *    the writes may have happened through a script whose output paths are
 *    not visible in the command text. Excluding them would miss real
 *    unverified writes.
 * 3. No write-class actions at all — the session's tools could not have
 *    produced the observed mtime changes; they are external and are
 *    dropped (unless path-correlated in rule 1).
 */
export function attributeFsWrites(
  modifiedFiles: string[],
  toolCalls: ToolCallLike[],
  turnHasWriteAction: boolean,
): string[] {
  const references: string[] = [];
  for (const call of toolCalls ?? []) {
    if (typeof call.path === 'string' && call.path.length > 0) references.push(call.path);
    if (typeof call.command === 'string' && call.command.length > 0) references.push(call.command);
  }
  if (references.length === 0) {
    return turnHasWriteAction ? modifiedFiles : [];
  }
  if (turnHasWriteAction) {
    // Conservative: the turn did write-class work; we cannot rule out that
    // any of the observed changes are its (script) output.
    return modifiedFiles;
  }
  const norm = (s: string): string => s.toLowerCase().replace(/\\/g, '/');
  const hay = references.map(norm);
  const attributed: string[] = [];
  for (const file of modifiedFiles) {
    const nf = norm(file);
    const base = nf.split('/').pop() ?? nf;
    const hit = hay.some((h) =>
      h.includes(nf) || (base.length >= 6 && h.includes(base)),
    );
    if (hit) attributed.push(file);
  }
  return attributed;
}

/**
 * Build the verification-delivery resume message.
 *
 * Resume ≠ rerun: the message appends a **verification delivery** step to the
 * SAME session transcript. The model judges whether its final reply (its last
 * assistant message) actually corresponds to the user's message:
 * - corresponds → re-deliver that final reply verbatim, so the user
 *   effectively receives ONE reply — the resumed turn (still inside the same
 *   turn's process block) must not produce a second, different answer;
 * - does not correspond → state the reason, then continue the conversation.
 * The per-signal lines below are judgment aids ("why this check fired"), not
 * new work orders: extra work happens only on the "does not correspond" branch.
 */
function buildResumeMessage(
  hasWrite: boolean,
  fsEvidence: FsWriteEvidence | null,
  toolCalls: ToolCallLike[],
  silentStop: boolean,
  emptyResponse: boolean,
  repetitionLoop: boolean,
  truncatedFinal: boolean,
  stallAborted = false,
  leakedToolCall = false,
  leakedCallNames: string[] = [],
): string {
  const writeCalls = toolCalls.filter((c) => ['write', 'edit', 'bash:write'].includes(c.type));
  const lines: string[] = [
    '[Defense] Verification delivery step — check delivery, do NOT re-run the task.',
    `Judge whether your final reply (your last assistant message in this conversation) ` +
      `corresponds to the user's message (the request the user sent in this turn):`,
    `- If it DOES correspond: your reply now must simply be that final reply content, ` +
      `verbatim — the same reply from before this verification step. Add no new analysis, ` +
      `redo no completed work, append no new steps.`,
    `- If it does NOT correspond (missing, off-target, or unverified): state the reason ` +
      `in one short line, then continue the task from where it left off.`,
    `Signals that triggered this verification step:`,
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
  if (leakedToolCall) {
    lines.push(
      `- Your previous reply emitted tool-call markup as LITERAL TEXT` +
      (leakedCallNames.length > 0 ? ` (intended calls: ${leakedCallNames.join(', ')})` : '') +
      ` — the tool calls NEVER executed and the reply is not a valid answer. ` +
      `Do NOT correspond: state that reason in one short line, re-issue the intended tool ` +
      `calls properly (as real tool calls, not as text), then continue the task from where ` +
      `it left off.`,
    );
  }
  if (emptyResponse) {
    lines.push(
      `- Your previous model call returned an EMPTY response (no visible content; ` +
      `likely an upstream fault or max_tokens truncation burning invisible reasoning) — ` +
      `NOT an intentional completion. No final reply exists to verify, so it does NOT ` +
      `correspond: state that reason, then pick up exactly where you left off.`,
    );
  }
  if (repetitionLoop) {
    lines.push(
      `- Your previous reply devolved into a REPETITION LOOP (a large share of the output ` +
      `was exact-duplicate text) — a model degeneration, not an answer. It does NOT ` +
      `correspond to the user's message: state that reason, then give the user a ` +
      `concise, non-repetitive reply covering the outstanding points.`,
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
      `exists to verify, so it does NOT correspond: state that reason, report your current ` +
      `progress/status to the user now, then continue any remaining work.`,
    );
  }
  if (hasWrite) {
    lines.push(
      `- Write/edit operations were performed but never followed by any read-back ` +
      `(no file read, no verification command output). If your final reply claims these ` +
      `writes are done without such evidence, it does NOT correspond: state that reason, ` +
      `verify the outcome actually matches the user's request (re-read the affected files ` +
      `or run a status/test check), then confirm or correct your final answer. ` +
      `Do NOT redo completed work.`,
    );
  }
  if (fsEvidence && fsEvidence.modifiedFiles.length > 0) {
    const files = fsEvidence.modifiedFiles.slice(0, 5).join(', ');
    const more = fsEvidence.modifiedFiles.length > 5 ? ` (+${fsEvidence.modifiedFiles.length - 5} more)` : '';
    lines.push(`- Files modified during the turn (fs mtime evidence): ${files}${more}`);
  }
  if (writeCalls.length > 0) {
    lines.push(`- Affected targets: ${writeCalls.map((c) => (c.type === 'bash' ? (c.command ?? '').slice(0, 80) : c.type)).join(', ')}`);
  }
  lines.push(`- Do NOT repeat already completed steps.`);
  return lines.join('\n');
}
