/**
 * Task types.
 *
 * A task is a first-class object, not a property of a session: it survives the
 * sessions that work on it, it can be paused and resumed days later, and it is
 * what the supervisor hands off between workers.
 *
 * States are deliberately few. `handoff` is an event, not a state — encoding it
 * as a state would multiply the transitions for no benefit.
 */

export type TaskStatus =
  | 'backlog'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'canceled';

export type TaskPriority = 0 | 1 | 2 | 3 | 4;

/** Why a task is currently paused (null while running/backlog). */
export type TaskPauseReason =
  | 'failures'
  | 'budget'
  | 'process_lost'
  | 'waiting'
  | 'needs_decision';

/** What a worker reports when it finishes a turn. */
export type HandoffOutcome = 'delivered' | 'handoff' | 'needs_decision';

export interface HandoffArtifact {
  path: string;
  note?: string;
}

export interface HandoffVerify {
  ran: string[];
  passed: boolean;
  note?: string;
}

/**
 * The structured handoff a worker leaves behind.
 *
 * Deliberately small: summary for humans, keyFindings for the next worker,
 * nextAction to cold-start the next session, artifacts to find the work, verify
 * to know whether it actually holds.
 */
export interface Handoff {
  at: number;
  fromSessionId: string;
  outcome: HandoffOutcome;
  summary: string;
  keyFindings?: string[];
  nextAction?: string;
  artifacts?: HandoffArtifact[];
  verify?: HandoffVerify;
}

export interface TaskBudget {
  /** Hard cap on sessions attached to this task. */
  maxSessions: number;
  /** Hard cap on runs (a retry counts). */
  maxRuns: number;
  /** Accumulated *active* minutes — sleeping/waiting does not count. */
  activeMinutes: number;
  /** Calendar deadline (epoch ms). Optional. */
  deadline?: number | null;
}

export interface TaskVerifyConfig {
  enabled: boolean;
  /** One sentence a human typed: what "done" means. */
  requirement?: string;
  /** Max repair/rerun iterations before pausing. */
  maxIterations: number;
  lastVerdict?: 'pass' | 'fail';
}

export interface TaskLifecycle {
  errorCount: number;
  lastError?: string;
  lastPausedAt?: number;
  lastRecoveredAt?: number;
  /** Consecutive failures; resets on a clean run. Drives the 3-strike fuse. */
  consecutiveFailures: number;
}

export interface TaskOrigin {
  supervisorSessionId: string;
  /** Dedupe key: one tool call must not create two tasks. */
  toolCallId: string;
}

export interface Task {
  /** Human-facing id: T-1, T-2 … */
  id: string;
  name: string;
  /** The original request. Immutable — changing it means a new task. */
  instruction: string;
  status: TaskStatus;
  pauseReason?: TaskPauseReason | null;

  supervisorSessionId: string;
  /** Every session that has worked on this task, oldest first. */
  sessionIds: string[];
  currentSessionId?: string;
  assigneeAgentId?: string;

  parentTaskId?: string;
  dependsOn: string[];

  priority: TaskPriority;
  budget: TaskBudget;
  handoffs: Handoff[];
  verify: TaskVerifyConfig;
  lifecycle: TaskLifecycle;
  origin: TaskOrigin;

  /** Task-level heartbeat: proves the whole task is alive, not just a turn. */
  heartbeatIntervalMin: number;
  lastHeartbeatAt?: number;

  /** Verifier runs, for the acceptance gate's iteration cap. */
  verifyRounds?: number;

  createdAt: number;
  updatedAt: number;
}

export interface TaskIndexEntry {
  id: string;
  name: string;
  status: TaskStatus;
  updatedAt: number;
  currentSessionId?: string;
  priority: TaskPriority;
}

export interface TaskIndex {
  version: number;
  seq: number;
  tasks: TaskIndexEntry[];
}

export const TASK_INDEX_VERSION = 1;

export const DEFAULT_BUDGET: Omit<TaskBudget, 'activeMinutes'> = {
  maxSessions: 8,
  maxRuns: 12,
  deadline: null,
};

export const DEFAULT_HEARTBEAT_MINUTES = 10;

/** Consecutive failures that pause a task. */
export const FAILURE_FUSE = 3;

/** A session that has used this share of its context must be replaced. */
export const CONTEXT_ROTATE_THRESHOLD = 0.7;
