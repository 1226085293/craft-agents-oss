/**
 * Layer 2 — Complexity Score
 *
 * Side-effect-weighted scoring of tool calls.
 *
 * Core insight: early-stop probability correlates with tool side-effect
 * strength. Pure reads are low risk; writes without a subsequent read-back
 * verification are the strongest early-stop signal.
 *
 * Replaces absolute thresholds (e.g. "5 steps / 30 s") that are fragile
 * across task types and runtime environments.
 */

export interface ToolCallLike {
  type: string;
  /** Raw command string for bash calls; used to classify read vs write. */
  command?: string;
  /** Optional read-back output (hasVerify relies on output length). */
  output?: unknown;
}

/** Side-effect weights per tool category. */
export const WEIGHTS: Record<string, number> = {
  read: 0.5,
  'bash:read': 0.8,
  edit: 1.5,
  write: 2.0,
  'bash:write': 3.0,
  ls: 0.5,
  grep: 0.6,
  find: 0.6,
  glob: 0.6,
};

/** Bash commands considered side-effecting (write-class). */
export const WRITE_CMDS =
  /\b(rm|rmdir|mv|cp|git\s+push|git\s+commit|git\s+add|git\s+init|git\s+checkout\s+-b|npm\s+(i|install|publish|run\s+.*build)|bun\s+(i|install|add|publish|run\s+.*build)|docker\s+(build|push|run|compose)|curl\s+-X\s+(POST|DELETE|PUT|PATCH)|wget\s+-O|tee|dd|mkfs|kill|pkill|systemctl)\b/i;

/** Classify a single call into a weighted category. */
export function classify(call: ToolCallLike): string {
  if (call.type === 'bash') {
    return WRITE_CMDS.test(call.command ?? '') ? 'bash:write' : 'bash:read';
  }
  return call.type;
}

/** Default weight for unknown tool types. */
const DEFAULT_WEIGHT = 0.5;

export interface ComplexityResult {
  /** Normalized complexity score in [0, 1]. */
  score: number;
  /** Whether any write-class call happened. */
  hasWrite: boolean;
  /** Whether a read with non-empty output happened after writes (read-back). */
  hasVerify: boolean;
  /** Whether post-stop evaluation should run. */
  needsEvaluation: boolean;
  /** Concrete early-stop signal: wrote but never read back. */
  shouldResume: boolean;
  /** Raw weighted sum (un-normalized). */
  weighted: number;
}

/**
 * Compute the complexity score for a sequence of tool calls.
 *
 * Decision rule:
 * - skip evaluation when: pure-read + low weight
 * - must evaluate when: hasWrite && !hasVerify  (wrote but never read back)
 * - must evaluate when: weighted sum >= 2.5
 */
export function complexityScore(toolCalls: ToolCallLike[]): ComplexityResult {
  const calls = toolCalls ?? [];
  const weighted = calls.reduce((sum, c) => sum + (WEIGHTS[classify(c)] ?? DEFAULT_WEIGHT), 0);
  const hasWrite = calls.some((c) => ['write', 'edit', 'bash:write'].includes(classify(c)));
  const hasVerify = calls.some((c) => c.type === 'read' && c.output != null && String(c.output).length > 0);

  // Strongest early-stop signal: the agent wrote files but never read them back.
  const shouldResume = hasWrite && !hasVerify;
  const needsEvaluation = weighted >= 2.5 || shouldResume;

  return {
    score: Math.min(1, weighted / 8),
    hasWrite,
    hasVerify,
    needsEvaluation,
    shouldResume,
    weighted,
  };
}
