/**
 * Public surface of the tasks module.
 */

export type {
  Handoff,
  HandoffArtifact,
  HandoffOutcome,
  HandoffVerify,
  Task,
  TaskBudget,
  TaskIndex,
  TaskIndexEntry,
  TaskLifecycle,
  TaskOrigin,
  TaskPauseReason,
  TaskPriority,
  TaskStatus,
  TaskVerifyConfig,
} from './types.ts';

export {
  CONTEXT_ROTATE_THRESHOLD,
  DEFAULT_BUDGET,
  DEFAULT_HEARTBEAT_MINUTES,
  FAILURE_FUSE,
  TASK_INDEX_VERSION,
} from './types.ts';

export {
  applyTransition,
  assertTransition,
  canTransition,
  checkBudget,
  checkHandoffRules,
  IllegalTransitionError,
  isHeartbeatStalled,
  isTerminal,
  normalizeHandoff,
  recordRunResult,
  shouldRotateSession,
  shouldTripFuse,
} from './state.ts';

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
  readJournal,
  saveTask,
  tasksByStatus,
} from './store.ts';
