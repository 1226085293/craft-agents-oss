/**
 * Sub-session result hand-back.
 *
 * Regression: 2026-10-25 `261025-dynamic-crow` spawned `261025-agile-lotus`,
 * told the user "结果出来后我会汇总给你", ended its turn, and the child's answer
 * landed 2 minutes later in a session nobody was watching. `spawn_session` is
 * fire-and-forget; the completion seam used to be consumed only by the Tasks
 * Conductor, so ad-hoc children reported to no one.
 */

import { describe, expect, it, mock } from 'bun:test'

import { SessionManager } from './SessionManager.ts'
import {
  SPAWN_NOTICE_MAX_CHARS,
  buildSpawnCompletionNotice,
  shouldNotifyParent,
} from './spawn-completion-notice'

const child = (over: Record<string, unknown> = {}) => ({
  id: '261025-agile-lotus',
  name: 'craft-git-status',
  parentSessionId: '261025-dynamic-crow',
  isArchived: false,
  messages: [{ id: 'm-final', role: 'assistant', content: '44 改 + 4 新增' }],
  ...over,
})

function notify(sm: Record<string, unknown>, childSession: Record<string, unknown>) {
  ;(SessionManager.prototype as unknown as {
    notifySpawnParent: (c: unknown, r: string, id?: string) => void
  }).notifySpawnParent.call(sm, childSession, 'complete', 'm-final')
}

describe('shouldNotifyParent', () => {
  it('reports an ordinary spawned child to its parent', () => {
    expect(shouldNotifyParent(child(), true)).toBe(true)
  })

  it('stays quiet without a parent to report to', () => {
    expect(shouldNotifyParent(child({ parentSessionId: undefined }), true)).toBe(false)
    expect(shouldNotifyParent(child(), false)).toBe(false)
    expect(shouldNotifyParent(null, true)).toBe(false)
  })

  it('leaves Conductor children to the TaskRunner', () => {
    // The runner subscribes to onSessionComplete itself and drives the node to
    // done/failed; a second notice would ask the orchestrator to summarize a
    // node it is still sequencing.
    expect(shouldNotifyParent(child({ taskRunId: 'run_1' }), true)).toBe(false)
  })

  it('ignores draft orchestrators and hidden helper sessions', () => {
    expect(shouldNotifyParent(child({ taskDraft: true }), true)).toBe(false)
    expect(shouldNotifyParent(child({ hidden: true }), true)).toBe(false)
  })
})

describe('buildSpawnCompletionNotice', () => {
  it('names the child and quotes its answer', () => {
    const notice = buildSpawnCompletionNotice(child(), 'complete', '44 改 + 4 新增')
    expect(notice).toContain('[subtask-complete]')
    expect(notice).toContain('"craft-git-status"')
    expect(notice).toContain('261025-agile-lotus')
    expect(notice).toContain('44 改 + 4 新增')
    expect(notice).toContain('Do not spawn a duplicate sub-session')
  })

  it('says so when the child produced no text', () => {
    expect(buildSpawnCompletionNotice(child(), 'complete', '  ')).toContain(
      '(the sub-session produced no text output)',
    )
  })

  it('truncates a long answer and points at the child session', () => {
    const notice = buildSpawnCompletionNotice(child(), 'complete', 'x'.repeat(SPAWN_NOTICE_MAX_CHARS + 100))
    expect(notice.length).toBeLessThan(SPAWN_NOTICE_MAX_CHARS + 400)
    expect(notice).toContain('truncated')
    expect(notice).toContain('261025-agile-lotus')
  })

  it('does not tell the model to retry silently after a failure', () => {
    const notice = buildSpawnCompletionNotice(child(), 'error', 'boom')
    expect(notice).toContain('[subtask-error]')
    expect(notice).toContain('failed')
    expect(notice).toContain('Do not retry silently')
  })
})

describe('SessionManager.notifySpawnParent', () => {
  it('delivers the result to an idle parent as a hidden message', () => {
    const sendMessage = mock(() => Promise.resolve('msg_1' as never))
    const parent = { id: '261025-dynamic-crow', isArchived: false }
    notify(
      { sessions: new Map([[parent.id, parent]]), sendMessage },
      child(),
    )

    expect(sendMessage).toHaveBeenCalledTimes(1)
    const [target, text, , , options] = sendMessage.mock.calls[0] as unknown as [
      string,
      string,
      unknown,
      unknown,
      { hidden?: boolean },
    ]
    expect(target).toBe(parent.id)
    expect(text).toContain('[subtask-complete]')
    expect(text).toContain('44 改 + 4 新增')
    // Hidden, exactly like the background-task-completion nudge: the parent
    // wakes up and answers visibly instead of showing a fake user bubble.
    expect(options).toEqual({ hidden: true })
  })

  it('never notifies for a Conductor child', () => {
    const sendMessage = mock(() => Promise.resolve('msg_1' as never))
    const parent = { id: '261025-dynamic-crow', isArchived: false }
    notify({ sessions: new Map([[parent.id, parent]]), sendMessage }, child({ taskRunId: 'run_1' }))
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('drops the notice when the parent is gone or archived', () => {
    const sendMessage = mock(() => Promise.resolve('msg_1' as never))
    notify({ sessions: new Map(), sendMessage }, child())
    expect(sendMessage).not.toHaveBeenCalled()

    const archived = { id: '261025-dynamic-crow', isArchived: true }
    notify({ sessions: new Map([[archived.id, archived]]), sendMessage }, child())
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('swallows a failing delivery instead of breaking the child turn', async () => {
    const sendMessage = mock(() => Promise.reject(new Error('parent is gone')))
    const parent = { id: '261025-dynamic-crow', isArchived: false }
    notify({ sessions: new Map([[parent.id, parent]]), sendMessage }, child())
    await Promise.resolve()
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })
})
