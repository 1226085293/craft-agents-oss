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
  /**
   * What the person's last reply means, in the supervisor's words.
   *
   * This replaces a pair of id lists (`authorizedSteps` / `authorizedUpTo`) that tried to answer
   * the same question structurally. They failed for a reason no fix could reach: the boundary
   * was measured in a coordinate system the worker generates. Outlines are numbered up front,
   * but sub-steps are invented later, per section, from whatever the code turns out to say — so
   * 「做到 2 就停」 promised something about a namespace that did not exist yet, and the shape
   * people actually speak in (「把那个登录问题修完」) cannot be an id at all when the work spans
   * two outlines.
   *
   * The guarded party could also mint ids, so it could satisfy the gate by renaming. A boundary
   * the bounded can rewrite is friction for the honest and decoration for the rest.
   *
   * So: a model reads the reply and writes down the instruction; code compares `at` against
   * `decision.answer.at` and never reads the text. That keeps the one thing code is good for —
   * 「somebody acted on this reply」 as a fact — without faking a judgement it cannot make.
   */
  directive?: { text: string; at: number };
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
  /**
   * When the supervisor was woken to tell the person this task had paused.
   *
   * The supervisor is the only voice the user hears, and the wake is a model turn — which can die.
   * On a real run the pause landed, the wake hit a 60-second upstream silence, the retry was
   * exhausted, and the turn ended in an error: the task sat paused with nobody told and every
   * watchdog rule skipped it. This is what tells 「announced」 from 「still owed a sentence」, and
   * it lives on the record so a restart does not forget that it was said.
   */
  announcedPauseAt?: number;
  /** When the current run started (epoch ms). */
  runStartedAt?: number;
  /**
   * How many times a lost executor has been retried automatically.
   *
   * Kept on the task rather than in the watchdog's memory: the watchdog restarts with the app,
   * and a counter that reset on every boot would turn one lost process into an endless series of
   * fresh runs. One retry is the design; after that a person decides.
   */
  lostRetries?: number;
  /**
   * How many times the watchdog has asked for a decision that has no words yet.
   *
   * On the task for the same reason `lostRetries` is: the watchdog is rebuilt with the app, so a
   * counter held in memory would let one interrupted turn be nudged forever, once per boot.
   */
  unwordedRetries?: number;
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
  | 'needs_decision'
  /**
   * Stopped because a question is coming, but it has not been written down yet.
   *
   * Distinct from `needs_decision` on purpose: that one tells a person 「有人在问你」 and offers
   * them something to answer. When the supervisor stops first and words the question a turn
   * later, there is nothing to answer yet, and saying 「等你决定」 over an empty card is the state
   * that produced 「no pending decision on this task」 on send.
   *
   * The two are separated at the moment the pause is written, never by a timer: a person who is
   * typing into a card must never have it taken away because a deadline elapsed.
   */
  | 'asking'
  /**
   * Stopped on instruction, with nothing to answer.
   *
   * The authorised slice is delivered and the plan is not finished, so the task will not move
   * again on its own — but nobody asked the person anything. This used to borrow
   * `needs_decision`, which made one value answer two questions:
   *
   *   `needs_decision` — 「有人在问你」: there is a question, it belongs on a card, and the
   *                      supervisor owes the words. The watchdog chases a missing one.
   *   `awaiting_release` — 「按你的话停了」: the instruction covered what to do next (it said
   *                      stop), so there is no question to ask and nothing to chase.
   *
   * Collapsing them produced a live contradiction: the supervisor reported 「本轮授权范围完成、
   * 任务已停」, the board said 「这一段做完了，等你决定」, and the watchdog told the supervisor
   * its question was still unwritten — so it invented one and asked 「第 2 步收尾怎么走」, a
   * question the person had already answered with 「做完 1.2 就暂停」.
   *
   * Same plan model rule as everywhere else: a state that will not move on its own is not the
   * same as a state that is waiting for an answer, and one field cannot carry both.
   */
  | 'awaiting_release'
  /**
   * The executor reported and stopped, the plan still has work, and nobody took it.
   *
   * Distinct from `awaiting_release`, which says a person's instruction already covered what to do
   * next. Here nothing is decided: the worker did its slice, handed back, and the next leg never
   * started — so the run is over while the work is not. The task stayed `running` in that gap, and
   * 「进行中」 with nobody working is the state a person waits on forever.
   *
   * Observed live: the hand-off passed at 09:01:53 and the record said 进行中 until the supervisor
   * finally asked something at 09:09:04. Nobody was running the task for those seven minutes, and
   * nothing in the record said so.
   */
  | 'awaiting_dispatch'
  /**
   * Terminal acceptance hit `verify.maxIterations` without passing.
   *
   * The plan is finished, the work was re-verified the allowed number of rounds, and every round
   * failed. Another judge round is not the answer — a person is. Distinct from `failures`, which
   * the fuse derives from consecutive rejects: this cap trips on the acceptance count, whatever
   * the fuse threshold is, so a maxIterations of 1 pauses here after a single failed round.
   */
  | 'verify_exhausted';

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
  /**
   * The plan step this report covers (`1.2`).
   *
   * Without it 「这份报告是不是上一节的」 could only be guessed from timestamps, and the gate
   * that stops a section from starting without a hand-off had to accept any recent report.
   * Optional: records written before the field existed still load, and the gate falls back to
   * the timestamp for them.
   */
  stepId?: string;
  outcome: HandoffOutcome;
  /**
   * Did the acceptance gate take it?
   *
   * Every `report_result` is recorded — the looping detector needs the attempts — but an
   * attempt the gate refused is not a report. Without this the watchdog's 「stopped and
   * never filed」 rule treated a rejected attempt as a filed one, so a worker that gave up
   * after a rejection went silent: nothing to resume, nothing owed, nobody told.
   *
   * Optional so records written before this field still load; absent means "unknown", and
   * unknown is treated as accepted, which is what those records in fact were.
   */
  passed?: boolean;
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
  /**
   * Stable identity for this one question.
   *
   * A task can hold several open questions at once — the person may be asked about a failing
   * check and a boundary in the same round — so an answer has to name which one it closes.
   * Without an id the reply could only ever mean 「the newest question」, which is exactly how a
   * second question silently stole the first one's answer.
   */
  id?: string;
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
  /**
   * The question as the relaying session put it, kept alongside `reason`.
   *
   * `reason` is written by the rule that detected the situation — 「连续 3 次交接但计划没有推进
   * （当前步骤：1）」 — and that sentence is the diagnosis: why this reached a person at all.
   * The relay overwrote it with its own phrasing, so the task card's explanation of the
   * problem was replaced by a restatement of the question, and the original finding existed
   * nowhere on the task. Both texts have a job: one says what went wrong, the other says
   * what is being asked.
   */
  question?: string;
  /**
   * What the person replied, once they have.
   *
   * The card's "answered" state used to live in React state only, so a reload brought
   * the buttons back on a question that had already been answered — the one screen where
   * a stale control invites a duplicate answer. Recording it on the decision is what
   * makes the state survive the app restarting, and it keeps the reply with the record
   * it belongs to instead of only in a chat log.
   *
   * Deliberately not `resolvedAt`: the answer is the person's words, resolution is the
   * supervisor's decision about them. Keeping them separate is what stops a reply from
   * being mistaken for consent.
   */
  answer?: { text: string; at: number };
  /** Set once the user answered, the deadline fired, or the question stopped being true. */
  resolvedAt?: number;
  /**
   * When this answer was handed to the supervisor.
   *
   * Answers are collected before they are delivered: asking three things and interrupting the
   * supervisor three times is noise, and it made the supervisor act on the first reply before
   * the person had finished thinking. Delivery waits until nothing is left open, then sends
   * everything at once — this field is how 「already sent」 is told from 「answered, not yet
   * sent」, and it must survive a restart, so it lives on the record.
   */
  deliveredAt?: number;
  /**
   * When this QUESTION was shown to the person.
   *
   * The mirror of `deliveredAt`, which marks the answer going the other way. A supervisor asks
   * several things in one turn — re-reading the task, finding a second boundary, rewording the
   * first — and each `ask_user` used to draw its own card. One turn produced two cards for one
   * unresolved situation, with different buttons, and the person had to dismiss one to answer the
   * other.
   *
   * Questions are now collected during the turn and delivered once when it ends, so 「already
   * shown」 has to survive a restart for the same reason answers do: a crash between the turn
   * ending and the delivery must not lose the question, and a restart must not ask it twice.
   * On the record, not in memory, is the only place that can promise both.
   */
  questionDeliveredAt?: number;
  /**
   * How the question closed.
   *
   * `obsolete` is the third case and the one that used to masquerade as `approved`: the thing
   * being asked about disappeared (the boundary moved), so nobody approved anything. It exists
   * so a closed decision with `answer: null` can be told apart from a broken record.
   */
  resolution?: 'approved' | 'rejected' | 'timeout' | 'obsolete';
}

