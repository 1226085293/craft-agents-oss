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
  type TaskAcceptanceItem,
  type TaskBudget,
  type TaskDeliverable,
  type TaskPauseReason,
  type TaskSpec,
  type TaskStatus,
  type TaskTrigger,
  type TaskVerifyConfig,
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

/**
 * A pending decision is not the model's to answer.
 *
 * Observed on a real run: a task paused for 「范围内的工作已完成，是否放行剩余步骤」. The
 * supervisor read the request — which had been delivered into its own lane — decided on
 * the user's behalf (「按你最初的授权，我拍板选 (b)」), moved the task from `paused` back to
 * `running`, marked the steps the user had explicitly excluded as done, and added a new
 * one. The user never saw a question they could answer, and the instruction 「不要碰 1.2
 * 和 2」 was quietly reversed.
 *
 * The state machine allowed it because `paused → running` is a legal resume. It is legal
 * when the pause was a stall, a failure backoff or a lost process — those are the system's
 * own interruptions and resuming them is recovery. It is not legal when the pause exists
 * because a person was asked something: then resuming means answering for them. Only
 * `resolveDecision` may clear that, and it is called from the user's reply.
 */
export function assertNotAwaitingDecision(task: Task, to: TaskStatus): void {
  if (to !== 'running') return;
  const decision = task.decision;
  if (!decision || decision.resolvedAt) return;
  throw new Error(
    `任务正在等待用户拍板（${decision.label}），不能自己恢复运行。` +
      '拍板必须由用户回答后通过 resolveDecision 解除；它问的是人，不是执行者。',
  );
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
  assertNotAwaitingDecision(task, to);

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
    ...(str(v.revision) ? { revision: str(v.revision) } : {}),
    // Preserved, not recomputed: the flag records what was true when the hand-off
    // was recorded, and re-deriving it later would silently rewrite history.
    ...(typeof v.milestone === 'boolean' ? { milestone: v.milestone } : {}),
  };
}

export interface ArtifactProbe {
  /** True when the path exists and is readable. */
  exists: boolean;
  /** True when the path is a file with content (directories are exempt). */
  nonEmpty: boolean;
  isDirectory?: boolean;
}

/**
 * Rule gate (the first, mandatory acceptance layer).
 *
 * Cheap, deterministic, and the only layer that runs when no `requirement` was
 * written. Returns the reasons it failed so the supervisor can send them back
 * verbatim.
 *
 * `probe` replaces the old `artifactsExist` boolean because "the path is there"
 * and "the deliverable can actually be opened" are different claims — an empty
 * file or a dangling symlink used to pass.
 */
export function checkHandoffRules(
  handoff: Handoff,
  probe: (path: string) => ArtifactProbe,
  options?: { requiredDeliverables?: TaskDeliverable[]; acceptance?: TaskAcceptanceVerdict },
): {
  passed: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];

  if (handoff.outcome === 'needs_decision') {
    return { passed: false, reasons: ['worker is asking for a decision'] };
  }

  if (!handoff.artifacts?.length) {
    reasons.push('交接里没有列出任何产物（artifacts）。把你实际做出来的文件路径填进去，规则门会用真实路径去检查。');
  } else {
    for (const artifact of handoff.artifacts) {
      const found = probe(artifact.path);
      if (!found.exists) {
        reasons.push(`missing artifact: ${artifact.path}`);
      } else if (!found.nonEmpty && !found.isDirectory) {
        reasons.push(`empty artifact: ${artifact.path}`);
      }
    }
  }

  // Declared deliverables are part of the contract, not a suggestion: a task
  // that promised a PR must not complete on an unrelated README edit.
  for (const deliverable of options?.requiredDeliverables ?? []) {
    if (deliverable.required === false) continue;
    if (!deliverable.path) {
      // A deliverable without a path (pr/doc/message) can only be checked when
      // the worker names it in its artifacts; require at least one artifact.
      if (!handoff.artifacts?.length) reasons.push(`missing deliverable: ${deliverable.kind}`);
      continue;
    }
    const found = probe(deliverable.path);
    if (!found.exists) reasons.push(`missing deliverable: ${deliverable.path}`);
    else if (!found.nonEmpty && !found.isDirectory) reasons.push(`empty deliverable: ${deliverable.path}`);
  }

  if (!handoff.verify || handoff.verify.ran.length === 0) {
    reasons.push('没有记录任何验证命令（verify.ran）。把真正跑过的命令写进去，并用 verify.passed 说明它是否通过。');
  } else if (!handoff.verify.passed) {
    reasons.push('你记录的命令是失败的（verify.passed 为 false），失败的验证不能当作完成证据。');
  }

  // Acceptance commands are the deterministic second layer: they run here, not
  // inside the model's story about itself.
  if (options?.acceptance) {
    for (const failure of options.acceptance.failures) reasons.push(failure);
  }

  return { passed: reasons.length === 0, reasons };
}

