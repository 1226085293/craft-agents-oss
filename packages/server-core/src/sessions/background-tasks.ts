/**
 * Background task store — persistent, per-session state for background tasks.
 *
 * Design contract: docs/background-tasks.md.
 *
 * The store is deliberately transport-agnostic: it owns the record lifecycle,
 * atomic persistence and idempotent transitions. SessionManager wires live
 * runtime events into it; the renderer consumes the resulting records/events.
 *
 * Lifecycle:
 *   running (only process block, <30s; never listed)
 *     -> backgrounded (listed; process block keeps the entry with a timer)
 *     -> completed_pending | stopped_pending | orphaned_pending (awaiting delivery)
 *     -> delivered (record deleted; the conversation entry keeps a snapshot)
 */

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type BackgroundTaskKind = 'bash' | 'tool' | 'subscription' | 'subagent'

export type BackgroundTaskStatus =
  | 'running'
  | 'backgrounded'
  | 'completed_pending'
  | 'stopped_pending'
  | 'orphaned_pending'
  | 'delivered'

export type BackgroundTaskStopSource = 'user' | 'model' | 'session_end' | 'app_quit'

export interface BackgroundTaskRecord {
  /** Internal unique id (`bg_<sessionShort>_<counter>`); never reused. */
  id: string
  /** SDK/external id (agentId, shellId, workflow task id) when one exists. */
  externalId?: string
  sessionId: string
  kind: BackgroundTaskKind
  status: BackgroundTaskStatus
  intent?: string
  toolUseId?: string
  command?: string
  startedAt: number
  backgroundedAt?: number
  completedAt?: number
  outputFile?: string
  tail?: string
  exitCode?: number
  stopSource?: BackgroundTaskStopSource
  deliveredAt?: number
  deliveredMessageId?: string
  error?: string
}

export interface CreateBackgroundTaskInput {
  sessionId: string
  kind: BackgroundTaskKind
  /** Start directly as background (mode 2) instead of waiting for the 30s threshold. */
  backgrounded?: boolean
  externalId?: string
  intent?: string
  toolUseId?: string
  command?: string
  outputFile?: string
  startedAt?: number
}

export interface UpdateBackgroundTaskPatch {
  intent?: string
  outputFile?: string
  tail?: string
  exitCode?: number
  error?: string
  externalId?: string
  toolUseId?: string
  command?: string
}

const ACTIVE_STATUSES: ReadonlySet<BackgroundTaskStatus> = new Set([
  'running',
  'backgrounded',
])

const PENDING_STATUSES: ReadonlySet<BackgroundTaskStatus> = new Set([
  'completed_pending',
  'stopped_pending',
  'orphaned_pending',
])

const STORE_VERSION = 1

interface StoreFile {
  version: number
  tasks: BackgroundTaskRecord[]
}

function isActive(status: BackgroundTaskStatus): boolean {
  return ACTIVE_STATUSES.has(status)
}

