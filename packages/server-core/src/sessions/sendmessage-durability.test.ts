import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, isAbsolute, join } from 'path'
import { getSessionFilePath } from '@craft-agent/shared/sessions/storage'
import { SessionManager, createManagedSession } from './SessionManager.ts'

// Regression test for the High-severity finding in eb81086e:
//
//   sendMessage's `{ accepted, messageId }` ack contract was returning before
//   the user message hit disk because `persistSession` only enqueues with a
//   500ms debounce. A crash inside the debounce window after ack would lose
//   the message.
//
// The fix added `await this.flushSession(managed.id)` between persistSession
// and onAck. This test locks that ordering by reading the session file from
// inside the onAck callback and asserting the user message is already there.

describe('sendMessage durability', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-durability-'))
    sm = new SessionManager()
  })

  afterEach(async () => {
    await sm.flushAllSessions()
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildSession(id: string) {
    const workspace = {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id, name: 'durability test' },
      workspace as never,
      { messagesLoaded: true },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  function readPersistedMessageIds(sessionId: string): string[] {
    const path = getSessionFilePath(tmpRoot, sessionId)
    if (!existsSync(path)) return []
    const lines = readFileSync(path, 'utf-8').trim().split('\n')
    // First line is the header, remaining lines are messages.
    return lines.slice(1).map(l => JSON.parse(l)).map(m => m.id as string)
  }

  function readPersistedMessages(sessionId: string): Array<Record<string, any>> {
    const path = getSessionFilePath(tmpRoot, sessionId)
    if (!existsSync(path)) return []
    const lines = readFileSync(path, 'utf-8').trim().split('\n')
    return lines.slice(1).map(l => JSON.parse(l))
  }

  it('user message is on disk before onAck fires (normal branch)', async () => {
    const sessionId = 'durability-normal'
    buildSession(sessionId)

    let ackedMessageId: string | null = null
    let onDiskAtAck = false

    // sendMessage continues past the ack into agent-init, which would throw
    // because we haven't called `setSessionPlatform()` in this minimal test
    // harness. That's fine — we only care about the persist+flush+ack ordering
    // that happens before agent-init. Catch the post-ack rejection.
    await sm
      .sendMessage(
        sessionId,
        'hello',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        (messageId) => {
          ackedMessageId = messageId
          onDiskAtAck = readPersistedMessageIds(sessionId).includes(messageId)
        },
      )
      .catch(() => { /* expected post-ack agent-init failure */ })

    expect(ackedMessageId).not.toBeNull()
    expect(onDiskAtAck).toBe(true)
  })

  it('attachments passed without stored metadata are copied into the session before ack', async () => {
    const sessionId = 'durability-attachment'
    buildSession(sessionId)

    const sourcePath = join(tmpRoot, 'incoming.mp4')
    writeFileSync(sourcePath, Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]))

    let storedPathAtAck: string | undefined

    await sm
      .sendMessage(
        sessionId,
        '',
        [{
          type: 'unknown',
          path: sourcePath,
          name: 'incoming.mp4',
          mimeType: 'video/mp4',
          size: 8,
        }],
        undefined,
        undefined,
        undefined,
        undefined,
        () => {
          const [message] = readPersistedMessages(sessionId)
          storedPathAtAck = message?.attachments?.[0]?.storedPath
        },
      )
      .catch(() => { /* expected post-ack agent-init failure */ })

    expect(storedPathAtAck).toBeTruthy()
    expect(storedPathAtAck).not.toBe(sourcePath)
    const sessionDir = dirname(getSessionFilePath(tmpRoot, sessionId))
    const expandedStoredPath = storedPathAtAck!.replace('{{SESSION_PATH}}', sessionDir)
    const onDiskPath = isAbsolute(expandedStoredPath)
      ? expandedStoredPath
      : join(sessionDir, expandedStoredPath)
    expect(existsSync(onDiskPath)).toBe(true)
    expect(onDiskPath).toContain(join('attachments', ''))
  })

  it('user message is on disk before onAck fires (mid-stream / queued branch)', async () => {
    const sessionId = 'durability-midstream'
    const managed = buildSession(sessionId)
    // Force the mid-stream branch. Agent is null, so redirect() falls back to
    // false and the queue path runs.
    managed.isProcessing = true

    let ackedMessageId: string | null = null
    let onDiskAtAck = false

    await sm.sendMessage(
      sessionId,
      'queued message',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (messageId) => {
        ackedMessageId = messageId
        onDiskAtAck = readPersistedMessageIds(sessionId).includes(messageId)
      },
    )

    expect(ackedMessageId).not.toBeNull()
    expect(onDiskAtAck).toBe(true)
  })

  it('steer mid-stream uses native redirect when the backend supports it', async () => {
    const sessionId = 'steer-native'
    const managed = buildSession(sessionId)
    managed.isProcessing = true

    const redirected: string[] = []
    const forceAbortReasons: string[] = []
    managed.agent = {
      redirect: (message: string) => { redirected.push(message); return true },
      forceAbort: (reason: string) => { forceAbortReasons.push(reason) },
    } as never

    let ackedMessageId: string | undefined

    await sm.sendMessage(
      sessionId,
      '改为 3 分钟后发消息',
      undefined,
      undefined,
      { midStreamBehavior: 'steer' },
      undefined,
      undefined,
      (messageId) => { ackedMessageId = messageId },
    )

    expect(redirected).toEqual(['改为 3 分钟后发消息'])
    expect(forceAbortReasons).toEqual([])
    expect(managed.messageQueue).toHaveLength(0)
    expect(managed.messages.some(m => m.id === ackedMessageId && m.role === 'user')).toBe(true)
  })

  it('steer mid-stream falls back to queued replay when native redirect is unavailable', async () => {
    const sessionId = 'steer-fallback'
    const managed = buildSession(sessionId)
    managed.isProcessing = true

    const forceAbortReasons: string[] = []
    managed.agent = {
      redirect: () => { forceAbortReasons.push('redirect'); return false },
      forceAbort: (reason: string) => { forceAbortReasons.push(reason) },
    } as never

    let ackedMessageId: string | undefined

    await sm.sendMessage(
      sessionId,
      '改为 3 分钟后发消息',
      undefined,
      undefined,
      { midStreamBehavior: 'steer' },
      undefined,
      undefined,
      (messageId) => { ackedMessageId = messageId },
    )

    expect(forceAbortReasons).toEqual(['redirect'])
    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.messageQueue[0]?.message).toBe('改为 3 分钟后发消息')
    expect(managed.messageQueue[0]?.messageId).toBe(ackedMessageId)
  })

  it('cancels an already-queued user message without stopping the active turn', async () => {
    const sessionId = 'cancel-queued-message'
    const managed = buildSession(sessionId)
    managed.isProcessing = true

    let queuedMessageId: string | undefined
    await sm.sendMessage(
      sessionId,
      'queued but canceled',
      undefined,
      undefined,
      { midStreamBehavior: 'queue', optimisticMessageId: 'optimistic-cancel' },
      undefined,
      undefined,
      (messageId) => { queuedMessageId = messageId },
    )

    expect(queuedMessageId).toBeTruthy()
    expect(managed.messageQueue).toHaveLength(1)
    expect(readPersistedMessageIds(sessionId)).toContain(queuedMessageId!)

    await sm.cancelQueuedMessage(sessionId, 'optimistic-cancel')

    expect(managed.isProcessing).toBe(true)
    expect(managed.messageQueue).toHaveLength(0)
    expect(managed.messages.some(m => m.id === queuedMessageId)).toBe(false)
    expect(readPersistedMessageIds(sessionId)).not.toContain(queuedMessageId!)
  })

  it('promotes an already-queued message to immediate guidance when native steer is unavailable', async () => {
    const sessionId = 'guide-queued-message'
    const managed = buildSession(sessionId)
    managed.isProcessing = true

    const forceAbortReasons: string[] = []
    managed.agent = {
      redirect: () => { forceAbortReasons.push('redirect'); return false },
      forceAbort: (reason: string) => { forceAbortReasons.push(reason) },
    } as never

    let firstId: string | undefined
    let secondId: string | undefined
    await sm.sendMessage(sessionId, 'first queued', undefined, undefined, { midStreamBehavior: 'queue' }, undefined, undefined, id => { firstId = id })
    await sm.sendMessage(sessionId, 'second queued', undefined, undefined, { midStreamBehavior: 'queue', optimisticMessageId: 'optimistic-second' }, undefined, undefined, id => { secondId = id })

    await sm.guideQueuedMessage(sessionId, 'optimistic-second')

    expect(forceAbortReasons).toEqual(['redirect'])
    expect(managed.wasInterrupted).toBe(true)
    expect(managed.messageQueue.map(q => q.messageId)).toEqual([secondId, firstId])
    expect(managed.messageQueue[0]?.options?.midStreamBehavior).toBe('steer')
  })

  it('guides an already-queued message through native steer without interrupting the turn', async () => {
    const sessionId = 'guide-queued-native'
    const managed = buildSession(sessionId)
    managed.isProcessing = true

    const redirected: string[] = []
    const forceAbortReasons: string[] = []
    managed.agent = {
      redirect: (message: string) => { redirected.push(message); return true },
      forceAbort: (reason: string) => { forceAbortReasons.push(reason) },
    } as never

    let queuedId: string | undefined
    await sm.sendMessage(sessionId, 'native queued guidance', undefined, undefined, { midStreamBehavior: 'queue', optimisticMessageId: 'optimistic-native' }, undefined, undefined, id => { queuedId = id })

    await sm.guideQueuedMessage(sessionId, 'optimistic-native')

    expect(redirected).toEqual(['native queued guidance'])
    expect(forceAbortReasons).toEqual([])
    expect(managed.wasInterrupted).not.toBe(true)
    expect(managed.messageQueue).toHaveLength(0)
    expect(managed.messages.some(m => m.id === queuedId && m.role === 'user')).toBe(true)
  })

  it('recovers ordinary unanswered user messages after a restart gap', () => {
    const sessionId = 'recover-unanswered-user'
    const managed = buildSession(sessionId)
    managed.isProcessing = true // prevent the test from auto-draining the recovered queue
    managed.messages.push(
      { id: 'assistant-before', role: 'assistant', content: 'done', timestamp: 1 },
      { id: 'user-one', role: 'user', content: '好了吗？', timestamp: 2 },
      { id: 'user-two', role: 'user', content: '回答我！', timestamp: 3 },
    )

    ;(sm as unknown as { recoverPendingUserTurns: (managed: any) => void }).recoverPendingUserTurns(managed)

    expect(managed.messageQueue.map(q => q.messageId)).toEqual(['user-one', 'user-two'])
    expect(managed.messageQueue.map(q => q.message)).toEqual(['好了吗？', '回答我！'])
    expect(managed.messages.find(m => m.id === 'user-one')?.isQueued).toBe(true)
    expect(managed.messages.find(m => m.id === 'user-two')?.isQueued).toBe(true)
  })

  it('resumes instead of replaying a user turn that already started tool work', () => {
    const sessionId = 'recover-in-progress-turn'
    const managed = buildSession(sessionId)
    managed.isProcessing = true
    managed.messages.push(
      { id: 'assistant-before', role: 'assistant', content: 'done', timestamp: 1 },
      { id: 'restart-user', role: 'user', content: '重启 Craft 然后告诉我好了', timestamp: 2 },
      { id: 'restart-tool', role: 'tool', content: 'Running Bash...', timestamp: 3, toolName: 'Bash' },
    )

    ;(sm as unknown as { recoverPendingUserTurns: (managed: any) => void }).recoverPendingUserTurns(managed)

    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.messageQueue[0]?.messageId).toBe('restart-user')
    expect(managed.messageQueue[0]?.message).toBe('重启 Craft 然后告诉我好了')
    expect(managed.messageQueue[0]?.internalMessage).toContain('Continue the previous user request')
    expect(managed.messageQueue[0]?.internalMessage).toContain('重启 Craft 然后告诉我好了')
  })

  it('records the unfinished tool row so restart recovery can continue the same process message', () => {
    const sessionId = 'recover-tool-anchor'
    const managed = buildSession(sessionId)
    managed.isProcessing = true
    managed.messages.push(
      { id: 'assistant-before', role: 'assistant', content: 'done', timestamp: 1 },
      { id: 'restart-user', role: 'user', content: '重新打包安装并重启', timestamp: 2 },
      { id: 'build-tool', role: 'tool', content: 'Running mcp__session__bash...', timestamp: 3, toolName: 'mcp__session__bash', toolStatus: 'executing', turnId: 'old-turn' },
    )

    ;(sm as unknown as { recoverPendingUserTurns: (managed: any) => void }).recoverPendingUserTurns(managed)

    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.messageQueue[0]?.resumeToolMessageId).toBe('build-tool')
    expect(managed.messageQueue[0]?.resumeToolName).toBe('mcp__session__bash')
    expect(managed.messageQueue[0]?.resumeTurnId).toBe('old-turn')
  })

  it('reuses the unfinished tool row for the first matching recovered tool_start', async () => {
    const sessionId = 'reuse-recovered-tool-row'
    const managed = buildSession(sessionId)
    managed.pendingRecoveryTool = {
      messageId: 'build-tool',
      toolName: 'mcp__session__bash',
      turnId: 'old-turn',
    }
    managed.messages.push(
      { id: 'restart-user', role: 'user', content: '重新打包安装并重启', timestamp: 1 },
      { id: 'build-tool', role: 'tool', content: 'Running mcp__session__bash...', timestamp: 2, toolName: 'mcp__session__bash', toolStatus: 'executing', turnId: 'old-turn' },
    )

    await (sm as unknown as { processEvent: (managed: any, event: any) => Promise<void> }).processEvent(managed, {
      type: 'tool_start',
      toolName: 'mcp__session__bash',
      toolUseId: 'new-tool-use-id',
      input: { command: 'echo ok' },
      intent: 'Continue the build/install/restart verification',
      displayName: 'Build Install Restart',
      turnId: 'new-turn',
    })

    const toolMessages = managed.messages.filter(m => m.role === 'tool')
    expect(toolMessages).toHaveLength(1)
    expect(toolMessages[0]?.id).toBe('build-tool')
    expect(toolMessages[0]?.toolUseId).toBe('new-tool-use-id')
    expect(toolMessages[0]?.turnId).toBe('new-turn')
    expect(toolMessages[0]?.toolStatus).toBe('executing')
    expect(managed.pendingRecoveryTool).toBeUndefined()
  })

  it('reuses legacy unfinished tool-like rows that were persisted without role/type', async () => {
    const sessionId = 'reuse-legacy-tool-row'
    const managed = buildSession(sessionId)
    managed.isProcessing = true
    managed.messages.push(
      { id: 'assistant-before', role: 'assistant', content: 'done', timestamp: 1 },
      { id: 'restart-user', role: 'user', content: '重新打包安装并重启', timestamp: 2 },
      { id: 'legacy-build-tool', content: 'Running mcp__session__bash...', timestamp: 3, toolName: 'mcp__session__bash', toolStatus: 'executing', turnId: 'old-turn' } as any,
    )

    ;(sm as unknown as { recoverPendingUserTurns: (managed: any) => void }).recoverPendingUserTurns(managed)

    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.messageQueue[0]?.resumeToolMessageId).toBe('legacy-build-tool')
    expect(managed.messageQueue[0]?.resumeToolName).toBe('mcp__session__bash')

    managed.pendingRecoveryTool = {
      messageId: managed.messageQueue[0]!.resumeToolMessageId!,
      toolName: managed.messageQueue[0]!.resumeToolName!,
      turnId: managed.messageQueue[0]!.resumeTurnId,
    }

    await (sm as unknown as { processEvent: (managed: any, event: any) => Promise<void> }).processEvent(managed, {
      type: 'tool_start',
      toolName: 'mcp__session__bash',
      toolUseId: 'new-tool-use-id',
      input: { command: 'echo ok' },
      displayName: 'Build Install Restart',
      turnId: 'new-turn',
    })

    const reused = managed.messages.find(m => m.id === 'legacy-build-tool')
    expect(reused?.toolUseId).toBe('new-tool-use-id')
    expect(reused?.turnId).toBe('new-turn')
    expect(reused?.toolStatus).toBe('executing')
    expect(managed.messages.filter(m => m.toolName === 'mcp__session__bash')).toHaveLength(1)
  })

  it('keeps a direct recovery prompt model-only instead of persisting it as a visible user message', async () => {
    const sessionId = 'direct-recovery-prompt-guard'
    const managed = buildSession(sessionId)
    const recoveryPrompt = [
      'Continue the previous user request that was interrupted by an application restart or agent shutdown.',
      '',
      'Original user request:',
      '重启 Craft 后回复你好',
      '',
      'Important recovery instructions:',
      '- Continue safely.',
    ].join('\n')

    let seenPrompt = ''
    managed.agent = {
      supportsBranching: true,
      isProcessing: () => false,
      updateRuntimeConfig: async () => true,
      setAllSources: () => undefined,
      setSourceServers: async () => undefined,
      getSummarizeCallback: () => undefined,
      getModel: () => 'test-model',
      getSessionId: () => 'sdk-test',
      async *chat(message: string) {
        seenPrompt = message
        yield { type: 'complete' }
      },
      redirect: () => false,
      forceAbort: () => undefined,
      dispose: () => undefined,
    } as never

    await sm.sendMessage(sessionId, recoveryPrompt)

    const visibleUser = managed.messages.find(m => m.role === 'user')
    expect(visibleUser?.content).toBe('重启 Craft 后回复你好')
    expect(visibleUser?.content).not.toContain('Continue the previous user request')
    expect(seenPrompt).toBe(recoveryPrompt)
  })

  it('does not persist a recovery prompt as visible guidance during mid-stream steer', async () => {
    const sessionId = 'midstream-recovery-prompt-guard'
    const managed = buildSession(sessionId)
    managed.isProcessing = true
    const redirected: string[] = []
    managed.agent = {
      redirect: (message: string) => { redirected.push(message); return true },
      forceAbort: () => undefined,
    } as never
    const recoveryPrompt = [
      'Continue the previous user request that was interrupted by an application restart or agent shutdown.',
      '',
      'Original user request:',
      '重启 Craft 后回复你好',
      '',
      'Important recovery instructions:',
      '- Continue safely.',
    ].join('\n')

    await sm.sendMessage(sessionId, recoveryPrompt, undefined, undefined, { midStreamBehavior: 'steer' })

    const visibleUser = managed.messages.find(m => m.role === 'user')
    expect(visibleUser?.content).toBe('重启 Craft 后回复你好')
    expect(visibleUser?.content).not.toContain('Continue the previous user request')
    expect(visibleUser?.isGuidance).toBe(true)
    expect(redirected).toEqual([recoveryPrompt])
  })

  it('startup recovery hydrates assistant-intermediate unfinished sessions without waiting for user activity', async () => {
    const sessionId = 'startup-assistant-intermediate'
    const workspace = {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      {
        id: sessionId,
        name: 'startup assistant intermediate test',
        lastMessageRole: 'assistant',
        lastMessageAt: Date.now(),
        messageCount: 3,
      },
      workspace as never,
      { messagesLoaded: false },
    )
    managed.isProcessing = true
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)

    const file = getSessionFilePath(tmpRoot, sessionId)
    mkdirSync(dirname(file), { recursive: true })
    const tokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 }
    const header = {
      id: sessionId,
      workspaceRootPath: tmpRoot,
      name: 'startup assistant intermediate test',
      createdAt: 1,
      lastUsedAt: Date.now(),
      messageCount: 3,
      lastMessageRole: 'assistant',
      tokenUsage,
    }
    const messages = [
      { id: 'assistant-before', type: 'assistant', content: 'done', timestamp: 1 },
      { id: 'startup-user', type: 'user', content: '重启 Craft 后回复你好', timestamp: 2 },
      { id: 'startup-thinking', type: 'assistant', content: '好的，我现在重启 Craft', timestamp: 3, isIntermediate: true },
    ]
    writeFileSync(file, [JSON.stringify(header), ...messages.map(m => JSON.stringify(m))].join('\n') + '\n', 'utf-8')

    ;(sm as unknown as { scheduleStartupPendingTurnRecovery: () => void }).scheduleStartupPendingTurnRecovery()
    await new Promise(resolve => setImmediate(resolve))

    expect(managed.messagesLoaded).toBe(true)
    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.messageQueue[0]?.message).toBe('重启 Craft 后回复你好')
    expect(managed.messageQueue[0]?.internalMessage).toContain('Continue the previous user request')
  })

  it('startup recovery also scans already-loaded sessions', async () => {
    const sessionId = 'startup-loaded-unfinished-turn'
    const managed = buildSession(sessionId)
    managed.messagesLoaded = true
    managed.lastMessageRole = 'tool'
    managed.lastMessageAt = Date.now()
    managed.isProcessing = true
    managed.messages.push(
      { id: 'assistant-before', role: 'assistant', content: 'done', timestamp: 1 },
      { id: 'startup-user', role: 'user', content: '重启 Craft 后回复你好', timestamp: 2 },
      { id: 'startup-tool', role: 'tool', content: 'Running Bash...', timestamp: 3, toolName: 'Bash', toolUseId: 'tool-1', toolStatus: 'executing' },
    )

    ;(sm as unknown as { scheduleStartupPendingTurnRecovery: () => void }).scheduleStartupPendingTurnRecovery()
    await new Promise(resolve => setImmediate(resolve))

    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.messageQueue[0]?.message).toBe('重启 Craft 后回复你好')
    expect(managed.messageQueue[0]?.internalMessage).toContain('Continue the previous user request')
    expect(managed.messageQueue[0]?.resumeToolMessageId).toBe('startup-tool')
  })

  it('startup recovery hydrates likely unfinished sessions without waiting for user activity', async () => {
    const sessionId = 'startup-unfinished-turn'
    const workspace = {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      {
        id: sessionId,
        name: 'startup test',
        lastMessageRole: 'tool',
        lastMessageAt: Date.now(),
        messageCount: 3,
      },
      workspace as never,
      { messagesLoaded: false },
    )
    // Keep the queue from auto-replaying; this test only verifies startup scan/hydration.
    managed.isProcessing = true
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)

    const file = getSessionFilePath(tmpRoot, sessionId)
    mkdirSync(dirname(file), { recursive: true })
    const tokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 }
    const header = {
      id: sessionId,
      workspaceRootPath: tmpRoot,
      name: 'startup test',
      createdAt: 1,
      lastUsedAt: Date.now(),
      messageCount: 3,
      lastMessageRole: 'tool',
      tokenUsage,
    }
    const messages = [
      { id: 'assistant-before', type: 'assistant', content: 'done', timestamp: 1 },
      { id: 'startup-user', type: 'user', content: '重启 Craft 然后告诉我好了', timestamp: 2 },
      { id: 'startup-tool', type: 'tool', content: 'Running Bash...', timestamp: 3, toolName: 'Bash' },
    ]
    writeFileSync(file, [JSON.stringify(header), ...messages.map(m => JSON.stringify(m))].join('\n') + '\n', 'utf-8')

    ;(sm as unknown as { scheduleStartupPendingTurnRecovery: () => void }).scheduleStartupPendingTurnRecovery()
    await new Promise(resolve => setImmediate(resolve))

    expect(managed.messagesLoaded).toBe(true)
    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.messageQueue[0]?.message).toBe('重启 Craft 然后告诉我好了')
    expect(managed.messageQueue[0]?.internalMessage).toContain('Continue the previous user request')
  })

  it('does not recover guidance or user messages before a terminal response', () => {
    const sessionId = 'recover-skip-guidance'
    const managed = buildSession(sessionId)
    managed.isProcessing = true
    managed.messages.push(
      { id: 'old-user', role: 'user', content: 'old', timestamp: 1 },
      { id: 'assistant-final', role: 'assistant', content: 'answered', timestamp: 2 },
      { id: 'handled-user', role: 'user', content: 'bad request', timestamp: 3 },
      { id: 'terminal-error', role: 'error', content: 'failed', timestamp: 4 },
      { id: 'guided-user', role: 'user', content: '改为两分钟', timestamp: 5, isGuidance: true },
    )

    ;(sm as unknown as { recoverPendingUserTurns: (managed: any) => void }).recoverPendingUserTurns(managed)

    expect(managed.messageQueue).toHaveLength(0)
    expect(managed.messages.find(m => m.id === 'old-user')?.isQueued).not.toBe(true)
    expect(managed.messages.find(m => m.id === 'handled-user')?.isQueued).not.toBe(true)
    expect(managed.messages.find(m => m.id === 'guided-user')?.isQueued).not.toBe(true)
  })

  it('replays a guided queued message after the interrupted turn stops', async () => {
    const sessionId = 'guide-queued-replay'
    const managed = buildSession(sessionId)
    managed.isProcessing = true

    managed.agent = {
      redirect: () => false,
      forceAbort: () => undefined,
    } as never

    let queuedId: string | undefined
    await sm.sendMessage(sessionId, 'queued guidance', undefined, undefined, { midStreamBehavior: 'queue', optimisticMessageId: 'optimistic-guidance' }, undefined, undefined, id => { queuedId = id })
    await sm.guideQueuedMessage(sessionId, 'optimistic-guidance')

    const replayed: Array<{ message: string; existingMessageId?: string; optimisticMessageId?: string; modelMessageOverride?: string }> = []
    const originalSendMessage = sm.sendMessage.bind(sm)
    ;(sm as unknown as { sendMessage: SessionManager['sendMessage'] }).sendMessage = (async (
      _sessionId,
      message,
      _attachments,
      _storedAttachments,
      options,
      existingMessageId,
      _isAuthRetry,
      _onAck,
      modelMessageOverride,
    ) => {
      replayed.push({ message, existingMessageId, optimisticMessageId: options?.optimisticMessageId, modelMessageOverride })
    }) as SessionManager['sendMessage']

    await (sm as unknown as { onProcessingStopped: (id: string, reason: 'interrupted') => Promise<void> }).onProcessingStopped(sessionId, 'interrupted')
    await new Promise(resolve => setImmediate(resolve))

    expect(replayed).toEqual([{ message: 'queued guidance', existingMessageId: queuedId, optimisticMessageId: 'optimistic-guidance', modelMessageOverride: undefined }])
    ;(sm as unknown as { sendMessage: SessionManager['sendMessage'] }).sendMessage = originalSendMessage
  })

  it('runs agent chats for different sessions concurrently', async () => {
    const first = buildSession('concurrent-one')
    const second = buildSession('concurrent-two')

    let activeChats = 0
    let maxActiveChats = 0
    let bothStarted!: () => void
    const bothStartedPromise = new Promise<void>(resolve => { bothStarted = resolve })
    let releaseChats!: () => void
    const releaseChatsPromise = new Promise<void>(resolve => { releaseChats = resolve })

    function makeAgent(label: string) {
      return {
        supportsBranching: true,
        isProcessing: () => false,
        updateRuntimeConfig: async () => true,
        setAllSources: () => undefined,
        setSourceServers: async () => undefined,
        getSummarizeCallback: () => undefined,
        getModel: () => `test-model-${label}`,
        getSessionId: () => `sdk-${label}`,
        async *chat() {
          activeChats++
          maxActiveChats = Math.max(maxActiveChats, activeChats)
          if (activeChats === 2) bothStarted()
          await releaseChatsPromise
          try {
            yield { type: 'complete' }
          } finally {
            activeChats--
          }
        },
        redirect: () => false,
        forceAbort: () => undefined,
        dispose: () => undefined,
      }
    }

    first.agent = makeAgent('one') as never
    second.agent = makeAgent('two') as never

    const firstSend = sm.sendMessage(first.id, 'first')
    const secondSend = sm.sendMessage(second.id, 'second')

    await bothStartedPromise
    expect(maxActiveChats).toBe(2)

    releaseChats()
    await Promise.all([firstSend, secondSend])
  })
})
