/**
 * A pause takes the task away from the worker it is stopping.
 *
 * `cancelProcessing` ends the turn that is streaming — and answers 「nothing to do」 when there is
 * no such turn, which is exactly the state of a worker that has just filed a hand-off and is
 * waiting to be woken. So the session kept its `taskId`, kept receiving work reports through it,
 * and could file another hand-off into a task that had stopped.
 *
 * Measured on T-1, paused at 07:49:42 by the failure fuse, reports still arriving at 07:52:22,
 * 07:56:49 and 08:01:46. Each one woke the supervisor, which found a paused task it could not
 * dispatch into and said something about it — one stop became three questions.
 *
 * Detaching is the half that reaches a session which is not mid-stream: the binding is what
 * authorises `report_result` against the task, so without it the session cannot reach the task at
 * all. The conversation itself is untouched.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionManager, createManagedSession } from './SessionManager.ts'

let tmpRoot: string
let sm: SessionManager

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sm-pause-detach-'))
  sm = new SessionManager()
})
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

function buildSession(id: string, taskId?: string) {
  const workspace = { id: 'ws_test', name: 'Test Workspace', rootPath: tmpRoot, createdAt: Date.now() }
  const managed = createManagedSession({ id, name: 'pause detach test' }, workspace as never, { messagesLoaded: true })
  managed.taskId = taskId
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
  return managed
}

describe('a pause detaches the worker it stopped', () => {
  it('clears the binding so the session can no longer report into the task', () => {
    const managed = buildSession('s-w', 'T-1')

    sm.detachTask('s-w', 'T-1')

    expect(managed.taskId).toBeUndefined()
  })

  it('keeps a binding that has since moved to another task', () => {
    /**
     * A session that was re-attached elsewhere keeps its new task: detaching on behalf of the old
     * one must not withdraw authority that was granted for a different job.
     */
    const managed = buildSession('s-w', 'T-2')

    sm.detachTask('s-w', 'T-1')

    expect(managed.taskId).toBe('T-2')
  })

  it('is harmless for a session that is already gone', () => {
    expect(() => sm.detachTask('s-missing', 'T-1')).not.toThrow()
  })
})