function isPending(status: BackgroundTaskStatus): boolean {
  return PENDING_STATUSES.has(status)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/**
 * Per-session background task store with atomic JSON persistence.
 *
 * `now` is injectable so the 30s threshold and orphan reconciliation are
 * testable without real timers.
 */
export class BackgroundTaskStore {
  private readonly records = new Map<string, BackgroundTaskRecord>()
  private loaded = false
  private loadPromise: Promise<void> | null = null
  private saveChain: Promise<void> = Promise.resolve()
  private readonly filePath: string

  constructor(
    private readonly sessionDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.filePath = join(sessionDir, 'background-tasks.json')
  }

  /** Load records from disk. Safe to call repeatedly; only reads once. */
  async load(): Promise<void> {
    if (this.loaded) return
    if (this.loadPromise) return this.loadPromise
    const loading = (async () => {
      try {
        const raw = await readFile(this.filePath, 'utf8')
        const parsed = JSON.parse(raw) as StoreFile
        assert(parsed && typeof parsed === 'object', 'invalid background task file')
        assert(Array.isArray(parsed.tasks), 'invalid background task tasks array')
        this.records.clear()
        for (const task of parsed.tasks) {
          if (!task?.id || !task.sessionId) continue
          this.records.set(task.id, { ...task })
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        this.records.clear()
      } finally {
        this.loaded = true
        this.loadPromise = null
      }
    })()
    this.loadPromise = loading
    return loading
  }

  /** Snapshot sorted newest-first. */
  list(): BackgroundTaskRecord[] {
    return Array.from(this.records.values())
      .map((task) => ({ ...task }))
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  get(id: string): BackgroundTaskRecord | undefined {
    const task = this.records.get(id)
    return task ? { ...task } : undefined
  }

  /** Records awaiting delivery (completed/stopped/orphaned). */
  pendingDelivery(): BackgroundTaskRecord[] {
    return this.list().filter((task) => isPending(task.status))
  }

  /**
   * Create a record. Mode 1 starts as `running` (invisible to the background
   * list until `markBackgrounded`); mode 2 starts as `backgrounded`.
   */
  async create(input: CreateBackgroundTaskInput): Promise<BackgroundTaskRecord> {
    await this.load()
    const startedAt = input.startedAt ?? this.now()
    const task: BackgroundTaskRecord = {
      id: this.nextId(input.sessionId),
      sessionId: input.sessionId,
      kind: input.kind,
      status: input.backgrounded ? 'backgrounded' : 'running',
      startedAt,
      ...(input.backgrounded ? { backgroundedAt: startedAt } : {}),
      ...(input.externalId ? { externalId: input.externalId } : {}),
      ...(input.intent ? { intent: input.intent } : {}),
      ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
      ...(input.command ? { command: input.command } : {}),
      ...(input.outputFile ? { outputFile: input.outputFile } : {}),
    }
    this.records.set(task.id, task)
    await this.persist()
    return { ...task }
  }

  /** Apply a metadata-only patch while the task is not delivered. */
  async update(id: string, patch: UpdateBackgroundTaskPatch): Promise<BackgroundTaskRecord> {
    await this.load()
    const task = this.records.get(id)
    assert(task, `background task not found: ${id}`)
    assert(task.status !== 'delivered', `background task already delivered: ${id}`)
    Object.assign(task, patch)
    await this.persist()
    return { ...task }
  }

  /** Mode 1 threshold reached (or an explicit conversion). Idempotent. */
  async markBackgrounded(id: string): Promise<BackgroundTaskRecord> {
    await this.load()
    const task = this.records.get(id)
    assert(task, `background task not found: ${id}`)
    if (task.status === 'backgrounded') return { ...task }
    assert(task.status === 'running', `cannot background a task in status ${task.status}`)
    task.status = 'backgrounded'
    task.backgroundedAt = this.now()
    await this.persist()
    return { ...task }
  }

  /** Terminal completion; waits for delivery. Idempotent for pending states. */
  async complete(
    id: string,
    patch: UpdateBackgroundTaskPatch & { exitCode?: number } = {},
  ): Promise<BackgroundTaskRecord> {
    await this.load()
    const task = this.records.get(id)
    assert(task, `background task not found: ${id}`)
    if (isPending(task.status)) return { ...task }
    assert(isActive(task.status), `cannot complete a task in status ${task.status}`)
    task.status = 'completed_pending'
    task.completedAt = this.now()
    Object.assign(task, patch)
    await this.persist()
    return { ...task }
  }

  /** Stop (user/model) or turn/app interruption; waits for delivery. */
  async stop(id: string, stopSource: BackgroundTaskStopSource): Promise<BackgroundTaskRecord> {
    await this.load()
    const task = this.records.get(id)
    assert(task, `background task not found: ${id}`)
    if (isPending(task.status)) return { ...task }
    assert(isActive(task.status), `cannot stop a task in status ${task.status}`)
    task.status = 'stopped_pending'
    task.completedAt = this.now()
    task.stopSource = stopSource
    await this.persist()
    return { ...task }
  }

  /**
   * Reconcile after an app restart: anything still running/backgrounded was
   * interrupted (processes do not survive the app). Returns the affected
   * records so the caller can schedule delivery.
   */
  async markOrphaned(): Promise<BackgroundTaskRecord[]> {
    await this.load()
    const now = this.now()
    const orphaned: BackgroundTaskRecord[] = []
    for (const task of this.records.values()) {
      if (!isActive(task.status)) continue
      task.status = 'orphaned_pending'
      task.completedAt = now
      task.stopSource = 'app_quit'
      orphaned.push({ ...task })
    }
    if (orphaned.length > 0) await this.persist()
    return orphaned
  }

  /**
   * Delivery confirmed: delete the record. Must only be called after the
   * message was actually handed to the model (see docs §10). Idempotent.
   */
  async markDelivered(id: string, messageId?: string): Promise<boolean> {
    await this.load()
    const task = this.records.get(id)
    if (!task) return false
    const deliveredAt = this.now()
    if (messageId) {
      task.deliveredMessageId = messageId
      task.deliveredAt = deliveredAt
    }
    this.records.delete(id)
    await this.persist()
    return true
  }

  /** Manual delete (UI dismiss / model cleanup), regardless of status. */
  async delete(id: string): Promise<boolean> {
    await this.load()
    const existed = this.records.delete(id)
    if (existed) await this.persist()
    return existed
  }

  /** Remove a file left behind by a deleted session. */
  async destroy(): Promise<void> {
    this.records.clear()
    this.loaded = true
    try {
      await writeFile(this.filePath, JSON.stringify({ version: STORE_VERSION, tasks: [] }), 'utf8')
    } catch {
      // Best-effort: a deleted session's leftovers are harmless.
    }
  }

  private nextId(sessionId: string): string {
    const short = sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'session'
    let max = 0
    for (const id of this.records.keys()) {
      const match = new RegExp(`^bg_${short}_(\\d+)$`).exec(id)
      if (match) max = Math.max(max, Number(match[1]))
    }
    let next = max + 1
    let candidate = `bg_${short}_${next}`
    while (this.records.has(candidate)) {
      next += 1
      candidate = `bg_${short}_${next}`
    }
    return candidate
  }

  private persist(): Promise<void> {
    const snapshot: StoreFile = {
      version: STORE_VERSION,
      tasks: Array.from(this.records.values()).map((task) => ({ ...task })),
    }
    const run = this.saveChain.then(async () => {
      await mkdir(this.sessionDir, { recursive: true })
      const tmp = `${this.filePath}.tmp`
      await writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8')
      await rename(tmp, this.filePath)
    })
    this.saveChain = run.catch(() => {})
    return run
  }
}

/**
 * Read a capped tail of a text file, synchronously and never throwing.
 *
 * Used to embed the result in the background-task wake row (a `role: 'tool'`
 * process block) so the renderer can expand it inline (command + result)
 * without a round trip. Reads at most the last `maxBytes` bytes; returns
 * undefined for missing/empty files.
 */
export function readTextFileTail(filePath: string, maxBytes = 64 * 1024): string | undefined {
  try {
    if (!existsSync(filePath)) return undefined
    const size = statSync(filePath).size
    if (size <= 0) return undefined
    const start = Math.max(0, size - maxBytes)
    const length = size - start
    const fd = openSync(filePath, 'r')
    try {
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, start)
      const text = buffer.toString('utf-8')
      // Drop a possibly truncated first line when we skipped a prefix.
      const trimmed = start > 0 ? text.slice(text.indexOf('\n') + 1) : text
      return trimmed.length > 0 ? trimmed : undefined
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
}
