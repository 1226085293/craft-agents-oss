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
  /** Whether a resume is required (early-stop suspected). */
  shouldResume: boolean;
  /** Human-readable resume message to append to the session. */
  resumeMessage?: string;
  /** Final FSM state after evaluation. */
  state: State;
  /** Failure reason when state === FAILED. */
  failureReason?: string;
}

export interface DefenseOptions extends SessionLifecycleOptions {
  /** Master switch. When false, DefenseEvaluator is a no-op. */
  enabled?: boolean;
  /** Working directory for filesystem write detection. */
  cwd?: string;
}

export class DefenseEvaluator {
  private readonly enabled: boolean;
  private readonly lifecycle: SessionLifecycle;
  private readonly fsWatch: FsWatch;
  private readonly cwd?: string;
  private toolCalls: ToolCallLike[] = [];
  private readOutputs: string[] = [];

  constructor(options: DefenseOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.cwd = options.cwd;
    this.fsWatch = new FsWatch();
    this.lifecycle = new SessionLifecycle(options);
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

  /**
   * Post-stop evaluation. Returns whether a resume should be queued.
   *
   * `lastAssistantMessage` is the final assistant message from agent_end
   * (when available). A turn whose assistant produced no visible text and
   * was not user-aborted is treated as a silent stop — the strongest
   * early-stop signal there is, regardless of tool history.
   *
   * `endsWithEmptyResponse` flags the pathological case where the FINAL
   * assistant message is an empty LLM response — no content blocks at all.
   * Two observed variants: finish_reason=stop with 0 output tokens (gateway
   * fault) and finish_reason=length with output burned on invisible
   * reasoning (max_tokens truncation). Both are infrastructure faults, not
   * real completions. Unlike silent-stop (which scans the whole run), this
   * signal anchors strictly on the last message: earlier progress updates
   * in a long tool chain must not mask it (2026-08-22 incidents).
   */
  evaluate(lastAssistantMessage?: {
    hasVisibleText: boolean;
    aborted: boolean;
    endsWithEmptyResponse?: boolean;
  }): DefenseEvaluationResult {
    if (!this.enabled) {
      return { evaluated: false, shouldResume: false, state: State.IDLE };
    }

    // P0 guardrail (2026-08-22): a user abort is an explicit intent to stop.
    // It must short-circuit EVERY resume signal — not just silentStop. Before
    // this guard, a turn aborted mid-task with write-without-readback (or an
    // empty final reply) was automatically resumed via followUp(), reviving a
    // task the user had deliberately stopped and letting it keep mutating
    // files. Abort wins over all heuristics.
    if (lastAssistantMessage?.aborted === true) {
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
    const fsEvidence = this.detectFsWrites();
    const fsWrite = !!fsEvidence && fsEvidence.modifiedFiles.length > 0;
    const hasWrite = fsWrite || complexity.hasWrite;
    const shouldResume = hasWrite && !effectiveVerify;

    // Silent-stop detection: the turn ended without any assistant-visible
    // text. The user sees nothing — indistinguishable from a hang. Not
    // triggered on user aborts (that's intentional interruption).
    const silentStop =
      lastAssistantMessage != null && !lastAssistantMessage.hasVisibleText && !lastAssistantMessage.aborted;

    // Empty terminal response: the very last model call returned zero tokens
    // with a clean stop — an infrastructure fault, not an intentional finish.
    // Independent of silentStop because long tool chains legitimately produce
    // progress text early, which makes run-wide hasVisibleText useless here.
    const emptyResponse = lastAssistantMessage?.endsWithEmptyResponse === true;

    const needsEvaluation = silentStop || emptyResponse || shouldResume || complexity.needsEvaluation;
    const stop = this.lifecycle.onStop(needsEvaluation);

    if (stop === 'abort') {
      return {
        evaluated: false,
        shouldResume: false,
        state: State.ABORTED,
      };
    }

    // Rule-based evaluation: only concrete early-stop signals warrant an
    // automatic resume — silent stop (no output at all) or wrote-without-
    // read-back. High complexity alone is informational.
    if (stop === 'run' || (!shouldResume && !silentStop && !emptyResponse)) {
      this.lifecycle.markDone();
      return {
        evaluated: true,
        shouldResume: false,
        state: this.lifecycle.getState(),
      };
    }

    // needsEvaluation: build resume context and decide.
    const resumeMessage = buildResumeMessage(hasWrite, fsEvidence, this.toolCalls, silentStop, emptyResponse);
    const decision = this.lifecycle.decideResume(resumeMessage);
    if (decision === State.FAILED) {
      return {
        evaluated: true,
        shouldResume: false,
        state: State.FAILED,
        failureReason: 'Resume cap reached or no progress across consecutive resumes',
      };
    }

    this.lifecycle.markResumed();
    return {
      evaluated: true,
      shouldResume: true,
      resumeMessage,
      state: this.lifecycle.getState(),
    };
  }
}

/** Build the differential resume message (resume ≠ rerun). */
function buildResumeMessage(
  hasWrite: boolean,
  fsEvidence: FsWriteEvidence | null,
  toolCalls: ToolCallLike[],
  silentStop: boolean,
  emptyResponse: boolean,
): string {
  const writeCalls = toolCalls.filter((c) => ['write', 'edit', 'bash:write'].includes(c.type));
  const lines: string[] = [
    '[Defense] Detected a possible early stop. Please continue the task from where it left off.',
  ];
  if (emptyResponse) {
    lines.push(
      `- Your previous model call returned an EMPTY response (no visible content; ` +
      `likely an upstream fault or max_tokens truncation burning invisible reasoning) — ` +
      `NOT an intentional completion. Pick up exactly where you left off.`,
    );
  }
  if (silentStop) {
    lines.push(
      `- Your previous turn ended WITHOUT any visible reply to the user. ` +
      `Report your current progress/status to the user now, then continue any remaining work.`,
    );
  }
  if (hasWrite) {
    lines.push(
      `- Write/edit operations were performed but not verified by a read-back. ` +
      `Re-read the affected files and confirm the result.`,
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
