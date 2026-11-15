/**
 * Task storage.
 *
 * Layout under `<workspace>/tasks/`:
 *
 *   index.json      — light list (id/name/status/updatedAt) for the sidebar
 *   T-1.json        — full task, written atomically
 *   T-1.journal.jsonl — append-only event log (created/assigned/handoff/...)
 *
 * Deliberately not sqlite: the event centre already owns a database, task
 * counts are small, and a JSON file can be read by a human when something goes
 * wrong at 3am. All writes go through a serial queue per workspace.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import {
  DEFAULT_BUDGET,
  DEFAULT_HEARTBEAT_MINUTES,
  TASK_INDEX_VERSION,
  TASK_VERSION,
  type Task,
  type TaskIndex,
  type TaskIndexEntry,
  type TaskSpec,
  type TaskStatus,
  type TaskTrigger,
} from './types.ts';
import { applyDerivedStatuses, normalizePlan } from './plan.ts';
import { normalizeTriggers, primaryTrigger } from './normalize.ts';

export function getTasksDir(workspaceRoot: string): string {
  return join(workspaceRoot, 'tasks');
}

export function getTaskPath(workspaceRoot: string, id: string): string {
  return join(getTasksDir(workspaceRoot), `${id}.json`);
}

export function getJournalPath(workspaceRoot: string, id: string): string {
  return join(getTasksDir(workspaceRoot), `${id}.journal.jsonl`);
}

export function getIndexPath(workspaceRoot: string): string {
  return join(getTasksDir(workspaceRoot), 'index.json');
}

function ensureDir(workspaceRoot: string): void {
  mkdirSync(getTasksDir(workspaceRoot), { recursive: true });
}

/**
 * Write via a temp file + rename so a crash never leaves a half-written task.
 *
 * The temp name is unique per write. With one shared name (`${path}.tmp`) two writers on the same
 * task can interleave:
 *
 *     A: writeFileSync(T-1.json.tmp, A)         → holds A
 *     B: writeFileSync(T-1.json.tmp, B)         → holds B, A's content is gone
 *     A: renameSync(T-1.json.tmp → T-1.json)    → the task now holds B under A's rename
 *     B: renameSync(T-1.json.tmp → T-1.json)    → the name is gone; this throws
 *
 * That interleaving needs two writers in flight at once — a single process cannot produce it,
 * because JS runs each write to completion. A per-writer name removes the possibility outright and
 * keeps the property the rename was for: the newest write still wins, but one writer's content can
 * no longer land under another writer's rename.
 *
 * This is hardening, not a diagnosed fix. It was written while chasing a question that was written
 * to a task and then found missing from it; that disappearance was never reproduced, and this
 * change does not claim to explain it.
 */
function writeAtomic(path: string, content: string): void {
  writeSeq += 1;
  const tmp = `${path}.${process.pid}.${writeSeq}.tmp`;
  writeFileSync(tmp, content, 'utf-8');
  try {
    renameSync(tmp, path);
  } catch (error) {
    // Do not leave the scratch file behind when the rename loses a race.
    try { unlinkSync(tmp); } catch { /* nothing left to clean */ }
    throw error;
  }
}

/** Distinguishes writes within one process; `process.pid` distinguishes processes. */
let writeSeq = 0;

export function loadTask(workspaceRoot: string, id: string): Task | null {
  const path = getTaskPath(workspaceRoot, id);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Task;
    return normalizeTask(raw);
  } catch {
    return null;
  }
}

/**
 * Fill in fields that older task files predate.
 *
 * Read-side migration, not a rewrite: a task written by an older build stays
 * valid and is upgraded the next time something saves it.
 */
