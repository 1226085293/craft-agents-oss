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
  writeFileSync,
} from 'fs';
import { join } from 'path';
import {
  DEFAULT_BUDGET,
  DEFAULT_HEARTBEAT_MINUTES,
  TASK_INDEX_VERSION,
  type Task,
  type TaskIndex,
  type TaskIndexEntry,
  type TaskStatus,
} from './types.ts';

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

/** Write via a temp file + rename so a crash never leaves a half-written task. */
function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, path);
}

export function loadTask(workspaceRoot: string, id: string): Task | null {
  const path = getTaskPath(workspaceRoot, id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Task;
  } catch {
    return null;
  }
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
    currentSessionId: task.currentSessionId,
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
  now?: number;
}

export function createTask(input: CreateTaskInput): Task {
  const now = input.now ?? Date.now();
  return {
    id: input.id,
    name: input.name,
    instruction: input.instruction,
    status: 'backlog',
    pauseReason: null,
    supervisorSessionId: input.supervisorSessionId,
    sessionIds: [],
    currentSessionId: undefined,
    assigneeAgentId: input.assigneeAgentId,
    parentTaskId: input.parentTaskId,
    dependsOn: input.dependsOn ?? [],
    priority: input.priority ?? 0,
    budget: { ...DEFAULT_BUDGET, activeMinutes: 120, deadline: input.deadline ?? null },
    handoffs: [],
    verify: { enabled: false, maxIterations: 3 },
    lifecycle: { errorCount: 0, consecutiveFailures: 0 },
    origin: { supervisorSessionId: input.supervisorSessionId, toolCallId: input.toolCallId },
    heartbeatIntervalMin: DEFAULT_HEARTBEAT_MINUTES,
    createdAt: now,
    updatedAt: now,
  };
}

/** Attach a session to a task (idempotent; keeps ordering stable). */
export function attachSession(task: Task, sessionId: string, now: number): Task {
  if (task.sessionIds.includes(sessionId)) {
    return { ...task, currentSessionId: sessionId, updatedAt: now };
  }
  return {
    ...task,
    sessionIds: [...task.sessionIds, sessionId],
    currentSessionId: sessionId,
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
