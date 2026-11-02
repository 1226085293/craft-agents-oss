import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionManager, createManagedSession } from './SessionManager.ts'

// WS2 keep-alive: when a background agent finishes while the session is IDLE, the
// completion is delivered between turns (via the persistent-query background sink →
// processEvent). Nothing consumes the result, so the agent "never returned the
// result". processEvent must wake the session with a system-generated follow-up so
// the agent reads the output and presents it — but ONLY when idle, only under
// keep-alive, and at most once per task.

type TaskCompletedEvent = {
  type: 'task_completed'
  taskId: string
  status: 'completed' | 'failed' | 'stopped'
  outputFile?: string
  output?: string
  summary?: string
}

describe('background task completion surfacing (idle keep-alive)', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-bgsurface-'))
    sm = new SessionManager()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildSession(id: string, opts?: { keepAlive?: boolean; processing?: boolean }) {
    const workspace = { id: 'ws_test', name: 'Test Workspace', rootPath: tmpRoot, createdAt: Date.now() }
    const managed = createManagedSession({ id, name: 'bg surface test' }, workspace as never, { messagesLoaded: true })
    managed.isProcessing = opts?.processing ?? false
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    // keepBackgroundTasksAlive is a readonly field resolved from env at construction;
    // override it per-test to exercise both flag states deterministically.
    ;(sm as unknown as { keepBackgroundTasksAlive: boolean }).keepBackgroundTasksAlive = opts?.keepAlive ?? true
    return managed
  }

  function registerRunningTask(sessionId: string, taskId: string, intent?: string) {
    const managed = (sm as unknown as {
      sessions: Map<string, { backgroundTaskRegistry: Map<string, unknown> }>
    }).sessions.get(sessionId)!
    managed.backgroundTaskRegistry.set(taskId, {
      taskId,
      startTime: Date.now(),
      status: 'running',
      ...(intent ? { intent } : {}),
    })
  }

  function spyOnSendMessage() {
    const calls: Array<{ msg: string; hidden?: boolean }> = []
    ;(sm as unknown as {
      sendMessage: (id: string, msg: string, a?: unknown, s?: unknown, opts?: { hidden?: boolean }) => Promise<void>
    }).sendMessage = async (_id, msg, _a, _s, opts) => {
      calls.push({ msg, hidden: opts?.hidden })
    }
    return calls
  }

  async function fireTaskCompleted(sessionId: string, event: TaskCompletedEvent) {
    const managed = (sm as unknown as { sessions: Map<string, unknown> }).sessions.get(sessionId)!
    await (sm as unknown as { processEvent: (m: unknown, e: unknown) => Promise<void> }).processEvent(managed, event)
  }

  it('surfaces a completed task to an idle keep-alive session with intent + output file', async () => {
    const sessionId = 'idle-complete'
    buildSession(sessionId, { keepAlive: true, processing: false })
    registerRunningTask(sessionId, 'task_1', "Look up today's AI news")
    const calls = spyOnSendMessage()

    await fireTaskCompleted(sessionId, {
      type: 'task_completed',
      taskId: 'task_1',
      status: 'completed',
      outputFile: '/tmp/tasks/task_1.output',
    })

    expect(calls.length).toBe(1)
    expect(calls[0]!.msg).toContain('background-task-completed')
    expect(calls[0]!.msg).toContain("Look up today's AI news")
    expect(calls[0]!.msg).toContain('/tmp/tasks/task_1.output')
    expect(calls[0]!.msg).toContain('Present the results')
    // Loop guard: the nudge must tell the agent not to re-spawn another task.
    // (Wording is "task", not "agent": the same nudge now covers handed-off
    // bash shells, which are not agents.)
    expect(calls[0]!.msg).toContain('Do NOT spawn another background task')
    // Must be hidden so it never renders as a user-authored transcript bubble.
    expect(calls[0]!.hidden).toBe(true)
  })

  it('steers the completion into the running turn instead of queueing it (2026-10-30)', async () => {
    const sessionId = 'in-turn'
    const managed = buildSession(sessionId, { keepAlive: true, processing: true })
    registerRunningTask(sessionId, 'task_2', 'Long build')
    const calls = spyOnSendMessage()
    const steered: string[] = []
    ;(managed as unknown as { agent: unknown }).agent = {
      redirect: (message: string) => {
        steered.push(message)
        return true
      },
    }

    await fireTaskCompleted(sessionId, {
      type: 'task_completed',
      taskId: 'task_2',
      status: 'completed',
      outputFile: '/tmp/tasks/task_2.output',
    })

    // Steered, not queued: a handed-off shell's tool call already returned at the
    // 30s threshold, so its result is not in the live stream. Queueing would start
    // a whole extra turn after this one; redirect folds it into the current turn.
    expect(steered.length).toBe(1)
    expect(steered[0]).toContain('background-task-completed')
    expect(steered[0]).toContain('Long build')
    expect(steered[0]).toContain('/tmp/tasks/task_2.output')
    expect(calls).toEqual([])
  })

  it('falls back to the hidden-nudge path when the backend cannot steer', async () => {
    const sessionId = 'in-turn-no-steer'
    const managed = buildSession(sessionId, { keepAlive: true, processing: true })
    registerRunningTask(sessionId, 'task_2b')
    const calls = spyOnSendMessage()
    ;(managed as unknown as { agent: unknown }).agent = { redirect: () => false }

    await fireTaskCompleted(sessionId, { type: 'task_completed', taskId: 'task_2b', status: 'completed' })

    // A backend without steering must still report the result rather than dropping it.
    expect(calls.length).toBe(1)
    expect(calls[0]!.msg).toContain('background-task-completed')
    expect(calls[0]!.hidden).toBe(true)
  })

  it('does NOT surface when keep-alive is OFF', async () => {
    const sessionId = 'keepalive-off'
    buildSession(sessionId, { keepAlive: false, processing: false })
    registerRunningTask(sessionId, 'task_3')
    const calls = spyOnSendMessage()

    await fireTaskCompleted(sessionId, { type: 'task_completed', taskId: 'task_3', status: 'completed' })

    expect(calls).toEqual([])
  })

  it('surfaces at most once even if a duplicate terminal notification arrives', async () => {
    const sessionId = 'dupe'
    buildSession(sessionId, { keepAlive: true, processing: false })
    registerRunningTask(sessionId, 'task_4', 'Investigate flake')
    const calls = spyOnSendMessage()

    await fireTaskCompleted(sessionId, { type: 'task_completed', taskId: 'task_4', status: 'completed' })
    await fireTaskCompleted(sessionId, { type: 'task_completed', taskId: 'task_4', status: 'completed' })

    expect(calls.length).toBe(1)
  })

  it('surfaces a failure with a status-appropriate message', async () => {
    const sessionId = 'failed'
    buildSession(sessionId, { keepAlive: true, processing: false })
    registerRunningTask(sessionId, 'task_5', 'Crunch numbers')
    const calls = spyOnSendMessage()

    await fireTaskCompleted(sessionId, { type: 'task_completed', taskId: 'task_5', status: 'failed' })

    expect(calls.length).toBe(1)
    expect(calls[0]!.msg).toContain('background-task-failed')
    expect(calls[0]!.msg).toContain('did not complete successfully')
    expect(calls[0]!.hidden).toBe(true)
  })

  it('returns and surfaces the captured output when a tool task is stopped', async () => {
    const sessionId = 'stop-output'
    const managed = buildSession(sessionId, { keepAlive: true, processing: false })
    const store = (sm as unknown as {
      backgroundTaskStoreFor: (m: unknown) => {
        load: () => Promise<void>
        create: (input: Record<string, unknown>) => Promise<{ id: string }>
      }
    }).backgroundTaskStoreFor(managed)
    await store.load()
    const task = await store.create({
      sessionId,
      kind: 'tool',
      externalId: 'bg_tool_stop_1',
      backgrounded: true,
    })
    ;(managed as unknown as { agent: unknown }).agent = {
      cancelBackgroundTask: async () => ({
        content: 'partial tool output',
        outputFile: '/tmp/tasks/bg_tool_stop_1.output',
        forced: false,
        isError: false,
      }),
    }
    const calls = spyOnSendMessage()

    const result = await sm.stopBackgroundTask(sessionId, task.id, 'user')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(result.message).toContain('partial tool output')
    expect(calls.length).toBe(1)
    expect(calls[0]!.msg).toContain('background-task-stopped')
    expect(calls[0]!.msg).toContain('partial tool output')
    expect(calls[0]!.hidden).toBe(true)
  })

  it('returns the captured output to the model without a user nudge', async () => {
    const sessionId = 'stop-model'
    const managed = buildSession(sessionId, { keepAlive: true, processing: false })
    const store = (sm as unknown as {
      backgroundTaskStoreFor: (m: unknown) => {
        load: () => Promise<void>
        create: (input: Record<string, unknown>) => Promise<{ id: string }>
      }
    }).backgroundTaskStoreFor(managed)
    await store.load()
    const task = await store.create({
      sessionId,
      kind: 'tool',
      externalId: 'bg_tool_stop_model',
      backgrounded: true,
    })
    ;(managed as unknown as { agent: unknown }).agent = {
      cancelBackgroundTask: async () => ({
        content: 'model-visible output',
        outputFile: '/tmp/tasks/bg_tool_stop_model.output',
        forced: false,
        isError: false,
      }),
    }
    const calls = spyOnSendMessage()
    const events: Array<{ type: string; taskId?: string }> = []
    ;(sm as unknown as { sendEvent: (event: { type: string; taskId?: string }) => void }).sendEvent = (event) => events.push(event)

    const result = await sm.stopBackgroundTask(sessionId, task.id, 'model')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(result.message).toContain('model-visible output')
    expect(calls).toEqual([])
    expect(events.some((event) => event.type === 'background_task_stopping' && event.taskId === 'bg_tool_stop_model')).toBe(true)
  })

  it('renders the wake notice as a tool process block (role: tool) with command + result', async () => {
    const sessionId = 'tool-block'
    const managed = buildSession(sessionId, { keepAlive: true, processing: false })

    // A real output file so the captured tail is non-empty.
    const outputFile = join(tmpRoot, 'shell_out.log')
    const { writeFileSync } = require('fs') as typeof import('fs')
    writeFileSync(outputFile, 'line-1\nline-2\nwaited 60s\n')

    const events: Array<{ type: string }> = []
    ;(sm as unknown as { sendEvent: (event: { type: string }) => void }).sendEvent = (event) => events.push(event)

    await (sm as unknown as {
      insertBackgroundWakeNotice: (m: unknown, text: string, params?: Record<string, string>) => void
    }).insertBackgroundWakeNotice(managed, '后台任务已完成 — shell_x', {
      taskId: 'shell_x',
      command: 'sleep 60 && echo done',
      outputFile,
      status: 'completed',
    })

    const toolMsg = managed.messages.find((m) => m.role === 'tool' && m.toolUseId === 'bg-wake-shell_x')
    expect(toolMsg).toBeDefined()
    expect(toolMsg!.toolName).toBe('Bash')
    expect(toolMsg!.toolStatus).toBe('completed')
    expect(toolMsg!.toolInput).toEqual({ command: 'sleep 60 && echo done' })
    expect(toolMsg!.toolResult).toContain('waited 60s')
    expect(toolMsg!.shellId).toBe('shell_x')
    expect(toolMsg!.isBackground).toBe(true)
    // A title row sits ABOVE the process block (green "后台任务已完成 — xxx" line).
    const infoMsg = managed.messages.find((m) => m.role === 'info' && m.statusType === 'background_wake')
    expect(infoMsg).toBeDefined()
    expect(infoMsg!.content).toContain('后台任务已完成')
    // The title row must NOT duplicate the command — it lives in the tool block.
    expect(infoMsg!.statusParams?.command).toBeUndefined()
    // The renderer gets the info title + the same tool_start/tool_result pair a real tool emits.
    expect(events.map((e) => e.type)).toEqual(['info', 'tool_start', 'tool_result'])
  })

  it('tells the model a stop was by the USER (not "user or system")', async () => {
    const sessionId = 'stop-source-user'
    const managed = buildSession(sessionId, { keepAlive: true, processing: false })
    const calls = spyOnSendMessage()

    await (sm as unknown as {
      surfaceTerminalBackgroundTask: (m: unknown, p: Record<string, unknown>) => void
    }).surfaceTerminalBackgroundTask(managed, {
      taskId: 'shell_user_stop',
      status: 'stopped',
      stopSource: 'user',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(calls.length).toBe(1)
    expect(calls[0]!.msg).toContain('[background-task-stopped]')
    expect(calls[0]!.msg).toContain('stopped by the user')
    expect(calls[0]!.msg).not.toContain('by the user or by the system')
  })

  it('tells the model a stop was by the MODEL itself', async () => {
    const sessionId = 'stop-source-model'
    const managed = buildSession(sessionId, { keepAlive: true, processing: false })
    const calls = spyOnSendMessage()

    await (sm as unknown as {
      surfaceTerminalBackgroundTask: (m: unknown, p: Record<string, unknown>) => void
    }).surfaceTerminalBackgroundTask(managed, {
      taskId: 'shell_model_stop',
      status: 'stopped',
      stopSource: 'model',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(calls.length).toBe(1)
    expect(calls[0]!.msg).toContain('stopped by you')
  })

  it('keeps the fallback phrasing when the stop source is unknown', async () => {
    const sessionId = 'stop-source-unknown'
    const managed = buildSession(sessionId, { keepAlive: true, processing: false })
    const calls = spyOnSendMessage()

    await (sm as unknown as {
      surfaceTerminalBackgroundTask: (m: unknown, p: Record<string, unknown>) => void
    }).surfaceTerminalBackgroundTask(managed, {
      taskId: 'shell_unknown_stop',
      status: 'stopped',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(calls.length).toBe(1)
    expect(calls[0]!.msg).toContain('by the user or by the system')
  })
})
