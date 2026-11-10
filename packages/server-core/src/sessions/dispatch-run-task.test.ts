import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { TaskService } from '../tasks/task-service.ts'
import { SessionManager } from './SessionManager.ts'

/**
 * The dispatch seam: 督导派活 → a session exists → the task is bound to it.
 *
 * `TaskService` is tested link by link, and the scheduler is tested with an injected
 * `spawnRun`, so the one path they both pass through in production — `SessionManager.runTask`
 * — had no test at all. It is also where the last two live failures happened: a lock left
 * behind when a spawn failed, and a resume that spawned a second worker instead of continuing
 * the session that already held the thread.
 *
 * These tests stub the three collaborators that make it a *session* manager (`sessions`,
 * `spawnTaskRun`, `sendMessage`) and keep everything else real: the record, the lock, the
 * journal and the resume verdict are the code being tested.
 */
describe('starting a run from the supervisor’s dispatch', () => {
  let root: string
  let sm: SessionManager
  let tasks: TaskService
  let spawned: Array<{ taskId: string; sessionId: string }>
  let sent: Array<{ sessionId: string; text: string }>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sm-runtask-'))
    sm = new SessionManager()
    spawned = []
    sent = []

    // The workspace registry is global and empty in a unit test; `getTasks` is the seam.
    tasks = new TaskService({
      workspaceRoot: root,
      sessionExists: (id) => (sm as unknown as { sessions: Map<string, unknown> }).sessions.has(id),
      wakeSupervisor: () => undefined,
      stopSession: () => undefined,
    })
    ;(sm as unknown as { getTasks: unknown }).getTasks = () => tasks
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function task(overrides: { paused?: boolean } = {}) {
    const created = tasks.create({
      name: '派活验证',
      instruction: '做 1.1',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_dispatch',
      spec: {
        cwd: root,
        plan: [
          { id: '1', title: '写文件', status: 'doing' },
          { id: '1.1', title: '创建', status: 'todo', agent: 'builtin-default' },
        ],
      } as never,
    })
    if (overrides.paused) tasks.setStatus(created.id, 'paused')
    return created
  }

  function stubSpawn(result: { sessionId: string } | null) {
    ;(sm as unknown as { spawnTaskRun: unknown }).spawnTaskRun = async (
      _workspaceId: string,
      claimed: { id: string },
    ) => {
      if (!result) return null
      spawned.push({ taskId: claimed.id, sessionId: result.sessionId })
      return { ...result, taskId: claimed.id }
    }
  }

  function putSession(id: string) {
    ;(sm as unknown as { sessions: Map<string, { id: string }> }).sessions.set(id, { id })
    ;(sm as unknown as { sendMessage: unknown }).sendMessage = async (
      sessionId: string,
      text: string,
    ) => {
      sent.push({ sessionId, text })
    }
  }

  it('spawns a worker, binds it to the task, and holds the lock', async () => {
    const record = task()
    stubSpawn({ sessionId: 'sess_w1' })

    const result = await sm.runTask('ws', record.id, 'supervisor')

    expect(result.started).toBe(true)
    expect(spawned).toEqual([{ taskId: record.id, sessionId: 'sess_w1' }])

    const after = tasks.get(record.id)!
    expect(after.status).toBe('running')
    expect(after.stats?.lockSessionId).toBe('sess_w1')
    expect(after.sessionIds).toEqual(['sess_w1'])
    // One dispatch is one run: the placeholder claim and the real-id bind are one attempt.
    expect(after.stats?.runs).toBe(1)
  })

  it('gives the lock back when the spawn produced nothing', async () => {
    /**
     * The failure this pins: a claim was taken, the spawn returned null, and the task stayed
     * locked by a `pending:` id that is not a session — so it could never start again and no
     * watchdog rule could see why. `runTask` must release what it claimed.
     */
    const record = task()
    stubSpawn(null)

    const result = await sm.runTask('ws', record.id, 'supervisor')

    expect(result.started).toBe(false)
    expect(result.reason).toBe('启动 worker 失败')
    const after = tasks.get(record.id)!
    expect(after.stats?.lockSessionId).toBeUndefined()
    // The attempt is still recorded: a spawn that failed is a run that happened.
    expect(after.stats?.runs).toBe(1)
    expect(after.lifecycle.consecutiveFailures).toBe(1)
  })

  it('gives the lock back when the spawn threw', async () => {
    const record = task()
    ;(sm as unknown as { spawnTaskRun: unknown }).spawnTaskRun = async () => {
      throw new Error('disk full')
    }

    const result = await sm.runTask('ws', record.id, 'supervisor')

    expect(result.started).toBe(false)
    expect(result.reason).toBe('disk full')
    expect(tasks.get(record.id)?.stats?.lockSessionId).toBeUndefined()
  })

  it('continues the session that already holds the thread instead of spawning another', async () => {
    /**
     * Resuming is not restarting. A paused task still owns the session it was working in, and
     * that session is the conversation — what was tried, which file, which error. Spawning a
     * fresh worker makes 「继续」 mean 「start over from the brief」.
     */
    const record = task()
    stubSpawn({ sessionId: 'sess_w1' })
    await sm.runTask('ws', record.id, 'supervisor')
    await tasks.reportHandoff(
      record.id,
      { outcome: 'handoff', summary: '1.1 做完', verify: { ran: ['true'], passed: true } } as never,
      'sess_w1',
    )
    tasks.setStatus(record.id, 'paused')

    putSession('sess_w1')
    spawned.length = 0
    const result = await sm.runTask('ws', record.id, 'supervisor')

    expect(result.started).toBe(true)
    expect(spawned).toEqual([])
    expect(sent.map((entry) => entry.sessionId)).toEqual(['sess_w1'])
    // Resuming the same session is a second run, not a second worker.
    expect(tasks.get(record.id)?.stats?.runs).toBe(2)
    expect(tasks.get(record.id)?.status).toBe('running')
  })

  it('refuses to start a task whose question is still open', async () => {
    /**
     * The gate is `resumeDecisionFor`, a pure function of the record — not of the caller. A
     * supervisor that forgot it had asked could otherwise start work on the very question it
     * was waiting for an answer to.
     */
    const record = task()
    tasks.setDecisionWording(record.id, { question: '要不要继续？' })

    const result = await sm.runTask('ws', record.id, 'supervisor')

    expect(result.started).toBe(false)
    expect(result.reason).toContain('等你拍板')
    expect(spawned).toEqual([])
  })

  it('refuses to resume on a reply nobody has read yet', async () => {
    // An answer is not an authorisation: someone has to write what it meant as a directive.
    const record = task()
    tasks.setDecisionWording(record.id, { question: '要不要继续？' })
    tasks.recordDecisionAnswer(record.id, '继续吧')
    tasks.setStatus(record.id, 'paused')

    const result = await sm.runTask('ws', record.id, 'supervisor')

    expect(result.started).toBe(false)
    // The refusal names the missing directive rather than a generic block.
    expect(result.reason).toMatch(/directive|指令/)
  })

  it('leaves the status alone when only a directive is written', async () => {
    /**
     * Observed live: the supervisor wrote the authorisation boundary with `task_update`, and the
     * patch's missing `status` fell back to `running` — five milliseconds before any run existed.
     * The watchdog then read 「running, no session」 correctly and told the person the session had
     * disappeared, about a task that had not started yet.
     */
    const record = task()
    ;(sm as unknown as { spawnTaskRun: unknown }).spawnTaskRun = async () => {
      throw new Error('must not spawn for an annotation')
    }

    const result = await sm.updateTask('ws', record.id, { directive: '只做 1.1，做完就停' })

    expect(result.status).toBe('backlog')
    expect(tasks.get(record.id)?.status).toBe('backlog')
    expect(tasks.get(record.id)?.spec?.directive?.text).toBe('只做 1.1，做完就停')
    // And nothing was claimed: no lock, no session, no run counted.
    expect(tasks.get(record.id)?.stats?.lockSessionId).toBeUndefined()
    expect(tasks.get(record.id)?.stats?.runs ?? 0).toBe(0)
  })

  it('refuses to start work by changing the status, and says what to use instead', async () => {
    /**
     * This used to be the opposite assertion: `task_update({status:'running'})` started a run.
     * That is how a supervisor meaning 「update the task」 woke the worker up: it resumed with a
     * generic 「继续任务」 brief, the worker did the next step on its own, and the dispatch queued
     * behind it was refused with 「这一步已经完成了」 (live: 11:39:37 resume, 11:40:28 refused).
     *
     * `running` still means a run exists — the label is refused rather than honoured behind the
     * supervisor's back. `dispatch` is the one way to start or continue work.
     */
    const record = task()
    let spawned = 0
    ;(sm as unknown as { spawnTaskRun: unknown }).spawnTaskRun = async () => {
      spawned += 1
      return { sessionId: 'sess_w1', taskId: record.id }
    }

    await expect(sm.updateTask('ws', record.id, { status: 'running' })).rejects.toThrow(/dispatch/)
    expect(spawned).toBe(0)
    expect(tasks.get(record.id)?.status).toBe('backlog')
    expect(tasks.get(record.id)?.stats?.lockSessionId).toBeUndefined()
  })
})
