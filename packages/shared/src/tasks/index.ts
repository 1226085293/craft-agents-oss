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
  isRunLocked,
  isTerminal,
  normalizeHandoff,
  recordRunResult,
  shouldRotateSession,
  shouldTripFuse,
  type ArtifactProbe,
  type TaskAcceptanceVerdict,
} from './state.ts';

export {
  normalizeSpec,
  normalizeTrigger,
} from './normalize.ts';

export {
  describeTrigger,
  formatTaskBrief,
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
  normalizeTask,
  readJournal,
  saveTask,
  tasksByStatus,
} from './store.ts';
