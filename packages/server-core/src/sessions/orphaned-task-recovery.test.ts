import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionManager, createManagedSession } from './SessionManager.ts'
import type { ManagedSession } from './SessionManager.ts'

/**
 * A session whose task was deleted must not resume the turn it was given.
 *
 * `taskboard:delete` detaches the sessions it knows about, so the button is covered. The record
 * can also disappear in ways no handler sees: a workspace restored from a backup, a migration, an
 * operator clearing `tasks/`, a delete racing a worker that is still running. In each case the
 * session keeps `taskId` and is picked up on the next boot as an interrupted turn.
 *
 * Observed: a session started itself on boot titled 「T-2 交接暂停复验」, worked through a brief for
 * a task that no longer existed, and failed a task heartbeat every 30 seconds. Its eventual
 * `reportHandoff` would have been dropped by the `taskGone` branch — the turn could never end.
 */
describe('a session whose task no longer exists', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-orphan-'))
    sm = new SessionManager()
  })

  afterEach(async () => {
    await sm.flushAllSessions()
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  /** One live task, so the test can tell "deleted" from "store unreadable". */
  function withTasks(ids: string[]) {
    const map = new Map(ids.map((id) => [id, { id }]))
    ;(sm as unknown as { getTasks: unknown }).getTasks = () => ({
      get: (id: string) => map.get(id) ?? null,
    })
  }

  function buildSession(id: string, taskId: string | undefined) {
    const workspace = { id: 'ws_test', name: 'Test Workspace', rootPath: tmpRoot, createdAt: Date.now() }
    const managed = createManagedSession(
      { id, name: 'orphan test' },
      workspace as never,
      { messagesLoaded: true },
    )
    managed.messages.push({
      id: 'msg_user_1',
      role: 'user',
      content: '# 任务 T-2：交接暂停复验\n\n继续做',
      timestamp: 1,
      isIntermediate: false,
    })
    managed.lastMessageRole = 'user'
    if (taskId) managed.taskId = taskId
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  const recover = (managed: ManagedSession) =>
    (sm as unknown as { recoverPendingUserTurns: (m: ManagedSession) => void }).recoverPendingUserTurns(managed)

  it('does not replay the turn, and drops the binding', () => {
    withTasks([]) // T-2 is gone
    const managed = buildSession('sess_orphan', 'T-2')

    recover(managed)

    // Nothing queued: the work was cancelled, so there is nothing to finish.
    expect(managed.messageQueue).toHaveLength(0)
    expect(managed.taskId).toBeUndefined()
  })

  it('does not touch the transcript', () => {
    withTasks([])
    const managed = buildSession('sess_orphan', 'T-2')
    const before = managed.messages.length

    recover(managed)

    /**
     * A notice written here does not survive.
     *
     * This runs while the session is still cold, and hydration replaces `managed.messages` with
     * what is on disk afterwards — verified on a live instance: the row was appended, persisted,
     * and gone on the next read. A notice that silently disappears is worse than none, so the
     * guard only refuses the replay and drops the binding.
     */
    expect(managed.messages).toHaveLength(before)
  })

  it('leaves a live task alone', () => {
    withTasks(['T-2'])
    const managed = buildSession('sess_live', 'T-2')

    recover(managed)

    // The ordinary path still recovers: one queued turn, binding intact.
    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.taskId).toBe('T-2')
  })

  it('leaves a session with no task alone', () => {
    withTasks([])
    const managed = buildSession('sess_plain', undefined)

    recover(managed)

    // Most sessions are not tasks; they must not be touched by a task-shaped guard.
    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.taskId).toBeUndefined()
  })
})