export interface Task {
  /** Human-facing id: T-1, T-2 … */
  id: string;
  name: string;
  /** The original request. Immutable — changing it means a new task. */
  instruction: string;
  status: TaskStatus;
  pauseReason?: TaskPauseReason | null;
  /**
   * Every question this task has asked, open and closed, oldest first.
   *
   * The single `decision` field could only hold one, so a second question overwrote the first —
   * including its answer. A task legitimately asks several things at once: a worker hands back two
   * failing checks, the supervisor stops at a boundary with two directions open. One slot turned
   * that into 「the newest question wins」, and a reply to the first was lost with it.
   *
   * `decision` is kept as a mirror of the newest open entry (see `deriveDecisionMirror`) so every
   * reader that asks 「is a question open?」 keeps working; readers that need to know *which*
   * question use this list.
   */
  decisions?: TaskDecision[];

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
  /**
   * Every way this task can start, as a list.
   *
   * One task can be due for more than one reason — 「every morning at nine」 and 「whenever a
   * github issue arrives」 are not alternatives; a person may want both on the same checklist.
   * A single slot forced a choice that the domain does not make, and the scheduler could only
   * ever evaluate one rule per task.
   *
   * `trigger` below stays as the derived single value every existing reader uses (brief, board,
   * run gate). It is written by `normalizeTask` from this list, never the other way round.
   */
  triggers?: TaskTrigger[];
  /** Derived mirror of `triggers`: the first non-manual entry, else `{ kind: 'manual' }`. */
  trigger?: TaskTrigger;
  /** Pending user decision, when pauseReason is `needs_decision`. */
  decision?: TaskDecision;
  /** Run bookkeeping. Missing on tasks created before v2. */
  stats?: TaskStats;

  /**
   * The last time a person's words reached this task, stamped by machine — never by a model.
   *
   * Three channels stamp it: a decision card answer (`recordDecisionAnswer`), and the two relay
   * entrances in `createTaskFromUser` (new task, follow-up words). Nothing else may write it,
   * because everything else is a model — and a model-stamped 「human spoke」 is exactly the
   * self-authorisation this field exists to stop.
   *
   * Read by `resumeDecisionFor` and the dispatch pause gate as 「did the person speak after the
   * question was asked?」. A decision closed without an answer (obsolete) unlocks nothing unless
   * this timestamp is newer than the question.
   */
  humanAuthAt?: number;

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
