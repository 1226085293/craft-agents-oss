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

import type { PlanStep } from './plan.ts';

export type TaskStatus =
  | 'backlog'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'canceled';

export type TaskPriority = 0 | 1 | 2 | 3 | 4;

/**
 * The structured execution contract.
 *
 * `instruction` stays the immutable human request; `spec` is what makes that
 * request executable: where to run, what may be touched, what must exist at
 * the end. Keeping it separate from prose is what lets a worker start cold and
 * lets the acceptance gate check something other than vibes.
 */
export interface TaskDeliverable {
  /** What kind of thing is owed. */
  kind: 'file' | 'directory' | 'pr' | 'doc' | 'message';
  /** Path (workspace- or absolute) for file/directory kinds. */
  path?: string;
  /** Human note: what this deliverable must contain. */
  note?: string;
  /** Required for the gate? Defaults to true. */
  required?: boolean;
}

/** One checkable line of the acceptance list. */
export interface TaskAcceptanceItem {
  id: string;
  /** What must be true, in words (shown to the worker and the human). */
  check: string;
  /** Optional command that proves it. Exit 0 = pass. */
  command?: string;
}

export interface TaskPermissions {
  /** Paths the worker may write. Empty = the workspace root. */
  writePaths?: string[];
  /** True when the task may send things outside the machine. Default false. */
  allowExternal?: boolean;
}

export interface TaskSpec {
  /** Working directory, workspace-relative or absolute. */
  cwd?: string;
  /** Source slugs the worker may use. Empty = inherit from the agent. */
  sources?: string[];
  /** Skill slugs bound to this task (SOP). */
  skills?: string[];
  /** Model override for the worker. */
  model?: string;
  /**
   * Tools this task's worker may use.
   *
   * A task is a scope: the same worker role can be given a narrower tool set per
   * job ("this one only reads and greps") without inventing a new role or
   * editing a global category file. It can only narrow — asking for `bash` on a
   * supervisor task does nothing, because the role check runs first.
   */
  tools?: string[];
  /** Tools to withhold from this task even though the role allows them. */
  deniedTools?: string[];
  /** Strategy group override for the worker. */
  strategy?: string;
  /**
   * What this task compares against ("对照对象").
   *
   * A review job is meaningless without saying "against what": the target
   * branch, the previous report, the agreed spec. Free text because the answer
   * is a human reference, not a machine one.
   */
  baseline?: string;
  /**
   * True when the plan was written by the creator from what the user asked for.
   *
   * The plan stays append-only in that case: a worker may add steps it discovers, but
   * must not insert them before or between the agreed outlines, because the order the
   * user agreed to is the one they will read. A plan the worker shaped itself carries
   * no flag and keeps the original freedom entirely.
   */
  planAgreed?: boolean;
  /**
   * The slice this task is responsible for ("检查范围").
   *
   * Without it a worker either checks everything (and never finishes) or checks
   * something arbitrary (and misses the point).
   */
  scope?: string;
  deliverables?: TaskDeliverable[];
  acceptance?: TaskAcceptanceItem[];
  permissions?: TaskPermissions;
  /**
   * The worker's own checklist for this task.
   *
   * Kept on the spec so it survives session replacement and appears in the
   * cold-start brief; steps may be added or removed while the work proceeds.
   */
  plan?: PlanStep[];
}

/**
 * What may start a task.
 *
 * Only one trigger per task: a task that is both cron-driven and event-driven
 * is two tasks sharing a spec, and pretending otherwise makes "why did this
 * run?" unanswerable.
 */
export type TaskTrigger =
  | { kind: 'manual' }
  | {
      kind: 'cron';
      /** Five-field cron expression. */
      expr: string;
      timezone?: string;
      enabled: boolean;
      /** Automation matcher id this trigger was imported from, if any. */
      sourceId?: string;
    }
  | {
      kind: 'event';
      source: string;
      types?: string[];
      /** Case-insensitive substring / `a|b` alternation. */
      textMatch?: string;
      enabled: boolean;
      sourceId?: string;
    };