export function normalizeTask(task: Task): Task {
  const stats = task.stats ?? {
    runs: 0,
    activeMs: 0,
    ...(typeof task.lastHeartbeatAt === 'number' ? { lastHeartbeatAt: task.lastHeartbeatAt } : {}),
  };
  /**
   * Recompute the plan on read; touch nothing else in the spec.
   *
   * `normalizeSpec` rebuilds the whole spec from the fields it knows, which silently
   * drops anything it does not — `tools` among them. Normalising the entire spec here
   * turned "show the right icon" into "forget which tools this task may use", and the
   * scope test caught it. Only the plan needs re-deriving, so only the plan is
   * rebuilt and the rest of `spec` is passed through as found.
   */
  const plan = task.spec?.plan
    ? (applyDerivedStatuses(normalizePlan(task.spec.plan) ?? []) as typeof task.spec.plan)
    : undefined;
  const triggers = normalizeTriggers(task.triggers ?? (task.trigger ? [task.trigger] : []));
  /**
   * The field was called `currentSessionId` before it was split in two.
   *
   * Reading it forward keeps every record written by an older build usable: the value meant 「the
   * worker this run started」, which is exactly what `currentWorkerSessionId` means now. It is also
   * the honest bootstrap for `currentStageSessionId` — on an old record the only thing known about
   * who is holding the task is that worker.
   */
  const legacy = (task as { currentSessionId?: string }).currentSessionId;
  const currentWorkerSessionId = task.currentWorkerSessionId ?? legacy;
  const currentStageSessionId =
    task.currentStageSessionId ?? currentWorkerSessionId ?? task.supervisorSessionId;
  return {
    ...task,
    ...(currentWorkerSessionId ? { currentWorkerSessionId } : {}),
    ...(currentStageSessionId ? { currentStageSessionId } : {}),
    ...(task.spec && plan ? { spec: { ...task.spec, plan } } : {}),
    dependsOn: task.dependsOn ?? [],
    handoffs: task.handoffs ?? [],
    sessionIds: task.sessionIds ?? [],
    triggers,
    trigger: primaryTrigger(triggers),
    stats,
    /**
     * Six fields are defaulted on read; this was not one of them.
     *
     * `startGate` reads `shouldTripFuse(task.lifecycle)`, which dereferences
     * `lifecycle.consecutiveFailures`. A task file without that field — written by an older
     * version, hand-edited, or left behind by a failed migration — therefore crashed the resume
     * path with `Cannot read properties of undefined (reading 'consecutiveFailures')`. Observed
     * while probing a seeded task: the button reported a TypeError instead of either starting
     * the run or saying why it would not.
     *
     * A missing counter means no failures recorded, so zero is the honest default.
     */
    lifecycle: task.lifecycle ?? { errorCount: 0, consecutiveFailures: 0 },
    /**
     * Same story as `lifecycle`, found the same way.
     *
     * `reportHandoff` runs `task.verify.requirement` and spreads `...task.verify` into the next
     * state, so a task file without this field threw `Cannot read properties of undefined
     * (reading 'requirement')` in the middle of a hand-off — the report was rejected with a
     * TypeError rather than accepted or refused. Nothing recorded simply means nothing required.
     */
    verify: task.verify ?? {},
    version: TASK_VERSION,
  };
}

export function saveTask(workspaceRoot: string, task: Task): void {
  ensureDir(workspaceRoot);
  writeAtomic(getTaskPath(workspaceRoot, task.id), `${JSON.stringify(task, null, 2)}\n`);
  upsertIndex(workspaceRoot, task);
}

export function listTasks(workspaceRoot: string): Task[] {
  const dir = getTasksDir(workspaceRoot);
  if (!existsSync(dir)) return [];
  const tasks: Task[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json') || entry === 'index.json') continue;
    const task = loadTask(workspaceRoot, entry.replace(/\.json$/, ''));
    if (task) tasks.push(task);
  }
  return tasks.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Append an event to the task journal. Never rewritten, only appended. */
export function appendJournal(
  workspaceRoot: string,
  id: string,
  event: { type: string; at?: number; data?: unknown },
): void {
  ensureDir(workspaceRoot);
  const line = JSON.stringify({ at: event.at ?? Date.now(), type: event.type, data: event.data });
  appendFileSync(getJournalPath(workspaceRoot, id), `${line}\n`, 'utf-8');
}

export function readJournal(
  workspaceRoot: string,
  id: string,
): Array<{ at: number; type: string; data?: unknown }> {
  const path = getJournalPath(workspaceRoot, id);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line) as { at: number; type: string; data?: unknown };
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Array<{ at: number; type: string; data?: unknown }>;
}

// ------------------------------------------------------------
// Index
// ------------------------------------------------------------

export function loadIndex(workspaceRoot: string): TaskIndex {
  const path = getIndexPath(workspaceRoot);
  if (!existsSync(path)) {
    return { version: TASK_INDEX_VERSION, seq: 0, tasks: [] };
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<TaskIndex>;
    return {
      version: typeof raw.version === 'number' ? raw.version : TASK_INDEX_VERSION,
      seq: typeof raw.seq === 'number' ? raw.seq : 0,
      tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
    };
  } catch {
    return { version: TASK_INDEX_VERSION, seq: 0, tasks: [] };
  }
}

function saveIndex(workspaceRoot: string, index: TaskIndex): void {
  ensureDir(workspaceRoot);
  writeAtomic(getIndexPath(workspaceRoot), `${JSON.stringify(index, null, 2)}\n`);
}

function toEntry(task: Task): TaskIndexEntry {
  return {
    id: task.id,
    name: task.name,
    status: task.status,
    updatedAt: task.updatedAt,
    currentWorkerSessionId: task.currentWorkerSessionId,
    priority: task.priority,
  };
}

