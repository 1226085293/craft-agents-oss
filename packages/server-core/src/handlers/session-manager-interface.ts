/**
 * ISessionManager — abstract interface for the session lifecycle engine.
 *
 * Handler code in server-core programs against this interface;
 * concrete implementations (Electron SessionManager, headless, etc.)
 * satisfy it at runtime.
 */

import type { Workspace, WorkspaceInfo, ActiveSessionInfo } from '@craft-agent/core/types'
import type { StoredAttachment, AnnotationV1 } from '@craft-agent/core/types'
import type { PermissionMode } from '@craft-agent/shared/agent/mode-types'
import type { ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels'
import type { AuthResult } from '@craft-agent/shared/agent'
import type { LLMQueryRequest, LLMQueryResult } from '@craft-agent/shared/agent/llm-tool'
import type { ModelRequestKind } from '@craft-agent/shared/config'
import type { IMessagingGatewayRegistry } from './messaging-registry-interface'
import type {
  Session,
  CreateSessionOptions,
  FileAttachment,
  SendMessageOptions,
  PermissionResponseOptions,
  CredentialResponse,
  PermissionModeState,
  UnreadSummary,
  ShareResult,
} from '@craft-agent/shared/protocol'
import type { SessionBundle, DispatchMode, FolderScope } from '@craft-agent/shared/sessions'
import type { EventSink } from '../transport'

export type BusyMessageDecisionAction = 'reply' | 'ignore' | 'queue' | 'abort'

export interface BusyMessageDecisionInput {
  platform: string
  userMessage: string
  sessionId: string
  channelName?: string
  isBusy: true
}

export interface BusyMessageDecision {
  action: BusyMessageDecisionAction
  replyText?: string
}

export type GroupChatDecisionAction = 'reply' | 'ignore'

export interface GroupChatDecisionInput {
  platform: string
  /** Group channel id (e.g. `group:<openid>`). */
  groupId: string
  userMessage: string
  /** Display name of the group, when known. */
  channelName?: string
  sessionId: string
  /** True when the sender is a workspace owner/main user — owner messages
   *  in group chat are usually directed at the bot, so decisions should
   *  lean toward replying. */
  senderIsOwner?: boolean
}

export interface GroupChatDecision {
  action: GroupChatDecisionAction
}

export interface ISessionManager {
  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  waitForInit(): Promise<void>
  initialize(): Promise<void>
  cleanup(): void
  setEventSink(sink: EventSink): void
  flushAllSessions(): Promise<void>

  /**
   * Broadcast that workspace global memory changed (write handlers call this
   * so renderer badges/counts refresh live). Optional: headless backends that
   * do not render memory UI may omit it.
   */
  broadcastMemoryChanged?(workspaceId: string): void

  // ---------------------------------------------------------------------------
  // Session CRUD
  // ---------------------------------------------------------------------------

  getSessions(workspaceId?: string): Session[]
  getSession(sessionId: string): Promise<Session | null>
  /** Creates a session and (unless `internal.emitCreatedEvent === false`) announces it to the
   *  renderer so it hydrates full metadata instead of fabricating a "New Chat" placeholder. */
  createSession(
    workspaceId: string,
    options?: CreateSessionOptions,
    internal?: { emitCreatedEvent?: boolean },
  ): Promise<Session>
  /** Resolved working directory of a live session (child sessions inherit the orchestrator's cwd). */
  getSessionWorkingDirectory(sessionId: string): string | undefined
  deleteSession(sessionId: string): Promise<void>

  // ---------------------------------------------------------------------------
  // Session state
  // ---------------------------------------------------------------------------

  archiveSession(sessionId: string): Promise<void>
  unarchiveSession(sessionId: string): Promise<void>
  renameSession(sessionId: string, name: string): Promise<void>
  markSessionRead(sessionId: string): Promise<void>
  /**
   * Record that the user is actively engaged on a bound mobile/chat channel
   * (sent a message, or a read receipt arrived). Clears the unread badge and
   * prevents `onProcessingStopped` from re-marking it. Called by the gateway.
   */
  noteMobileActivity(sessionId: string): Promise<void>
  markSessionUnread(sessionId: string): Promise<void>
  markAllSessionsRead(workspaceId: string, projectId?: string): Promise<void>
  setActiveViewingSession(sessionId: string | null, workspaceId: string): void
  clearActiveViewingSession(workspaceId: string): void

  // ---------------------------------------------------------------------------
  // Session configuration
  // ---------------------------------------------------------------------------

  setSessionPermissionMode(sessionId: string, mode: PermissionMode): void
  setSessionThinkingLevel(sessionId: string, level: ThinkingLevel): void
  setSessionStrategy(sessionId: string, strategy: string): void
  updateWorkingDirectory(sessionId: string, path: string): void
  setSessionSources(sessionId: string, sourceSlugs: string[], sourceScope?: 'auto' | 'only' | 'exclude'): Promise<void>
  setSessionProjectId(sessionId: string, projectId: string | null): Promise<void>
  /** Move a session into a folder of its current scope (null = root). */
  setSessionFolder(sessionId: string, folderId: string | null): Promise<void>
  /** Batch variant; reports per-session success so the UI can retry failures. */
  setSessionFolderBulk(sessionIds: string[], folderId: string | null): Promise<{ updated: string[]; failed: string[] }>
  /** Atomic cross-scope move (project + folder + optional archive flip). */
  moveSessionToScope(sessionId: string, projectId: string | null, folderId: string | null, archived?: boolean): Promise<void>
  /** Rebind sessions living in the given folders to the target scope (folder cross-scope move). */
  rebindSessionsToFolders(workspaceId: string, fromScope: FolderScope, toScope: FolderScope, folderIdMap: Record<string, string>): Promise<void>
  /** Manual sibling order (fractional index). */
  setSessionSortOrder(sessionId: string, sortOrder: string): Promise<void>
  /** Pin/unpin within the sibling group. */
  setSessionPinned(sessionId: string, pinned: boolean): Promise<void>
  archiveFolder(workspaceId: string, scope: FolderScope, folderId: string): Promise<{ folderIds: string[]; sessionIds: string[]; archived: string[] }>
  unarchiveFolder(workspaceId: string, scope: FolderScope, folderId: string): Promise<{ restored: string[] }>
  deleteFolder(workspaceId: string, scope: FolderScope, folderId: string): Promise<{ deletedFolders: string[]; deletedSessions: string[]; archivedSessions: string[] }>
  /** Emit a SessionPathChange automation event (creation = empty oldPath, deletion = empty newPath). */
  emitPathChange(
    workspaceRootPath: string,
    params: {
      subject: 'session' | 'folder'
      sessionId?: string
      sessionName?: string
      changeType: 'folder' | 'project' | 'workingDirectory'
      oldPath: string | null
      newPath: string | null
      workingDirectory?: string
    },
  ): void
  archiveProjectSessions(projectId: string, archived: boolean): Promise<{ affected: string[] }>
  deleteProjectSessions(projectId: string): Promise<{ deleted: string[] }>
  setSessionConnection(sessionId: string, connectionSlug: string): Promise<void>
  updateSessionModel(sessionId: string, workspaceId: string, model: string | null, connection?: string): Promise<void>
  /** Hot connection switch (mid-session): live credential injection + model apply, context preserved. */
  switchSessionConnection(sessionId: string, connectionSlug: string, model?: string): Promise<void>

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  sendMessage(
    sessionId: string,
    message: string,
    attachments?: FileAttachment[],
    storedAttachments?: StoredAttachment[],
    options?: SendMessageOptions,
    existingMessageId?: string,
    _isAuthRetry?: boolean,
    onAck?: (messageId: string) => void,
    modelMessageOverride?: string,
    rpcContext?: { callerClientId?: string },
  ): Promise<void>

  /**
   * Run a session-level slash command (`/stop`).
   *
   * Shared by the desktop RPC path, the messaging gateway and the
   * `send_agent_message` tool so all three act on the session the same way and
   * can report a truthful outcome (`stopped` vs. an idle no-op). Optional so
   * test doubles and alternate hosts are not forced to implement it; callers
   * fall back to treating the text as a normal message when it is missing.
   */
  executeSessionCommand?(
    sessionId: string,
    command: { name: 'stop'; raw: string },
  ): Promise<{ name: string; stopped: boolean; queueLength: number }>
  /** Return the in-memory processing flag without hydrating full messages. */
  isSessionProcessing?(sessionId: string): boolean
  /**
   * Live agent instance backing a session, or null when it hasn't been
   * initialized yet. Used by handlers that invoke agent-owned operations.
   */
  getSessionAgent?(sessionId: string): {
    extractSessionMemories?: (options?: { strategy?: 'compaction' | 'session_end' }) => Promise<{ extracted: number; discarded: number }>
    runMiniCompletion?: (prompt: string) => Promise<string | null>
    queryLlm?: (request: LLMQueryRequest) => Promise<LLMQueryResult>
  } | null
  /**
   * Create a short-lived backend for app-level work with no session of its own
   * (memory consolidation). Routed through a strategy group like everything
   * else, and stamped with `kind` so the gateway log can attribute it.
   *
   * Throws when no group can be resolved; callers decide whether that is fatal.
   */
  createAuxiliaryAgent?(options: {
    kind: ModelRequestKind
    workspace: Workspace
    model?: string
    /** A session's group to fall back on when no dedicated one is configured. */
    sessionStrategyId?: string
  }): Promise<{
    runMiniCompletion: (prompt: string) => Promise<string | null>
    destroy: () => void
  }>
  /**
   * Lightweight side-channel decision used by messaging adapters when a user
   * sends a follow-up while the session is already running. Implementations
   * should not mutate visible history or interrupt the active run.
   */
  decideBusyMessage?(input: BusyMessageDecisionInput): Promise<BusyMessageDecision>
  /**
   * Group-chat participation decision: should the bot reply to a plain
   * (non-@) group message? Used by the router's decision gate so the bot
   * behaves like a real group member instead of echoing every message.
   * Returns `{ action: 'reply' }` to route the message into the session,
   * or `{ action: 'ignore' }` to skip it silently. Implementations should
   * not mutate visible history.
   */
  decideGroupChat?(input: GroupChatDecisionInput): Promise<GroupChatDecision>
  clearSessionMessages(sessionId: string): Promise<void>
  cancelProcessing(sessionId: string, silent?: boolean): Promise<void>
  cancelQueuedMessage(sessionId: string, messageId: string): Promise<void>
  guideQueuedMessage(sessionId: string, messageId: string): Promise<void>
  editQueuedMessage(sessionId: string, messageId: string): Promise<import('@craft-agent/shared/protocol').QueuedMessageEditResult | null>
  reorderQueuedMessages(sessionId: string, messageIds: string[]): Promise<void>
  killShell(sessionId: string, shellId: string): Promise<{ success: boolean; error?: string }>
  getTaskOutput(taskId: string): Promise<string | null>
  listPersistedBackgroundTasks(sessionId: string): Promise<Array<{
    id: string
    externalId?: string
    kind: 'bash' | 'tool' | 'subscription' | 'subagent'
    status: string
    intent?: string
    toolUseId?: string
    command?: string
    startedAt: number
    completedAt?: number
    outputFile?: string
    stopSource?: string
  }>>
  stopBackgroundTask(
    sessionId: string,
    taskId: string,
    stoppedBy?: 'model' | 'user',
  ): Promise<{
    taskId: string
    status: 'stopped'
    stoppedBy: 'model' | 'user'
    message: string
  }>

  /**
   * Subscribe to the in-process session-completion signal. Fires once per turn
   * when the session's message queue drains (true completion), carrying the stop
   * reason. Returns an unsubscribe function.
   */
  onSessionComplete(
    listener: (evt: import('../sessions/SessionManager').SessionCompletionEvent) => void,
  ): () => void
  getSessionFinalText(sessionId: string): string | undefined
  addMessageAnnotation(sessionId: string, messageId: string, annotation: AnnotationV1): void
  removeMessageAnnotation(sessionId: string, messageId: string, annotationId: string): void
  updateMessageAnnotation(
    sessionId: string,
    messageId: string,
    annotationId: string,
    patch: Partial<AnnotationV1>,
  ): void

  // ---------------------------------------------------------------------------
  // Permissions & credentials
  // ---------------------------------------------------------------------------

  respondToPermission(
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    options?: PermissionResponseOptions,
  ): boolean
  respondToCredential(sessionId: string, requestId: string, response: CredentialResponse): Promise<boolean>
  getSessionPermissionModeState(sessionId: string): PermissionModeState | null

  // ---------------------------------------------------------------------------
  // Plans
  // ---------------------------------------------------------------------------

  setPendingPlanExecution(sessionId: string, planPath: string, draftInputSnapshot?: string): Promise<void>
  markPendingPlanExecutionDispatched(sessionId: string): Promise<void>
  clearPendingPlanExecution(sessionId: string): Promise<void>
  getPendingPlanExecution(sessionId: string): { planPath: string; draftInputSnapshot?: string; awaitingCompaction: boolean; executionDispatched: boolean } | null
  markCompactionComplete(sessionId: string): Promise<void>

  /**
   * Send the plan-approval "I approve this plan, please execute it" message
   * to the session as if the user had clicked "Accept plan" in the desktop UI.
   * If the session is in Explore (safe) mode, also switches it to allow-all
   * so the plan can actually run without per-tool prompts.
   *
   * Used by the messaging gateway so Telegram/WhatsApp accept buttons produce
   * the same server-side effect as the desktop accept button.
   */
  acceptPlan(sessionId: string, planPath?: string): Promise<void>

  // ---------------------------------------------------------------------------
  // Sharing
  // ---------------------------------------------------------------------------

  shareToViewer(sessionId: string): Promise<ShareResult>
  updateShare(sessionId: string): Promise<ShareResult>
  revokeShare(sessionId: string): Promise<ShareResult>

  // ---------------------------------------------------------------------------
  // Export / Import
  // ---------------------------------------------------------------------------

  /**
   * Export a session as a portable bundle.
   * Flushes pending writes, serializes session data + files.
   * Session must be stopped before export.
   */
  exportSession(sessionId: string, workspaceId: string): Promise<SessionBundle | null>

  /**
   * Export a session as a summary-based payload for cross-server transfer.
   * Generates a mini-model summary instead of shipping the full transcript.
   */
  exportRemoteSessionTransfer(
    sessionId: string,
    workspaceId: string,
  ): Promise<import('@craft-agent/shared/protocol').RemoteSessionTransferPayload | null>

  /**
   * Import a session bundle into a target workspace.
   * Creates session directory, writes JSONL + files, registers in memory.
   * Returns the new session ID and any compatibility warnings.
   */
  importSession(
    workspaceId: string,
    bundle: SessionBundle,
    mode: DispatchMode,
  ): Promise<{ sessionId: string; warnings?: string[] }>

  /**
   * Import a summary-based remote transfer payload into a target workspace.
   */
  importRemoteSessionTransfer(
    workspaceId: string,
    payload: import('@craft-agent/shared/protocol').RemoteSessionTransferPayload,
  ): Promise<import('@craft-agent/shared/protocol').ImportRemoteSessionTransferResult>

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  getSessionPath(sessionId: string): string | null
  refreshTitle(sessionId: string): Promise<{ success: boolean; title?: string; error?: string }>
  refreshBadge(): void
  getUnreadSummary(): UnreadSummary

  // ---------------------------------------------------------------------------
  // Workspace
  // ---------------------------------------------------------------------------

  getWorkspaces(): Workspace[]
  /** Return client-safe workspace list (no rootPath) for remote clients. */
  getWorkspacesInfo(): WorkspaceInfo[]
  setupConfigWatcher(workspaceRootPath: string, workspaceId: string): void
  /**
   * Manually notify the ConfigWatcher of a file change.
   * Workaround for Bun's fs.watch on Linux not detecting atomic renames.
   */
  notifyConfigFileChange(workspaceRootPath: string, relativePath: string): void

  /**
   * Request a (re)capture of a page's preview poster. No-op unless a capturer
   * was injected (Electron main only); headless/WebUI hosts fall back to the
   * placeholder tile.
   */
  enqueuePageThumbnail(workspaceId: string, workspaceRootPath: string, slug: string): void

  // ---------------------------------------------------------------------------
  // Server-level observability
  // ---------------------------------------------------------------------------

  /** Count of sessions with active backend processes. Pass workspaceId to scope. */
  getActiveSessionCount(workspaceId?: string): number
  /** Automation summary for a workspace (count of configured automations + scheduler state). */
  getWorkspaceAutomationSummary(workspaceId: string): { automationCount: number; schedulerRunning: boolean }
  /** Active sessions across all workspaces (sessions with running backend processes). */
  getActiveSessionsInfo(): ActiveSessionInfo[]

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  reinitializeAuth(connectionSlug?: string): Promise<void>
  /**
   * Push runtime updates (e.g. capability toggles) to every active session
   * that uses the given connection. Backstopped by the lazy refresh path in
   * `getOrCreateAgent`.
   */
  refreshConnectionRuntime(connectionSlug: string): Promise<void>
  /**
   * Push gateway config changes (per-model capabilities in `llm-config.json`)
   * to every active gateway-routed session. Called from the `llmGateway.SAVE_CONFIG`
   * handler so a context-window bump reaches live Pi subprocesses immediately.
   */
  refreshGatewayRuntime(): Promise<void>
  completeAuthRequest(sessionId: string, result: AuthResult): Promise<void>
  executePromptAutomation(input: ExecutePromptAutomationInput): Promise<{ sessionId: string }>

  /**
   * Install a callback invoked from `executePromptAutomation` after a session
   * is created when the matcher declared `telegramTopic`. Wired by the
   * messaging-gateway bootstrap so the SessionManager doesn't need to import
   * the messaging package (avoids a circular package-level import).
   *
   * The callback should be best-effort: failures must not block the session.
   */
  setAutomationBinder?(
    fn: (input: { workspaceId: string; sessionId: string; topicName: string; qqChannels?: string[] }) => Promise<void>,
  ): void

  /** Inject messaging registry for session-scoped messaging tools. */
  setMessagingRegistry?(registry: IMessagingGatewayRegistry): void
}

/**
 * Input for executePromptAutomation. Options-object form replaces the
 * previous positional-args signature once the param list grew past
 * readability — new optional fields (thinkingLevel, future cwd/permissions
 * overrides) can be added without churn at every call site.
 */
export interface ExecutePromptAutomationInput {
  workspaceId: string
  workspaceRootPath: string
  prompt: string
  permissionMode?: PermissionMode
  mentions?: string[]
  llmConnection?: string
  model?: string
  /** Override the workspace default thinking level for the spawned session. */
  thinkingLevel?: ThinkingLevel
  automationName?: string
  /**
   * Optional Telegram forum-topic name. When set and the workspace has a
   * paired supergroup, the new session is bound to a topic of this name
   * (created on first use). Silently ignored when prerequisites aren't met.
   */
  telegramTopic?: string
  /** QQ group channelIds to bind the new session to (e.g. ["group:94A54DAF..."]). */
  qqChannels?: string[]
  /**
   * When `false`, `executePromptAutomation` returns as soon as the session is
   * created and the prompt is dispatched, instead of awaiting the whole turn.
   * Used by the automation **Test** action so a long run (tools / >30s output)
   * doesn't trip the RPC client timeout (craft-agents-oss#943). The session
   * still streams live and run errors are logged. Defaults to awaiting completion.
   */
  waitForCompletion?: boolean
}