/** Outcome of running the task's acceptance commands. */
export interface TaskAcceptanceVerdict {
  checked: number;
  failures: string[];
  /** Per-item detail, for the journal. */
  results: Array<{ id: string; passed: boolean; note?: string }>;
}

export function acceptanceItems(spec: TaskSpec | undefined): TaskAcceptanceItem[] {
  return (spec?.acceptance ?? []).filter((item) => item && item.id && item.check);
}

// ------------------------------------------------------------
// Dependencies and the run lock
// ------------------------------------------------------------

/**
 * A task may not start until every declared dependency is `completed`.
 * Reported as reasons so the supervisor can say exactly what is blocking.
 */
export function checkDependencies(
  task: Task,
  lookup: (id: string) => Pick<Task, 'id' | 'status' | 'name'> | null,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const depId of task.dependsOn ?? []) {
    const dep = lookup(depId);
    if (!dep) reasons.push(`dependency ${depId} not found`);
    else if (dep.status !== 'completed') {
      reasons.push(`dependency ${dep.name} (${dep.id}) is ${dep.status}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Does this handoff judge a different object than the last verdict?
 *
 * The failure loop needs it: "review failed → human fixed → new commit pushed →
 * review again" must not be blocked by the old round budget, and the old record
 * must stay untouched.
 */
export function isNewRevision(
  verify: TaskVerifyConfig,
  revision: string | undefined,
): boolean {
  if (!revision) return false;
  return verify.lastVerifiedRevision !== revision;
}

/** True when another session already holds this task's run lock. */
export function isRunLocked(task: Task, sessionExists: (id: string) => boolean): boolean {
  const lock = task.stats?.lockSessionId;
  if (!lock) return false;
  // A `pending:<reason>` placeholder holds the lock only until the session exists.
  // It is not a session, so it can never keep the task locked: asking about it
  // returns "exists" in any caller whose table answers loosely, and the task then
  // refuses to start its own real run.
  if (lock.startsWith('pending:')) return false;
  return sessionExists(lock);
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

/** A task is stalled when two heartbeats in a row never arrived. */export function isHeartbeatStalled(task: Task, now: number): boolean {
  // `0` is a legitimate timestamp (epoch), so test for presence explicitly.
  const last = task.stats?.lastHeartbeatAt ?? task.lastHeartbeatAt;
  if (typeof last !== 'number') return false;
  const windowMs = task.heartbeatIntervalMin * 60_000 * 2;
  return now - last > windowMs;
}

/**
 * A running task with no heartbeat at all is stalled, not "fine".
 *
 * The old rule treated a missing heartbeat as healthy, which made the watchdog
 * blind to the most common failure: a worker that never hands off.
 */
export function isHeartbeatMissing(task: Task, now: number): boolean {
  const last = task.stats?.lastHeartbeatAt ?? task.lastHeartbeatAt;
  if (typeof last === 'number') return isHeartbeatStalled(task, now);
  const startedAt = task.stats?.runStartedAt ?? task.updatedAt;
  return now - startedAt > task.heartbeatIntervalMin * 60_000 * 2;
}

/**
 * Trigger matching, kept pure so the scheduler stays trivially testable.
 *
 * Cron evaluation itself needs a tick timestamp, so the caller passes the
 * minute the tick represents; `cronMatches` lives with the cron matcher.
 */
export function eventTriggerMatches(
  trigger: TaskTrigger | undefined,
  event: { source: string; type: string; title?: string; summary?: string },
): boolean {
  if (!trigger || trigger.kind !== 'event' || !trigger.enabled) return false;
  if (trigger.source !== event.source) return false;
  if (trigger.types?.length && !trigger.types.includes(event.type)) return false;
  if (trigger.textMatch) {
    const haystack = `${event.title ?? ''} ${event.summary ?? ''}`.toLowerCase();
    const hit = trigger.textMatch
      .split('|')
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean)
      .some((part) => haystack.includes(part));
    if (!hit) return false;
  }
  return true;
}

/**
 * Long tasks must not run in one ever-growing session: past the context
 * threshold the supervisor starts a fresh session from the last handoff.
 */
export function shouldRotateSession(contextUtilization: number): boolean {
  return contextUtilization >= CONTEXT_ROTATE_THRESHOLD;
}