function upsertIndex(workspaceRoot: string, task: Task): void {
  const index = loadIndex(workspaceRoot);
  const entry = toEntry(task);
  const at = index.tasks.findIndex((t) => t.id === task.id);
  if (at >= 0) index.tasks[at] = entry;
  else index.tasks.push(entry);
  saveIndex(workspaceRoot, index);
}

/** Reserve the next human-facing id (T-1, T-2 …). */
export function nextTaskId(workspaceRoot: string): string {
  const index = loadIndex(workspaceRoot);
  const next = index.seq + 1;
  saveIndex(workspaceRoot, { ...index, seq: next });
  return `T-${next}`;
}

// ------------------------------------------------------------
// Creation
// ------------------------------------------------------------

export interface CreateTaskInput {
  id: string;
  name: string;
  instruction: string;
  supervisorSessionId: string;
  toolCallId: string;
  assigneeAgentId?: string;
  parentTaskId?: string;
  dependsOn?: string[];
  priority?: Task['priority'];
  deadline?: number | null;
  spec?: TaskSpec;
  /** One task can be due for more than one reason; the list is the source of truth. */
  triggers?: TaskTrigger[];
  /** The old single slot. Still accepted, folded into `triggers`. */
  trigger?: TaskTrigger;
  now?: number;
}

export function createTask(input: CreateTaskInput): Task {
  const now = input.now ?? Date.now();
  const triggers = normalizeTriggers([...(input.triggers ?? []), ...(input.trigger ? [input.trigger] : [])]);
  return {
    id: input.id,
    name: input.name,
    instruction: input.instruction,
    status: 'backlog',
    pauseReason: null,
    supervisorSessionId: input.supervisorSessionId,
    sessionIds: [],
    currentWorkerSessionId: undefined,
    assigneeAgentId: input.assigneeAgentId,
    parentTaskId: input.parentTaskId,
    dependsOn: input.dependsOn ?? [],
    priority: input.priority ?? 0,
    budget: { ...DEFAULT_BUDGET, activeMinutes: 120, deadline: input.deadline ?? null },
    handoffs: [],
    verify: {
      enabled: Boolean(input.spec?.acceptance?.length),
      maxIterations: 3,
      ...(input.spec?.acceptance?.length
        ? { requirement: input.spec.acceptance.map((item) => item.check).join('\n') }
        : {}),
    },
    lifecycle: { errorCount: 0, consecutiveFailures: 0 },
    origin: { supervisorSessionId: input.supervisorSessionId, toolCallId: input.toolCallId },
    spec: input.spec,
    triggers,
    trigger: primaryTrigger(triggers),
    stats: { runs: 0, activeMs: 0 },
    heartbeatIntervalMin: DEFAULT_HEARTBEAT_MINUTES,
    createdAt: now,
    updatedAt: now,
    version: TASK_VERSION,
  };
}

/** Attach a session to a task (idempotent; keeps ordering stable). */
export function attachSession(task: Task, sessionId: string, now: number): Task {
  if (task.sessionIds.includes(sessionId)) {
    return { ...task, currentWorkerSessionId: sessionId, updatedAt: now };
  }
  return {
    ...task,
    sessionIds: [...task.sessionIds, sessionId],
    currentWorkerSessionId: sessionId,
    updatedAt: now,
  };
}

/** Active (non-terminal) tasks, oldest first — what the supervisor keeps in context. */
export function activeTasks(workspaceRoot: string): Task[] {
  return listTasks(workspaceRoot)
    .filter((t) => t.status === 'running' || t.status === 'paused' || t.status === 'backlog')
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function tasksByStatus(workspaceRoot: string, status: TaskStatus): Task[] {
  return listTasks(workspaceRoot).filter((t) => t.status === status);
}

/**
 * Remove a task for good: its record, its journal, and its index entry.
 *
 * The id is deliberately *not* returned to the pool — `seq` only moves forward,
 * so a deleted T-3 stays deleted. Reusing the number would leave old log lines
 * pointing at a different task, and the journal exists to be evidence.
 *
 * Idempotent on purpose: a second click on the same menu item must not raise an
 * error about something that is already gone.
 */
export function deleteTask(workspaceRoot: string, id: string): boolean {
  let removed = false;

  for (const path of [getTaskPath(workspaceRoot, id), getJournalPath(workspaceRoot, id)]) {
    try {
      if (existsSync(path)) {
        rmSync(path, { force: true });
        removed = true;
      }
    } catch {
      // A locked file is not a reason to leave the index disagreeing with disk.
    }
  }

  const index = loadIndex(workspaceRoot);
  const before = index.tasks.length;
  index.tasks = index.tasks.filter((entry) => entry.id !== id);
  if (index.tasks.length !== before) {
    saveIndex(workspaceRoot, index);
    removed = true;
  }

  return removed;
}
