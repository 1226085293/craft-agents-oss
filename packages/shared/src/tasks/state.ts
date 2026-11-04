/**
 * Task state machine, handoff normalization and the guards that keep a long
 * task from burning money silently.
 *
 * Everything here is pure: no fs, no clock beyond an injected `now`. The
 * supervisor and the RPC layer both call these, so the rules exist once.
 */

import {
  CONTEXT_ROTATE_THRESHOLD,
  FAILURE_FUSE,
  type Handoff,
  type HandoffArtifact,
  type HandoffOutcome,
  type HandoffVerify,
  type Task,
  type TaskBudget,
  type TaskPauseReason,
  type TaskStatus,
} from './types.ts';

/**
 * Legal transitions. `running → running` is intentionally allowed: a handoff
 * moves the task to the next session without leaving the running state.
 */
const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  // A backlog task can be paused before it ever runs (dependency blocked,
  // budget pre-check) and can fail outright if its setup is invalid.
  backlog: ['running', 'paused', 'failed', 'canceled'],
  running: ['running', 'paused', 'completed', 'failed', 'canceled'],
  paused: ['running', 'canceled', 'failed'],
  completed: [],
  failed: ['backlog', 'running', 'canceled'],
  canceled: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: TaskStatus,
    readonly to: TaskStatus,
  ) {
    super(`illegal task transition: ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Throws instead of silently ignoring an illegal move — prompts are not guards. */
export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

export const TERMINAL_STATUSES: readonly TaskStatus[] = ['completed', 'canceled'];

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export type TransitionResult = {
  task: Task;
  /** Set when this transition was applied. */
  changed: boolean;
};

/**
 * Apply a transition, maintaining the fields that travel with it
 * (`pauseReason`, timestamps, terminal bookkeeping).
 */
export function applyTransition(
  task: Task,
  to: TaskStatus,
  options: { now: number; pauseReason?: TaskPauseReason | null; error?: string },
): TransitionResult {
  if (task.status === to) {
    return { task: { ...task, updatedAt: options.now }, changed: false };
  }
  assertTransition(task.status, to);

  const next: Task = { ...task, status: to, updatedAt: options.now };

  if (to === 'paused') {
    next.pauseReason = options.pauseReason ?? null;
    next.lifecycle = {
      ...task.lifecycle,
      lastPausedAt: options.now,
      ...(options.error ? { lastError: options.error } : {}),
    };
  } else if (to === 'running') {
    next.pauseReason = null;
    if (task.status === 'paused') {
      next.lifecycle = { ...task.lifecycle, lastRecoveredAt: options.now };
    }
  } else if (to === 'failed') {
    next.lifecycle = {
      ...task.lifecycle,
      errorCount: task.lifecycle.errorCount + 1,
      lastError: options.error ?? task.lifecycle.lastError,
    };
  }

  return { task: next, changed: true };
}

// ------------------------------------------------------------
// Handoff
// ------------------------------------------------------------

const MAX_SUMMARY = 200;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeArtifacts(value: unknown): HandoffArtifact[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((raw) => {
      if (!raw || typeof raw !== 'object') return null;
      const v = raw as Partial<HandoffArtifact>;
      const path = str(v.path);
      if (!path) return null;
      return { path, note: str(v.note) };
    })
    .filter(Boolean) as HandoffArtifact[];
  return items.length ? items : undefined;
}

function normalizeVerify(value: unknown): HandoffVerify | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Partial<HandoffVerify>;
  const ran = Array.isArray(v.ran)
    ? v.ran.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    : [];
  return { ran, passed: v.passed === true, note: str(v.note) };
}

/**
 * Turn whatever the worker sent into a well-formed handoff.
 *
 * The default outcome is `handoff`, never `delivered`: a worker that says
 * nothing must not push a half-finished result to the user.
 */
export function normalizeHandoff(raw: unknown, fromSessionId: string, now: number): Handoff {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const outcome: HandoffOutcome =
    v.outcome === 'delivered' || v.outcome === 'needs_decision' || v.outcome === 'handoff'
      ? v.outcome
      : 'handoff';

  const summary = (str(v.summary) ?? '未提供交接内容').slice(0, MAX_SUMMARY);
  const keyFindings = Array.isArray(v.keyFindings)
    ? v.keyFindings.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    : undefined;

  return {
    at: now,
    fromSessionId,
    outcome,
    summary,
    keyFindings: keyFindings?.length ? keyFindings : undefined,
    nextAction: str(v.nextAction),
    artifacts: normalizeArtifacts(v.artifacts),
    verify: normalizeVerify(v.verify),
  };
}

/**
 * Rule gate (the first, mandatory acceptance layer).
 *
 * Cheap, deterministic, and the only layer that runs when no `requirement` was
 * written. Returns the reasons it failed so the supervisor can send them back
 * verbatim.
 */
export function checkHandoffRules(handoff: Handoff, artifactsExist: (path: string) => boolean): {
  passed: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];

  if (handoff.outcome === 'needs_decision') {
    return { passed: false, reasons: ['worker is asking for a decision'] };
  }

  if (!handoff.artifacts?.length) {
    reasons.push('no artifacts');
  } else {
    for (const artifact of handoff.artifacts) {
      if (!artifactsExist(artifact.path)) reasons.push(`missing artifact: ${artifact.path}`);
    }
  }

  if (!handoff.verify || handoff.verify.ran.length === 0) {
    reasons.push('no verification command was run');
  } else if (!handoff.verify.passed) {
    reasons.push('verification did not pass');
  }

  return { passed: reasons.length === 0, reasons };
}

// ------------------------------------------------------------
// Budget, fuse, heartbeat
// ------------------------------------------------------------

export interface BudgetUsage {
  sessions: number;
  runs: number;
  activeMinutes: number;
}

export type BudgetVerdict = { exceeded: false } | { exceeded: true; reason: string };

export function checkBudget(budget: TaskBudget, usage: BudgetUsage, now: number): BudgetVerdict {
  if (usage.sessions > budget.maxSessions) {
    return { exceeded: true, reason: `sessions ${usage.sessions}/${budget.maxSessions}` };
  }
  if (usage.runs > budget.maxRuns) {
    return { exceeded: true, reason: `runs ${usage.runs}/${budget.maxRuns}` };
  }
  if (usage.activeMinutes > budget.activeMinutes) {
    return { exceeded: true, reason: `active minutes ${usage.activeMinutes}/${budget.activeMinutes}` };
  }
  if (budget.deadline && now > budget.deadline) {
    return { exceeded: true, reason: 'deadline passed' };
  }
  return { exceeded: false };
}

/** Three consecutive failures pause the task; a clean run resets the streak. */
export function shouldTripFuse(lifecycle: Task['lifecycle']): boolean {
  return lifecycle.consecutiveFailures >= FAILURE_FUSE;
}

export function recordRunResult(
  lifecycle: Task['lifecycle'],
  ok: boolean,
  now: number,
  error?: string,
): Task['lifecycle'] {
  if (ok) {
    return {
      ...lifecycle,
      consecutiveFailures: 0,
      lastError: undefined,
      lastRecoveredAt: lifecycle.lastError ? now : lifecycle.lastRecoveredAt,
    };
  }
  return {
    ...lifecycle,
    errorCount: lifecycle.errorCount + 1,
    consecutiveFailures: lifecycle.consecutiveFailures + 1,
    lastError: error ?? lifecycle.lastError,
  };
}

/** A task is stalled when two heartbeats in a row never arrived. */
export function isHeartbeatStalled(task: Task, now: number): boolean {
  // `0` is a legitimate timestamp (epoch), so test for presence explicitly.
  if (typeof task.lastHeartbeatAt !== 'number') return false;
  const windowMs = task.heartbeatIntervalMin * 60_000 * 2;
  return now - task.lastHeartbeatAt > windowMs;
}

/**
 * Long tasks must not run in one ever-growing session: past the context
 * threshold the supervisor starts a fresh session from the last handoff.
 */
export function shouldRotateSession(contextUtilization: number): boolean {
  return contextUtilization >= CONTEXT_ROTATE_THRESHOLD;
}