/** Run bookkeeping that the watchdog and the budget gate both read. */
export interface TaskStats {
  /** Completed + started runs. A retry counts. */
  runs: number;
  /** Accumulated active milliseconds (only while running). */
  activeMs: number;
  /** Last time the task proved it was alive. */
  lastHeartbeatAt?: number;
  /** Session currently holding the run lock. */
  lockSessionId?: string;
  /**
   * Times the watchdog woke this task's idle session, and when.
   *
   * A worker that ends its turn without finishing leaves the task `running` with
   * nothing driving it; waking it once is right, waking it forever is a loop that
   * costs a model call every few minutes. The count decides when to stop and hand
   * the task to a person instead.
   */
  wakeAttempts?: number;
  lastWakeAt?: number;
  /** When the current run started (epoch ms). */
  runStartedAt?: number;
  /**
   * Last time a trigger actually started a run.
   *
   * The scheduler compares this against the cron expression on startup: every
   * matching minute in between happened while the app was closed, and the gap
   * is recorded rather than silently forgotten.
   */
  lastTriggeredAt?: number;
}

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
  /**
   * Did this hand-off change anything a person needs to see?
   *
   * The timeline used to show every `report_result` call, which is not a history
   * of the task — it is a log of attempts. On the first real run the user saw seven
   * rows for one file: six rejections of the same claim and one pass, all from the
   * same session. Nothing about the task had changed in six of them.
   *
   * A hand-off is a milestone when the task's state or its executor changed —
   * handed to another agent, compacted into a new session, paused, completed, or
   * waiting on a person. Anything else stays in the record (looping detection reads
   * every attempt) but not on the timeline.
   *
   * Optional so files written before this field still load; absent means "unknown",
   * and the timeline falls back to showing it rather than hiding history.
   */
  milestone?: boolean;
  summary: string;
  keyFindings?: string[];
  nextAction?: string;
  artifacts?: HandoffArtifact[];
  verify?: HandoffVerify;
  /**
   * With `needs_decision`: the choices you are asking the person to pick between.
   *
   * A worker that stops to ask 「1.2 alone, or 1.2+2, or stop?」 used to say it only in prose,
   * so the answer card could offer nothing better than yes/no — and neither of those was
   * one of the three. These become the card's buttons; free text is always available.
   */
  options?: string[];
  /**
   * What this handoff was produced against.
   *
   * The failure loop this serves: review fails → human fixes → a new commit is
   * pushed → the review must judge *that* commit, not the old one. Older handoff
   * records keep their own revision, so history is never rewritten.
   */
  revision?: string;
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
  /** Revision the last verdict applied to, so a new commit gets a fresh round. */
  lastVerifiedRevision?: string;
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

/**
 * A pending request for the user's judgement.
 *
 * Recorded on the task rather than only in the handoff so the card can say *why*
 * it is asking, and so the deadline survives a restart.
 */
export interface TaskDecision {
  /** One of the six irreversible categories (see tasks/decisions.ts). */
  category: string;
  /** Human label shown on the card. */
  label: string;
  /** Why this reached the user. */
  reason: string;
  askedAt: number;
  /** Past this moment silence is treated as refusal. */
  deadlineAt: number;
  /** The answers the asker enumerated. Absent means approve-or-stop. */
  options?: string[];
  /** Set once the user answered or the deadline fired. */
  resolvedAt?: number;
  resolution?: 'approved' | 'rejected' | 'timeout';
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

  /** Structured execution contract (see TaskSpec). */
  spec?: TaskSpec;
  /** What starts this task. Missing = manual. */
  trigger?: TaskTrigger;
  /** Pending user decision, when pauseReason is `needs_decision`. */
  decision?: TaskDecision;
  /** Run bookkeeping. Missing on tasks created before v2. */
  stats?: TaskStats;

  /** Task-level heartbeat: proves the whole task is alive, not just a turn. */
  heartbeatIntervalMin: number;
  lastHeartbeatAt?: number;

  /** Verifier runs, for the acceptance gate's iteration cap. */
  verifyRounds?: number;

  createdAt: number;
  updatedAt: number;
  /** File schema version; bumped by normalizeTask on read. */
  version?: number;
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

/** Current task file schema version (v2 added spec/trigger/stats). */
export const TASK_VERSION = 2;

/** Consecutive failures that pause a task. */
export const FAILURE_FUSE = 3;

/** A session that has used this share of its context must be replaced. */
export const CONTEXT_ROTATE_THRESHOLD = 0.7;

/**
 * How long a decision request waits for the user before defaulting to refusal.
 *
 * Silence is not consent: a task that would delete data must not proceed because
 * nobody looked at the inbox overnight.
 */
export const DECISION_TIMEOUT_MS = 12 * 60 * 60 * 1000;
