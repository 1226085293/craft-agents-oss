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
}

export class DefenseEvaluator {
  private readonly enabled: boolean;
  private readonly lifecycle: SessionLifecycle;
  private toolCalls: ToolCallLike[] = [];
  private readOutputs: string[] = [];

  constructor(options: DefenseOptions = {}) {
    this.enabled = options.enabled ?? true;
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
  }

  /**
   * Post-stop evaluation. Returns whether a resume should be queued.
   */
  evaluate(): DefenseEvaluationResult {
    if (!this.enabled) {
      return { evaluated: false, shouldResume: false, state: State.IDLE };
    }

    const complexity = complexityScore(this.toolCalls);
    // Merge separately-recorded read-back outputs into the verification check:
    // a read tool that returned content counts as a read-back even though the
    // tool-execution event payload may not carry it.
    const effectiveVerify = complexity.hasVerify || this.readOutputs.length > 0;
    const shouldResume = complexity.shouldResume && !effectiveVerify;
    const stop = this.lifecycle.onStop(complexity.needsEvaluation);

    if (stop === 'abort') {
      return {
        evaluated: false,
        shouldResume: false,
        state: State.ABORTED,
      };
    }

    // Rule-based evaluation: only a concrete early-stop signal (wrote but never
    // read back) warrants an automatic resume. High complexity alone is
    // informational — it doesn't prove the task was left incomplete.
    if (stop === 'run' || !shouldResume) {
      this.lifecycle.markDone();
      return {
        evaluated: true,
        shouldResume: false,
        state: this.lifecycle.getState(),
      };
    }

    // needsEvaluation: build resume context and decide.
    const resumeMessage = buildResumeMessage(complexity.hasWrite, this.toolCalls);
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
function buildResumeMessage(hasWrite: boolean, toolCalls: ToolCallLike[]): string {
  const writeCalls = toolCalls.filter((c) => ['write', 'edit', 'bash:write'].includes(c.type));
  const lines: string[] = [
    '[Defense] Detected a possible early stop. Please continue the task from where it left off.',
  ];
  if (hasWrite) {
    lines.push(
      `- Write/edit operations were performed but not verified by a read-back. ` +
      `Re-read the affected files and confirm the result.`,
    );
  }
  if (writeCalls.length > 0) {
    lines.push(`- Affected targets: ${writeCalls.map((c) => (c.type === 'bash' ? (c.command ?? '').slice(0, 80) : c.type)).join(', ')}`);
  }
  lines.push(`- Do NOT repeat already completed steps.`);
  return lines.join('\n');
}
