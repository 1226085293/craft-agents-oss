/**
 * Public surface of the tasks module.
 */

export type {
  Handoff,
  HandoffArtifact,
  HandoffOutcome,
  HandoffVerify,
  Task,
  TaskAcceptanceItem,
  TaskBudget,
  TaskDecision,
  TaskDeliverable,
  TaskIndex,
  TaskIndexEntry,
  TaskLifecycle,
  TaskOrigin,
  TaskPauseReason,
  TaskPermissions,
  TaskPriority,
  TaskSpec,
  TaskStats,
  TaskStatus,
  TaskTrigger,
  TaskVerifyConfig,
} from './types.ts';

export {
  CONTEXT_ROTATE_THRESHOLD,
  DECISION_TIMEOUT_MS,
  DEFAULT_BUDGET,
  DEFAULT_HEARTBEAT_MINUTES,
  FAILURE_FUSE,
  TASK_INDEX_VERSION,
  TASK_VERSION,
} from './types.ts';

export {
  acceptanceItems,
  applyTransition,
  assertTransition,
  canTransition,
  checkBudget,
  checkDependencies,
  checkHandoffRules,
  eventTriggerMatches,
  IllegalTransitionError,
  isHeartbeatMissing,
  isHeartbeatStalled,
  isNewRevision,
  isRecurring,
  isRunLocked,
  lastActivityOf,
  MAX_PROCESS_LOST_RETRIES,
  processLostRetryDue,
  resumeRefusal,
  isTerminal,
  normalizeHandoff,
  recordRunResult,
  shouldRotateSession,
  shouldTripFuse,
  TERMINAL_STATUSES,
  type ArtifactProbe,
  type TaskAcceptanceVerdict,
} from './state.ts';

export { matchesCron } from './cron.ts';

export {
  applyPlanPatch,
  normalizeAgentId,
  sameAgent,
  childrenOf,
  currentOutline,
  currentStep,
  formatPlan,
  checkAgreedPlanAppend,
  isOutlineStep,
  isPlanStepStatus,
  nextLeg,
  restructurePlan,
  openSteps,
  lastPlanChangeAt,
  normalizePlan,
  unownedSubSteps,
  PLAN_STEP_LIMIT,
  planProgress,
  planStalled,
  stepParent,
  type PlanProgress,
  type PlanStep,
  type PlanStepStatus,
} from './plan.ts';

export {
  canStartAnother,
  type ConcurrencyInput,
  type ConcurrencySource,
  type ConcurrencyVerdict,
  machineConcurrency,
  resolveConcurrency,
  WORKERS_PER_CORE,
} from './concurrency.ts';

export {
  assessDecisionRequest,
  DECISION_CATEGORIES,
  routineContinuationNote,
  type DecisionAssessment,
  type DecisionCategory,
  type DecisionSignals,
} from './decisions.ts';

export {
  normalizeSpec,
  normalizeTrigger, normalizeTriggers, primaryTrigger } from './normalize.ts';

export {
  describeTrigger,
  formatTaskBrief,
  formatLastRoundBlock,
  formatDispatchTaskContext,
  formatHandoffContext,
  formatIdleWakeBrief,
  formatPauseBrief,
  formatUnreportedBrief,
  formatNextLegBrief,
  formatPlanRuleBlock,
  formatExecutionRuleBlock,
  formatResumeBrief,
  type TaskBriefOptions,
} from './brief.ts';

export {
  activeTasks,
  appendJournal,
  attachSession,
  createTask,
  getIndexPath,
  getJournalPath,
  getTaskPath,
  getTasksDir,
  listTasks,
  loadIndex,
  loadTask,
  nextTaskId,
  deleteTask,
  normalizeTask,
  readJournal,
  saveTask,
  tasksByStatus,
} from './store.ts';
export type { PendingTrigger } from './types.ts'
export * from './completion-claim.ts'
export * from './resume-decision.ts'
export * from './answer-line.ts'
export * from './supervisor-message.ts'
export * from './answer-state.ts'
export * from './decision-queue.ts'
