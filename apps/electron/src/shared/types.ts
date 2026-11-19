// =============================================================================
// Protocol re-exports (channels, DTOs, events, wire types)
// =============================================================================
export * from '@craft-agent/shared/protocol'

// =============================================================================
// Package re-exports (convenience for renderer imports)
// =============================================================================

// Core types
import type {
  Message as CoreMessage,
  MessageRole as CoreMessageRole,
  TypedError,
  TokenUsage as CoreTokenUsage,
  WorkspaceInfo as CoreWorkspaceInfo,
  Workspace as CoreWorkspace,
  SessionMetadata as CoreSessionMetadata,
  StoredAttachment as CoreStoredAttachment,
  ContentBadge,
  ToolDisplayMeta,
  AnnotationV1,
} from '@craft-agent/core/types';

// Mode types from dedicated subpath export (avoids pulling in SDK)
import type { PermissionMode } from '@craft-agent/shared/agent/modes';
export type { PermissionMode };
export { PERMISSION_MODE_CONFIG } from '@craft-agent/shared/agent/modes';

// Thinking level types
import type { ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels';
export type { ThinkingLevel };
export { THINKING_LEVELS, DEFAULT_THINKING_LEVEL } from '@craft-agent/shared/agent/thinking-levels';

export type {
  CoreMessage as Message,
  CoreMessageRole as MessageRole,
  TypedError,
  CoreTokenUsage as TokenUsage,
  CoreWorkspaceInfo as WorkspaceInfo,
  CoreWorkspace as Workspace,
  CoreSessionMetadata as SessionMetadata,
  CoreStoredAttachment as StoredAttachment,
  ContentBadge,
  ToolDisplayMeta,
  AnnotationV1,
};

// Auth types for onboarding
import type { AuthState, SetupNeeds } from '@craft-agent/shared/auth/types';
import type { AuthType } from '@craft-agent/shared/config/types';
export type { AuthState, SetupNeeds, AuthType };

// Credential health types
import type { CredentialHealthStatus, CredentialHealthIssue, CredentialHealthIssueType } from '@craft-agent/shared/credentials/types';
export type { CredentialHealthStatus, CredentialHealthIssue, CredentialHealthIssueType };

// Source types for session source selection
import type { LoadedSource, FolderSourceConfig, SourceConnectionStatus } from '@craft-agent/shared/sources/types';
export type { LoadedSource, FolderSourceConfig, SourceConnectionStatus };

// Skill types
import type { LoadedSkill, SkillMetadata } from '@craft-agent/shared/skills/types';
export type { LoadedSkill, SkillMetadata };

// Usage types (source & skill usage tracking)
import type { UsageStats, UsageRecord } from '@craft-agent/shared/usage';
export type { UsageStats, UsageRecord };

// Resource bundle types (cross-workspace export/import)
import type { ExportResourcesOptions, ExportResult, ResourceImportMode, ResourceBundle, ResourceImportResult } from '@craft-agent/shared/resources';
export type { ExportResourcesOptions, ExportResult, ResourceImportMode, ResourceBundle, ResourceImportResult };

// LLM connection types
import type { LlmConnection, LlmConnectionWithStatus, LlmAuthType, LlmProviderType, NetworkProxySettings, LlmConfig as LlmConfigDto } from '@craft-agent/shared/config';
import type { LlmGatewayStatusPayload, LlmProviderDetailPayload } from '@craft-agent/shared/protocol';
export type { LlmConnection, LlmConnectionWithStatus, LlmAuthType, LlmProviderType, NetworkProxySettings };

// =============================================================================
// GUI-only types (not used by server/handler code)
// =============================================================================

/**
 * Browser toolbar window IPC channels (preload <-> BrowserPaneManager).
 * Kept separate from RPC_CHANNELS because these are scoped to toolbar windows.
 */
export const BROWSER_TOOLBAR_CHANNELS = {
  NAVIGATE: 'browser-toolbar:navigate',
  GO_BACK: 'browser-toolbar:go-back',
  GO_FORWARD: 'browser-toolbar:go-forward',
  RELOAD: 'browser-toolbar:reload',
  STOP: 'browser-toolbar:stop',
  OPEN_MENU: 'browser-toolbar:open-menu',
  HIDE: 'browser-toolbar:hide',
  DESTROY: 'browser-toolbar:destroy',
  STATE_UPDATE: 'browser-toolbar:state-update',
  THEME_COLOR: 'browser-toolbar:theme-color',
} as const

/** Tool icon mapping entry from tool-icons.json (with icon resolved to data URL) */
export interface ToolIconMapping {
  id: string
  displayName: string
  /** Data URL of the icon (e.g., data:image/png;base64,...) */
  iconDataUrl: string
  commands: string[]
}

/**
 * Browser pane creation options
 */
export interface BrowserPaneCreateOptions {
  id?: string
  show?: boolean
  bindToSessionId?: string
}

/**
 * Empty-state launch request from the browser empty-state renderer.
 */
export interface BrowserEmptyStateLaunchPayload {
  route: string
  token?: string
}

/**
 * Result of browser empty-state launch handling.
 */
export interface BrowserEmptyStateLaunchResult {
  ok: boolean
  handled: boolean
  reason?: string
}

export type TransportMode = 'local' | 'remote'

export type TransportConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'failed'

export type TransportConnectionErrorKind =
  | 'auth'
  | 'protocol'
  | 'timeout'
  | 'network'
  | 'server'
  | 'unknown'

export interface TransportConnectionError {
  kind: TransportConnectionErrorKind
  message: string
  code?: string
}

export interface TransportCloseInfo {
  code?: number
  reason?: string
  wasClean?: boolean
}

export interface TransportConnectionState {
  mode: TransportMode
  status: TransportConnectionStatus
  url: string
  attempt: number
  nextRetryInMs?: number
  lastError?: TransportConnectionError
  lastClose?: TransportCloseInfo
  updatedAt: number
}

// =============================================================================
// ElectronAPI — type-safe IPC API exposed to renderer
// =============================================================================

// Re-import types for ElectronAPI
import type { WorkspaceInfo, Workspace, SessionMetadata, StoredAttachment as StoredAttachmentType } from '@craft-agent/core/types';

// Import protocol types used by ElectronAPI (they come through the `export *` above,
// but we need them in scope for the interface definition)
import type {
  Session,
  UnreadSummary,
  CreateSessionOptions,
  FileAttachment,
  SendMessageOptions,
  SessionEvent,
  PermissionResponseOptions,
  CredentialResponse,
  SessionCommand,
  ShareResult,
  RefreshTitleResult,
  FileSearchResult,
  SessionSearchResult,
  LlmConnectionSetup,
  TestLlmConnectionParams,
  TestLlmConnectionResult,
  SkillFile,
  SessionFile,
  OAuthResult,
  McpToolsResult,
  GitBashStatus,
  UpdateInfo,
  WorkspaceSettings,
  PermissionModeState,
  BrowserInstanceInfo,
  PageWindowInfo,
  DeepLinkNavigation,
  WindowCloseRequest,
  DirectoryListingResult,
  RemoteSessionTransferPayload,
  ImportRemoteSessionTransferResult,
} from '@craft-agent/shared/protocol'

export interface ElectronAPI {
  // Session management
  getSessions(): Promise<Session[]>
  getUnreadSummary(): Promise<UnreadSummary>
  markAllSessionsRead(workspaceId: string, projectId?: string): Promise<void>
  getSessionMessages(sessionId: string): Promise<Session | null>
  createSession(workspaceId: string, options?: CreateSessionOptions): Promise<Session>
  /** The workspace's single on-duty supervisor session (created once, hidden from the list). */
  ensureSupervisorSession(workspaceId: string, lane?: 'user' | 'task'): Promise<Session>
  deleteSession(sessionId: string): Promise<void>
  sendMessage(sessionId: string, message: string, attachments?: FileAttachment[], storedAttachments?: StoredAttachmentType[], options?: SendMessageOptions): Promise<void>
  cancelProcessing(sessionId: string, silent?: boolean): Promise<void>
  killShell(sessionId: string, shellId: string): Promise<{ success: boolean; error?: string }>
  getTaskOutput(taskId: string): Promise<string | null>
  /** Persisted, not-yet-delivered background tasks for a session. */
  listBackgroundTasks(sessionId: string): Promise<Array<{
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
    status: string
    stoppedBy: string
    message: string
  }>

  respondToPermission(sessionId: string, requestId: string, allowed: boolean, alwaysAllow: boolean, options?: PermissionResponseOptions): Promise<boolean>
  respondToCredential(sessionId: string, requestId: string, response: CredentialResponse): Promise<boolean>

  // Consolidated session command handler
  sessionCommand(sessionId: string, command: SessionCommand): Promise<void | ShareResult | RefreshTitleResult | { count: number }>

  // Server info (REMOTE_ELIGIBLE — returns data from whichever server owns the workspace)
  getServerHomeDir(): Promise<string>

  // Server mode configuration
  getServerConfig(): Promise<import('@craft-agent/shared/config/server-config').ServerConfig>
  setServerConfig(config: import('@craft-agent/shared/config/server-config').ServerConfig): Promise<void>
  getServerStatus(): Promise<import('@craft-agent/shared/config/server-config').ServerStatus>

  // App lifecycle
  relaunchApp(): Promise<void>
  removeWorkspace(workspaceId: string): Promise<boolean>
  invokeOnServer(url: string, token: string, channel: string, ...args: any[]): Promise<any>

  // Remote session transfer (main-process orchestrated, supports chunked upload)
  transferSessionToWorkspace(sessionId: string, targetWorkspaceId: string, sessionIndex?: number, sessionCount?: number): Promise<{ sessionId: string }>
  onTransferProgress(callback: (progress: { sessionIndex: number; sessionCount: number; chunkSent: number; chunkTotal: number }) => void): () => void

  // Session export/import (cross-workspace transfer)
  exportSession(sessionId: string): Promise<unknown>
  importSession(targetWorkspaceId: string, bundle: unknown, mode: 'move' | 'fork'): Promise<{ sessionId: string; warnings?: string[] }>
  exportRemoteSessionTransfer(sessionId: string): Promise<RemoteSessionTransferPayload>
  importRemoteSessionTransfer(targetWorkspaceId: string, payload: RemoteSessionTransferPayload): Promise<ImportRemoteSessionTransferResult>

  // Pending plan execution (for reload recovery)
  // Permission mode reconciliation
  getSessionPermissionModeState(sessionId: string): Promise<PermissionModeState | null>

  // Workspace management
  getWorkspaces(): Promise<Workspace[]>
  createWorkspace(folderPath: string, name: string, remoteServer?: { url: string; token: string; remoteWorkspaceId: string }): Promise<Workspace>
  checkWorkspaceSlug(slug: string): Promise<{ exists: boolean; path: string }>
  updateWorkspaceRemoteServer(workspaceId: string, remoteServer: { url: string; token: string; remoteWorkspaceId: string }): Promise<{ success: boolean }>

  // Server-level workspace operations (for thin client / remote workspace discovery)
  getServerWorkspaces(): Promise<WorkspaceInfo[]>
  createServerWorkspace(name: string): Promise<WorkspaceInfo>

  testRemoteConnection(url: string, token: string): Promise<{
    ok: boolean
    error?: string
    needsWorkspace?: boolean
    remoteWorkspaces?: Array<{ id: string; name: string }>
    remoteWorkspaceId?: string   // auto-set when exactly one workspace
    remoteWorkspaceName?: string // auto-set when exactly one workspace
    serverVersion?: string       // server app version from handshake
  }>

  // Window management
  getWindowWorkspace(): Promise<string | null>
  getWindowMode(): Promise<string | null>
  openWorkspace(workspaceId: string): Promise<void>
  openSessionInNewWindow(workspaceId: string, sessionId: string): Promise<void>
  /** Open or focus the dedicated settings window for a workspace. */
  openSettingsWindow(workspaceId?: string, route?: string): Promise<void>
  switchWorkspace(workspaceId: string): Promise<void>
  closeWindow(): Promise<void>
  confirmCloseWindow(): Promise<void>
  /** Cancel a pending close request (renderer handled it by closing a modal/panel). */
  cancelCloseWindow(): Promise<void>
  /** Listen for close requests and receive source metadata. Returns cleanup function. */
  onCloseRequested(callback: (request: WindowCloseRequest) => void): () => void
  /** Show/hide macOS traffic light buttons (for fullscreen overlays) */
  setTrafficLightsVisible(visible: boolean): Promise<void>

  // Event listeners
  onSessionEvent(callback: (event: SessionEvent) => void): () => void
  onUnreadSummaryChanged(callback: (summary: UnreadSummary) => void): () => void

  // File operations
  readFile(path: string, sessionId?: string): Promise<string>
  /** Read a file as binary data (Uint8Array) */
  readFileBinary(path: string, sessionId?: string): Promise<Uint8Array>
  /** Read a file as a data URL (data:{mime};base64,...) for binary preview (images, PDFs) */
  readFileDataUrl(path: string, sessionId?: string): Promise<string>
  /** Read an image file as a size-bounded preview data URL for lightweight thumbnail rendering. */
  readFilePreviewDataUrl(path: string, maxSize?: number, sessionId?: string): Promise<string>
  openFileDialog(): Promise<string[]>
  readFileAttachment(path: string): Promise<FileAttachment | null>
  /** Re-read a user-attached file by absolute path (bypasses workspace-dir validation).
   *  Used only by draft hydration for paths the user explicitly picked via OS dialog / drag. */
  readUserAttachment(path: string): Promise<FileAttachment | null>
  storeAttachment(sessionId: string, attachment: FileAttachment): Promise<import('../../../../packages/core/src/types/index.ts').StoredAttachment>
  generateThumbnail(base64: string, mimeType: string): Promise<string | null>
  /** Returns the absolute filesystem path for a File (only works for file-picker / OS-drag Files). */
  getFilePath(file: File): string | null

  // Filesystem search (for @ mention file selection)
  searchFiles(basePath: string, query: string): Promise<FileSearchResult[]>

  // Server filesystem browsing (remote mode)
  listServerDirectory(dirPath: string): Promise<DirectoryListingResult>
  // Debug: send renderer logs to main process log file
  debugLog(...args: unknown[]): void

  // Theme
  getSystemTheme(): Promise<boolean>
  onSystemThemeChange(callback: (isDark: boolean) => void): () => void

  // System
  getVersions(): { node: string; chrome: string; electron: string }
  /** Returns the renderer host environment without going through RPC. */
  getRuntimeEnvironment(): 'electron' | 'web'
  getHomeDir(): Promise<string>
  isDebugMode(): Promise<boolean>

  // Transport connection status (preload-local, not RPC channels)
  getTransportConnectionState(): Promise<TransportConnectionState>
  onTransportConnectionStateChanged(callback: (state: TransportConnectionState) => void): () => void
  reconnectTransport(): Promise<void>

  /** Fired after a WebSocket reconnect. isStale=true means buffer was evicted — full refresh needed. */
  onReconnected(callback: (isStale: boolean) => void): () => void

  /** Check whether the server registered a handler for a given RPC channel. */
  isChannelAvailable(channel: string): boolean

  // Auto-update
  checkForUpdates(): Promise<UpdateInfo>
  getUpdateInfo(): Promise<UpdateInfo>
  installUpdate(): Promise<void>
  dismissUpdate(version: string): Promise<void>
  getDismissedUpdateVersion(): Promise<string | null>
  onUpdateAvailable(callback: (info: UpdateInfo) => void): () => void
  onUpdateDownloadProgress(callback: (progress: number) => void): () => void

  // Release notes
  getReleaseNotes(): Promise<string>
  getLatestReleaseVersion(): Promise<string | undefined>

  // System warnings (startup checks)
  getSystemWarnings(): Promise<{ vcredistMissing: boolean; downloadUrl?: string }>

  // Shell operations
  openUrl(url: string): Promise<void>
  /** Open a file with the OS default app. Optional sessionId expands the allowed
   *  dirs with that session's working directory (for session-scoped file previews). */
  openFile(path: string, sessionId?: string): Promise<void>
  /** Reveal a file in the OS file manager. Optional sessionId expands the allowed
   *  dirs with that session's working directory (for session-scoped file previews). */
  showInFolder(path: string, sessionId?: string): Promise<void>

  // Menu event listeners
  onMenuNewChat(callback: () => void): () => void
  onMenuOpenSettings(callback: () => void): () => void
  onMenuKeyboardShortcuts(callback: () => void): () => void
  onMenuToggleFocusMode(callback: () => void): () => void
  onMenuToggleSidebar(callback: () => void): () => void

  // Deep link navigation listener (for external craftagents:// URLs)
  onDeepLinkNavigate(callback: (nav: DeepLinkNavigation) => void): () => void

  // Auth
  showLogoutConfirmation(): Promise<boolean>
  showDeleteSessionConfirmation(name: string): Promise<boolean>
  logout(): Promise<void>

  // Credential health check (startup validation)
  getCredentialHealth(): Promise<CredentialHealthStatus>

  // Onboarding
  getAuthState(): Promise<AuthState>
  getSetupNeeds(): Promise<SetupNeeds>
  startWorkspaceMcpOAuth(mcpUrl: string): Promise<OAuthResult & { clientId?: string }>
  /** Defer onboarding setup — user chose "Setup later" */
  deferSetup(): Promise<{ success: boolean }>

  /** Unified LLM connection setup */
  setupLlmConnection(setup: LlmConnectionSetup): Promise<{ success: boolean; error?: string }>
  /** Unified connection test — spawns a lightweight agent subprocess to validate credentials */
  testLlmConnectionSetup(params: TestLlmConnectionParams): Promise<TestLlmConnectionResult>
  // Pi provider discovery (main process only — Pi SDK can't run in renderer)
  getPiApiKeyProviders(): Promise<Array<{ key: string; label: string; placeholder: string }>>
  getPiProviderBaseUrl(provider: string): Promise<string | undefined>
  getPiProviderModels(provider: string): Promise<{ models: Array<{ id: string; name: string; costInput: number; costOutput: number; contextWindow: number; reasoning: boolean }>; totalCount: number }>

  // Session-specific model (overrides global)
  getSessionModel(sessionId: string, workspaceId: string): Promise<string | null>
  setSessionModel(sessionId: string, workspaceId: string, model: string | null, connection?: string): Promise<void>
  /** Re-assign the role profile (persona + scope ceilings) of an existing session. */
  setSessionAgent(sessionId: string, workspaceId: string, agentId: string): Promise<void>
  /** Hot connection switch (mid-session): live credential injection + model apply, context preserved. */
  switchSessionConnection(sessionId: string, connectionSlug: string, model?: string): Promise<void>

  // Workspace Settings (per-workspace configuration)
  getWorkspaceSettings(workspaceId: string): Promise<WorkspaceSettings | null>
  updateWorkspaceSetting<K extends keyof WorkspaceSettings>(workspaceId: string, key: K, value: WorkspaceSettings[K]): Promise<void>

  // Folder dialog
  openFolderDialog(): Promise<string | null>

  // Appearance file (unified UI/appearance settings)
  readAppearance(): Promise<{ content: string; exists: boolean; path: string }>
  writeAppearance(content: string): Promise<{ success: boolean; error?: string }>
  onAppearanceChange(callback: (content: string) => void): () => void

  // Session Drafts (persisted composer state — text + attachment refs)
  getDraft(sessionId: string): Promise<import('@craft-agent/shared/config').SessionDraft | null>
  setDraft(sessionId: string, draft: import('@craft-agent/shared/config').SessionDraft): Promise<void>
  deleteDraft(sessionId: string): Promise<void>
  getAllDrafts(): Promise<Record<string, import('@craft-agent/shared/config').SessionDraft>>

  // Session Info Panel
  getSessionFiles(sessionId: string): Promise<SessionFile[]>
  getSessionNotes(sessionId: string): Promise<string>
  setSessionNotes(sessionId: string, content: string): Promise<void>
  watchSessionFiles(sessionId: string): Promise<void>
  unwatchSessionFiles(): Promise<void>
  onSessionFilesChanged(callback: (sessionId: string) => void): () => void

  // Sources
  getSources(workspaceId: string): Promise<LoadedSource[]>
  createSource(workspaceId: string, config: Partial<FolderSourceConfig>): Promise<FolderSourceConfig>
  /** Patch-save one source config (stage 1: labels/readOnly; round-trips the full object). */
  saveSourceConfig(
    workspaceId: string,
    sourceSlug: string,
    patch: { labels?: string[]; readOnly?: boolean }
  ): Promise<FolderSourceConfig>
  /** Permission-label vocabulary (config/permission-labels.json; "private" is built-in & locked). */
  sourceLabels(
    workspaceId: string,
    request: { action: 'list' | 'add' | 'delete'; name?: string }
  ): Promise<{ version: number; labels: Array<{ name: string; builtin?: boolean }> }>
  deleteSource(workspaceId: string, sourceSlug: string): Promise<void>
  startSourceOAuth(workspaceId: string, sourceSlug: string): Promise<{ success: boolean; error?: string }>
  saveSourceCredentials(workspaceId: string, sourceSlug: string, credential: string): Promise<void>
  getSourcePermissionsConfig(workspaceId: string, sourceSlug: string): Promise<import('@craft-agent/shared/agent').PermissionsConfigFile | null>
  getWorkspacePermissionsConfig(workspaceId: string): Promise<import('@craft-agent/shared/agent').PermissionsConfigFile | null>
  getDefaultPermissionsConfig(): Promise<{ config: import('@craft-agent/shared/agent').PermissionsConfigFile | null; path: string }>
  getMcpTools(workspaceId: string, sourceSlug: string): Promise<McpToolsResult>

  // OAuth (server-owned credentials, client-orchestrated flow)
  performOAuth(args: { sourceSlug: string; sessionId?: string; authRequestId?: string }): Promise<{ success: boolean; error?: string; email?: string }>
  oauthRevoke(sourceSlug: string): Promise<{ success: boolean }>

  // Session content search (full-text search via ripgrep)
  searchSessionContent(workspaceId: string, query: string, searchId?: string, sessionIds?: string[]): Promise<SessionSearchResult[]>

  // Sources change listener (live updates when sources are added/removed)
  onSourcesChanged(callback: (workspaceId: string, sources: LoadedSource[]) => void): () => void

  // Default permissions change listener (live updates when default.json changes)
  onDefaultPermissionsChanged(callback: () => void): () => void

  // Skills
  getSkills(workspaceId: string, workingDirectory?: string): Promise<LoadedSkill[]>
  getSkillFiles?(workspaceId: string, skillSlug: string): Promise<SkillFile[]>
  deleteSkill(workspaceId: string, skillSlug: string): Promise<void>
  openSkillInEditor(workspaceId: string, skillSlug: string): Promise<void>
  openSkillInFinder(workspaceId: string, skillSlug: string): Promise<void>

  // Skills change listener (live updates when skills are added/removed/modified)
  onSkillsChanged(callback: (workspaceId: string, skills: LoadedSkill[]) => void): () => void

  /** Subscribe to global-memory write broadcasts (for live counts/badges). */
  onMemoryChanged(callback: (workspaceId: string) => void): () => void


  // Folders (workspace-scoped; one tree per project scope)
  listFolders(workspaceId: string, scope: import('@craft-agent/shared/sessions').FolderScope): Promise<import('@craft-agent/shared/sessions').FolderConfig[]>
  createFolder(workspaceId: string, scope: import('@craft-agent/shared/sessions').FolderScope, input: { name: string; parentId?: string | null }): Promise<import('@craft-agent/shared/sessions').FolderConfig>
  renameFolder(workspaceId: string, scope: import('@craft-agent/shared/sessions').FolderScope, input: { id: string; name: string }): Promise<import('@craft-agent/shared/sessions').FolderConfig>
  moveFolder(workspaceId: string, scope: import('@craft-agent/shared/sessions').FolderScope, input: { id: string; parentId: string | null; name?: string }): Promise<import('@craft-agent/shared/sessions').FolderConfig>
  moveFolderToScope(workspaceId: string, fromScope: import('@craft-agent/shared/sessions').FolderScope, input: { id: string; parentId?: string | null; name?: string }, toScope: import('@craft-agent/shared/sessions').FolderScope): Promise<import('@craft-agent/shared/sessions').FolderConfig>
  archiveFolder(workspaceId: string, scope: import('@craft-agent/shared/sessions').FolderScope, input: { id: string }): Promise<{ folder: import('@craft-agent/shared/sessions').FolderConfig; folderIds: string[]; path: string[]; sessionIds: string[]; archived: string[] }>
  unarchiveFolder(workspaceId: string, scope: import('@craft-agent/shared/sessions').FolderScope, input: { id: string }): Promise<{ folder: import('@craft-agent/shared/sessions').FolderConfig; folderIds: string[]; restored: string[] }>
  reorderFolder(workspaceId: string, scope: import('@craft-agent/shared/sessions').FolderScope, input: { id: string; sortOrder: string }): Promise<import('@craft-agent/shared/sessions').FolderConfig>
  pinFolder(workspaceId: string, scope: import('@craft-agent/shared/sessions').FolderScope, input: { id: string; pinned: boolean }): Promise<import('@craft-agent/shared/sessions').FolderConfig>
  deleteFolder(workspaceId: string, scope: import('@craft-agent/shared/sessions').FolderScope, input: { id: string }): Promise<{ deletedFolders: string[]; deletedSessions: string[]; archivedSessions: string[] }>
  onFoldersChanged(callback: (workspaceId: string, scope: import('@craft-agent/shared/sessions').FolderScope) => void): () => void

  // LLM connections change listener
  onLlmConnectionsChanged(callback: () => void): () => void

  // Multi-agent: role profiles + task board
  agentsList(workspaceId: string): Promise<Array<{
    id: string
    name: string
    icon?: string
    description?: string
    dispatchHint?: string
    /** 可分配任务开关（缺省 false）：只有开启的助手进派活名单。 */
    assignable?: boolean
    /** 记忆域（memory-domains.json 的 slug；阶段 4 域解析启用前仅为存档） */
    memoryDomain?: string
    builtin?: boolean
  }>>
  agentsGet(workspaceId: string, id: string): Promise<import('@craft-agent/shared/agents').AgentProfile | null>
  agentsSave(workspaceId: string, agent: Record<string, unknown>): Promise<{ id: string }>

  agentsDelete(workspaceId: string, id: string): Promise<{ ok: boolean }>
  onAgentsChanged(callback: (payload: { workspaceId: string }) => void): () => void

  tasksList(workspaceId: string, status?: string): Promise<Array<{
    id: string
    name: string
    status: import('@craft-agent/shared/tasks').TaskStatus
    priority: number
    updatedAt: number
    currentWorkerSessionId?: string
    sessionCount: number
    lastHandoff?: string
    pauseReason?: string | null
    /** What a paused task is waiting for, when it is waiting on a person. */
    decisionLabel?: string
  }>>
  tasksGet(workspaceId: string, id: string, includeJournal?: boolean): Promise<unknown>
  tasksUpdate(
    workspaceId: string,
    id: string,
    status: string,
    /** Same patch surface the task supervisor can write (see the taskboard.UPDATE handler). */
    options?: {
      pauseReason?: string
      error?: string
      scope?: string
      directive?: string
      name?: string
    },
  ): Promise<unknown>
  tasksRun(workspaceId: string, id: string): Promise<{ started: boolean; reason?: string }>
  tasksDelete(workspaceId: string, id: string): Promise<{ ok: boolean; reason?: string }>
  /**
   * Answer an open question (decision card) — on a task when one exists, otherwise on the
   * session that asked. Implemented since the decision-card work but missing from this
   * interface; the channel-map parity guard (compile-time) caught the drift.
   */
  tasksAnswer(
    workspaceId: string,
    taskId: string,
    text: string,
    askedBySessionId?: string,
    decisionId?: string,
  ): Promise<{ accepted: boolean; reason?: string }>
  tasksUpdateTrigger(workspaceId: string, id: string, trigger: unknown): Promise<unknown>
  tasksHandoff(
    workspaceId: string,
    id: string,
    fromSessionId: string,
    handoff: unknown,
  ): Promise<{ passed: boolean; reasons: string[]; status: string }>
  onTasksChanged(callback: (payload: { workspaceId: string }) => void): () => void

  // In-process LLM gateway — status is pushed, the rest are pulled on demand.
  llmGatewayGetStatus(): Promise<LlmGatewayStatusPayload>
  llmGatewayGetConfig(): Promise<LlmConfigDto | null>
  llmGatewayGetUsage(params?: { range?: import('@craft-agent/shared/config').UsageRange }): Promise<{ overview: unknown; totalRecords: number }>
  llmGatewayQueryLogs(params?: {
    tags?: Array<{ field: string; value: string }>
    sort?: 'desc' | 'asc'
    limit?: number
  }): Promise<{ rows: import('@craft-agent/shared/config').LlmUsageRecord[]; truncated: boolean }>
  llmGatewayGetProviderDetail(providerId: string): Promise<LlmProviderDetailPayload | null>
  llmGatewaySaveConfig(config: unknown): Promise<{ ok: true } | { ok: false; errors: string[] }>
  llmGatewayClearKeyCooldown(args: { provider?: string; keyId?: string }): Promise<{ ok: boolean }>
  llmGatewayTestConnection(params: import('@craft-agent/shared/protocol').LlmGatewayTestConnectionParams): Promise<import('@craft-agent/shared/protocol').LlmGatewayTestConnectionResult>
  llmGatewayListModels(params: import('@craft-agent/shared/protocol').LlmGatewayListModelsParams): Promise<import('@craft-agent/shared/protocol').LlmGatewayListModelsResult>
  onLlmGatewayStatus(callback: (status: LlmGatewayStatusPayload) => void): () => void

  // Generic workspace image loading/saving
  readWorkspaceImage(workspaceId: string, relativePath: string): Promise<string>
  writeWorkspaceImage(workspaceId: string, relativePath: string, base64: string, mimeType: string): Promise<void>

  // Tool icon mappings
  getToolIconMappings(): Promise<ToolIconMapping[]>

  // Theme (app-level default)
  getAppTheme(): Promise<import('@config/theme').ThemeOverrides | null>
  loadPresetThemes(): Promise<import('@config/theme').PresetTheme[]>
  loadPresetTheme(themeId: string): Promise<import('@config/theme').PresetTheme | null>
  getColorTheme(): Promise<string>
  setColorTheme(themeId: string): Promise<void>
  getWorkspaceColorTheme(workspaceId: string): Promise<string | null>
  setWorkspaceColorTheme(workspaceId: string, themeId: string | null): Promise<void>
  getAllWorkspaceThemes(): Promise<Record<string, string | undefined>>

  // Theme change listeners
  onAppThemeChange(callback: (theme: import('@config/theme').ThemeOverrides | null) => void): () => void

  // Logo URL resolution
  getLogoUrl(serviceUrl: string, provider?: string): Promise<string | null>

  // Notifications
  showNotification(title: string, body: string, workspaceId: string, sessionId: string): Promise<void>
  getNotificationsEnabled(): Promise<boolean>
  setNotificationsEnabled(enabled: boolean): Promise<void>

  // Input settings
  getSendMessageKey(): Promise<'enter' | 'cmd-enter'>
  setSendMessageKey(key: 'enter' | 'cmd-enter'): Promise<void>
  getSpellCheck(): Promise<boolean>
  setSpellCheck(enabled: boolean): Promise<void>

  // Power settings
  getKeepAwakeWhileRunning(): Promise<boolean>
  setKeepAwakeWhileRunning(enabled: boolean): Promise<void>

  // Tools settings
  getBrowserToolEnabled(): Promise<boolean>
  setBrowserToolEnabled(enabled: boolean): Promise<void>

  // Appearance settings
  getRichToolDescriptions(): Promise<boolean>
  setRichToolDescriptions(enabled: boolean): Promise<void>

  // RTK token optimization
  getRtkEnabled(): Promise<boolean>
  setRtkEnabled(enabled: boolean): Promise<void>
  getRtkStatus(opts?: { forceRecheck?: boolean }): Promise<{ installed: boolean; path: string | null; version: string | null }>
  getRtkGain(): Promise<{ totalCommands: number; totalInput: number; totalOutput: number; totalSaved: number; avgSavingsPct: number; totalTimeMs: number; avgTimeMs: number } | null>

  // Embedding model path (local semantic memory retrieval)
  getEmbeddingModelPath(): Promise<string | undefined>
  setEmbeddingModelPath(path: string): Promise<boolean>
  clearEmbeddingModelPath(): Promise<void>

  // Anti early-stop defense
  getDefenseEnabled(): Promise<boolean>
  setDefenseEnabled(enabled: boolean): Promise<void>
  getDefenseGuardrails(): Promise<{ maxResumes: number }>
  setDefenseGuardrails(guardrails: { maxResumes?: number }): Promise<void>

  // Network proxy settings
  getNetworkProxySettings(): Promise<NetworkProxySettings | undefined>
  setNetworkProxySettings(settings: NetworkProxySettings): Promise<void>

  refreshBadge(): Promise<void>
  setDockIconWithBadge(dataUrl: string): Promise<void>
  onBadgeDraw(callback: (data: { count: number; iconDataUrl: string }) => void): () => void
  onBadgeDrawWindows(callback: (data: { count: number }) => void): () => void
  getWindowFocusState(): Promise<boolean>
  onWindowFocusChange(callback: (isFocused: boolean) => void): () => void
  onNotificationNavigate(callback: (data: { workspaceId: string; sessionId: string }) => void): () => void

  // Theme preferences sync across windows
  broadcastThemePreferences(preferences: { mode: string; colorTheme: string; font: string }): Promise<void>
  onThemePreferencesChange(callback: (preferences: { mode: string; colorTheme: string; font: string }) => void): () => void

  // Workspace theme sync across windows
  broadcastWorkspaceThemeChange(workspaceId: string, themeId: string | null): Promise<void>
  onWorkspaceThemeChange(callback: (data: { workspaceId: string; themeId: string | null }) => void): () => void

  // Git operations
  getGitBranch(dirPath: string): Promise<string | null>

  // Git Bash (Windows)
  checkGitBash(): Promise<GitBashStatus>
  browseForGitBash(options?: { title?: string; buttonLabel?: string; filterName?: string }): Promise<string | null>
  setGitBashPath(path: string): Promise<{ success: boolean; error?: string }>
  openGitBashPath(path: string): Promise<void>

  // Menu actions (from renderer to main)
  menuQuit(): Promise<void>
  menuNewWindow(): Promise<void>
  menuMinimize(): Promise<void>
  menuMaximize(): Promise<void>
  menuZoomIn(): Promise<void>
  menuZoomOut(): Promise<void>
  menuZoomReset(): Promise<void>
  menuToggleDevTools(): Promise<void>
  menuUndo(): Promise<void>
  menuRedo(): Promise<void>
  menuCut(): Promise<void>
  menuCopy(): Promise<void>
  menuPaste(): Promise<void>
  menuSelectAll(): Promise<void>

  // Browser pane management
  browserPane: {
    create(input?: string | BrowserPaneCreateOptions): Promise<string>
    destroy(id: string): Promise<void>
    list(): Promise<BrowserInstanceInfo[]>
    navigate(id: string, url: string): Promise<{ url: string; title: string }>
    goBack(id: string): Promise<void>
    goForward(id: string): Promise<void>
    reload(id: string): Promise<void>
    stop(id: string): Promise<void>
    focus(id: string): Promise<void>
    emptyStateLaunch(payload: BrowserEmptyStateLaunchPayload): Promise<BrowserEmptyStateLaunchResult>
    onStateChanged(callback: (info: BrowserInstanceInfo) => void): () => void
    onRemoved(callback: (id: string) => void): () => void
    onInteracted(callback: (id: string) => void): () => void
  }

  // Standalone Page windows (real OS windows that can live outside Craft)
  pageWindow: {
    open(input: { workspaceId: string; pageSlug: string }): Promise<string>
    list(): Promise<PageWindowInfo[]>
    focus(id: string): Promise<void>
    close(id: string): Promise<void>
    /** Minimize the calling page window. */
    minimizeSelf(): Promise<void>
    /** Close the calling page window. */
    closeSelf(): Promise<void>
    onStateChanged(callback: (info: PageWindowInfo) => void): () => void
    onRemoved(callback: (id: string) => void): () => void
  }

  // LLM Connections (provider configurations)
  listLlmConnections(): Promise<LlmConnection[]>
  listLlmConnectionsWithStatus(): Promise<LlmConnectionWithStatus[]>
  getLlmConnection(slug: string): Promise<LlmConnection | null>
  getLlmConnectionApiKey(slug: string): Promise<string | null>
  saveLlmConnection(connection: LlmConnection): Promise<{ success: boolean; error?: string }>
  deleteLlmConnection(slug: string): Promise<{ success: boolean; error?: string }>
  testLlmConnection(slug: string): Promise<{ success: boolean; error?: string }>
  setDefaultLlmConnection(slug: string): Promise<{ success: boolean; error?: string }>
  toggleModel(connectionSlug: string, modelId: string, enabled: boolean): Promise<{ success: boolean; error?: string }>
  addCustomModel(connectionSlug: string, model: { id: string; name: string; contextWindow?: number }): Promise<{ success: boolean; error?: string }>
  updateModelEnabled(connectionSlug: string, modelId: string, enabled: boolean): Promise<{ success: boolean; error?: string }>

  // Memory (workspace-scoped cross-session memory)
  getMemoryStats(workspaceRootPath: string): Promise<{ entries: MemoryEntry[]; stats: MemoryStats }>
  addMemory(workspaceRootPath: string, data: { content: string; type: MemoryType; tags?: string[]; confidence?: number }): Promise<{ id: string }>
  deleteMemory(workspaceRootPath: string, id: string): Promise<{ success: boolean }>
  deleteMemories(workspaceRootPath: string, ids: string[]): Promise<{ deleted: number }>
  updateMemory(workspaceRootPath: string, id: string, updates: { content?: string; type?: MemoryType; tags?: string[] }): Promise<{ success: boolean }>
  getMemoryTrash(workspaceRootPath: string): Promise<Array<{ entry: MemoryEntry; deletedAt: string; reason?: string; replacedById?: string }>>
  restoreMemory(workspaceRootPath: string, id: string): Promise<{ success: boolean }>
  clearMemoryTrash(workspaceRootPath: string): Promise<{ count: number }>
  deleteTrashMemories(workspaceRootPath: string, ids: string[]): Promise<{ deleted: number }>
  getSessionMemories(workspaceRootPath: string, sessionId: string): Promise<{ entries: MemoryEntry[]; lastConsolidatedAt?: string }>
  addSessionMemory(workspaceRootPath: string, sessionId: string, data: { content: string; type: MemoryType; tags?: string[]; confidence?: number }): Promise<{ id: string }>
  updateSessionMemory(workspaceRootPath: string, sessionId: string, id: string, updates: { content?: string; type?: MemoryType; tags?: string[]; confidence?: number }): Promise<{ success: boolean }>
  deleteSessionMemory(workspaceRootPath: string, sessionId: string, id: string): Promise<{ success: boolean }>
  /**
   * Starts a consolidation run. Returns immediately (fire-and-forget); follow
   * progress/completion via {@link onMemoryConsolidationProgress}.
   */
  consolidateMemories(workspaceRootPath: string): Promise<{ started: boolean; total: number }>
  /** Global memory-system switch (missing flag = enabled). Off = pipeline + UI hidden. */
  memoryEnabledGet(workspaceRootPath: string): Promise<{ enabled: boolean }>
  memoryEnabledSet(workspaceRootPath: string, enabled: boolean): Promise<{ enabled: boolean }>
  cancelConsolidateMemories(workspaceRootPath: string): Promise<{ success: boolean }>
  getConsolidationState(workspaceRootPath: string): Promise<{ active: boolean; done: number; total: number; cancelling?: boolean }>
  onMemoryConsolidationProgress(callback: (progress: MemoryConsolidationProgress) => void): () => void
  getMemorySchedule(workspaceRootPath: string): Promise<{ enabled: boolean; cron: string; timezone?: string }>
  setMemorySchedule(workspaceRootPath: string, schedule: { enabled: boolean; cron: string; timezone?: string }): Promise<{ success: boolean }>
  extractSessionMemories(sessionId: string): Promise<{ extracted: number; discarded: number }>

  // Usage (source & skill usage stats)
  getUsageStats(workspaceId?: string): Promise<UsageStats>
  getUsageHistory(workspaceId?: string, kind?: 'source' | 'skill', slug?: string): Promise<UsageRecord[]>
  getDefaultThinkingLevel(): Promise<ThinkingLevel>
  setDefaultThinkingLevel(level: ThinkingLevel): Promise<{ success: boolean; error?: string }>
  /** Fallback context window (tokens) from config.json `defaultContextWindow`. */
  getDefaultContextWindow(): Promise<number>
  setWorkspaceDefaultLlmConnection(workspaceId: string, slug: string | null): Promise<{ success: boolean; error?: string }>

  // Projects (workspace-scoped)
  getProjects(workspaceId: string): Promise<unknown>
  getProject(workspaceId: string, projectIdOrSlug: string): Promise<unknown | null>
  createProject(workspaceId: string, input: import('@craft-agent/shared/projects/types').CreateProjectInput): Promise<import('@craft-agent/shared/projects/types').ProjectConfig>
  updateProject(workspaceId: string, projectSlug: string, patch: Partial<Omit<import('@craft-agent/shared/projects/types').ProjectConfig, 'id' | 'slug' | 'createdAt'>>): Promise<import('@craft-agent/shared/projects/types').ProjectConfig>
  deleteProject(workspaceId: string, projectSlug: string): Promise<void>
  listProjectAssets(workspaceId: string, projectSlug: string): Promise<unknown>
  uploadProjectAsset(workspaceId: string, projectSlug: string, input: { filename: string; base64?: string; text?: string; sourcePath?: string }): Promise<import('@craft-agent/shared/projects/types').ProjectAsset>
  deleteProjectAsset(workspaceId: string, projectSlug: string, filename: string): Promise<void>
  onProjectsChanged(callback: (workspaceId: string, projects: unknown) => void): () => void

  // Events (workspace-scoped event center)
  listEvents(
    workspaceId: string,
    filter?: {
      source?: string
      type?: string
      hasRecipients?: boolean
      /** Only events a receiving session has finished acting on (or only ones it has not, when false). */
      handled?: boolean
      since?: number
      until?: number
      search?: string
      limit?: number
      offset?: number
    }
  ): Promise<import('@craft-agent/shared/protocol/dto').EventMetaDto[]>
  getEvent(
    workspaceId: string,
    eventId: string
  ): Promise<import('@craft-agent/shared/protocol/dto').EventRecordDto | null>
  readEventAttachment(
    workspaceId: string,
    eventId: string,
    index: number,
    mode: 'text' | 'dataUrl' | 'bytes'
  ): Promise<import('@craft-agent/shared/protocol/dto').EventAttachmentContentDto>
  openEventAttachment(workspaceId: string, eventId: string, index: number): Promise<void>
  getEventCounts(workspaceId: string): Promise<{
    counts: Record<string, number>
    status: { listening: boolean; host: string | null; port: number | null; baseUrl: string | null }
  }>
  getEventsStatus(workspaceId: string): Promise<{
    listening: boolean
    host: string | null
    port: number | null
    baseUrl: string | null
  }>
  onEventsChanged(
    callback: (workspaceId: string, event: import('@craft-agent/shared/protocol/dto').EventMetaDto) => void
  ): () => void
  /** Delete specific events from the log (收件箱 / 发件箱 context menu). Returns how many. */
  deleteEvents(workspaceId: string, ids: string[]): Promise<number>
  /** Durable outbox, newest first; pass a status to filter one delivery state. */
  listOutbox(
    workspaceId: string,
    status?: 'sent' | 'pending' | 'failed'
  ): Promise<import('@craft-agent/shared/protocol/dto').OutboxRecordDto[]>
  /** Re-arm a failed outbox record so the dispatcher retries it. */
  retryOutbox(workspaceId: string, id: string): Promise<boolean>
  /** Drop sent/failed outbox records; pending ones keep their place. Returns how many. */
  purgeOutbox(workspaceId: string): Promise<number>
  /** Delete specific outbox records (发件箱 context menu). Returns how many. */
  removeOutbox(workspaceId: string, ids: string[]): Promise<number>
  /** One-minute, single-use pairing code. Send `/pair <code>` in a chat to unlock it. */
  pairingGenerate(workspaceId: string): Promise<{ code: string; expiresAt: number }>
  /** Channels that are currently paired and allowed to send events. */
  /**
   * Paired channels (pairings v2): the gate fields are optional — legacy
   * records have none of them (缺省 = 闸关/无天花板/写保护未启用, 零回归).
   */
  pairingList(
    workspaceId: string
  ): Promise<Array<{
    channelKey: string
    pairedAt: number
    pairedBy?: string
    channelKind?: 'private' | 'group' | 'channel'
    agentId?: string
    gateEnabled?: boolean
    allowedLabels?: string[]
    permissionMode?: 'safe' | 'ask' | 'allow-all'
    ingestMode?: 'at_only' | 'all'
    triggerPrompt?: string
    recordOnly?: boolean
    memoryFeed?: boolean
  }>>
  /** Update one channel's gate config (stored on the pairing record; missing fields keep). */
  channelGate(
    workspaceId: string,
    channelKey: string,
    patch: {
      agentId?: string | null
      gateEnabled?: boolean
      allowedLabels?: string[]
      permissionMode?: 'safe' | 'ask' | 'allow-all' | null
      ingestMode?: 'at_only' | 'all'
      triggerPrompt?: string | null
      recordOnly?: boolean
      memoryFeed?: boolean
    }
  ): Promise<{ channelKey: string; pairedAt: number; [key: string]: unknown }>
  /** 源可见性预览（阶段 1 半成品：只有标签交集；模式裁剪阶段 6 生效）。 */
  channelGatePreview(workspaceId: string, channelKey: string): Promise<{
    gateEnabled: boolean
    allowedLabels: string[]
    permissionMode: 'safe' | 'ask' | 'allow-all' | null
    pairedBy: string | null
    channelKind: 'private' | 'group' | 'channel' | null
    agentId: string | null
    allSlugs: string[]
    visibleSlugs: string[]
  }>
  /** 认领（启用写保护）：pairedBy 取同平台私聊配对记录；无私聊配对 → 需重新配对。 */
  channelClaim(workspaceId: string, channelKey: string): Promise<{ ok: boolean; pairedBy?: string; reason?: 'not_paired' | 'no_private_pairing' }>
  /** Memory domains (table + auto-registered project domains; 阶段 4 读它做域解析). */
  memoryDomains(workspaceId: string): Promise<{
    version: number
    domains: Array<{ slug: string; kind: 'personal' | 'project'; path?: string; mattersMost?: string }>
  }>
  /** One domain's MEMORY.md content (registry-path read; empty shape for unknown slugs). */
  memoryDomainsRead(
    workspaceId: string,
    slug: string,
  ): Promise<{
    slug: string
    kind?: 'personal' | 'project'
    path?: string
    mattersMost?: string
    exists: boolean
    content: string
    truncated: boolean
  }>
  /** Unpair a channel; its next message gets the pairing prompt again. */
  pairingUnpair(workspaceId: string, channelKey: string): Promise<{ success: boolean }>
  /**
   * Display names for channel keys, resolved by the plugin's own control
   * service. Keys the plugin does not know are absent from the map; an
   * empty map (plugin stopped / endpoint unknown) means "show the raw key".
   */
  channelLabels(workspaceId: string, listenerId: string, channelKeys: string[]): Promise<Record<string, string>>
  listEventListeners(
    workspaceId: string,
    skipProbes?: boolean,
    locale?: string
  ): Promise<import('@craft-agent/shared/protocol/dto').ListenerDto[]>
  getEventListener(
    workspaceId: string,
    listenerId: string,
    locale?: string
  ): Promise<import('@craft-agent/shared/protocol/dto').ListenerDto | null>
  getEventListenerUi(
    workspaceId: string,
    listenerId: string
  ): Promise<{ html: string | null; source?: 'file' | 'inline' }>
  getEventListenerLog(
    workspaceId: string,
    listenerId: string
  ): Promise<{
    logTail: string
    status: import('@craft-agent/shared/protocol/dto').ListenerStatusDto
  }>
  setEventListenerEnabled(
    workspaceId: string,
    listenerId: string,
    enabled: boolean
  ): Promise<import('@craft-agent/shared/protocol/dto').ListenerStatusDto>
  setEventListenerConfig(
    workspaceId: string,
    listenerId: string,
    config: Record<string, unknown>
  ): Promise<{ ok: boolean }>
  installEventListenerDependency(
    workspaceId: string,
    listenerId: string,
    dependency: { manager: 'pip' | 'npm'; name: string; range: string }
  ): Promise<{ ok: boolean; command: string; exitCode: number | null; output: string; error?: string }>
  installListenerMcp(
    workspaceId: string,
    listenerId: string,
    mcpId: string
  ): Promise<{ ok: boolean; command: string; exitCode: number | null; output: string; error?: string }>
  getListenerReportedDeps(
    workspaceId: string,
    listenerId: string
  ): Promise<import('@craft-agent/shared/protocol/dto').ListenerReportedDepsDto>
  listenerDepAction(
    workspaceId: string,
    listenerId: string,
    depId: string
  ): Promise<{ ok: boolean; conflict?: boolean; error?: string }>
  /** Relay one manifest-declared plugin action from the plugin's own HTML page. */
  listenerPluginAction(
    workspaceId: string,
    listenerId: string,
    action: string,
    args: Record<string, unknown>
  ): Promise<{ ok: boolean; message: string }>
  onEventListenerStatus(
    callback: (workspaceId: string, status: import('@craft-agent/shared/protocol/dto').ListenerStatusDto) => void
  ): () => void
  /** A listener's on-disk facts changed (enable toggle, saved config, installed dep). */
  onEventListenerChanged(
    callback: (
      workspaceId: string,
      changed: { listenerId: string; reason: 'enabled' | 'config' | 'dependency' },
    ) => void
  ): () => void
  listEventSubscriptions(
    workspaceId: string,
    sessionId: string
  ): Promise<Array<{ subscriptionId: string; sessionId: string; filter: { sources?: string[]; types?: string[]; tags?: string[] }; createdAt: number }>>
  subscribeEvent(
    workspaceId: string,
    sessionId: string,
    filter: { sources?: string[]; types?: string[]; tags?: string[] }
  ): Promise<{ subscriptionId: string; sessionId: string; createdAt: number }>
  unsubscribeEvent(
    workspaceId: string,
    sessionId: string,
    subscriptionId?: string,
    source?: string
  ): Promise<{ removed: number; remaining: Array<{ subscriptionId: string }> }>

  // Pages (workspace-scoped mini dashboards)
  getPages(workspaceId: string): Promise<import('@craft-agent/shared/pages/types').LoadedPage[]>
  getPage(workspaceId: string, pageIdOrSlug: string): Promise<import('@craft-agent/shared/pages/types').LoadedPage | null>
  createPage(workspaceId: string, input: import('@craft-agent/shared/pages/types').CreatePageInput): Promise<import('@craft-agent/shared/pages/types').PageConfig>
  /** Optional fields (projectId, description, refresh) accept explicit null = clear (undefined is dropped by the JSON transport). */
  updatePage(workspaceId: string, pageSlug: string, patch: Partial<Omit<import('@craft-agent/shared/pages/types').PageConfig, 'id' | 'slug' | 'createdAt' | 'contentDigest' | 'lastRefresh' | 'grants' | 'share' | 'projectId' | 'description' | 'refresh'>> & { projectId?: string | null; description?: string | null; refresh?: import('@craft-agent/shared/pages/types').PageRefreshSpec | null }): Promise<import('@craft-agent/shared/pages/types').PageConfig>
  deletePage(workspaceId: string, pageSlug: string): Promise<{ publicCopyMayRemain: boolean }>
  getPageContent(workspaceId: string, pageSlug: string): Promise<{ content: string | null; contentDigest?: string }>
  setPageContent(workspaceId: string, pageSlug: string, content: string): Promise<import('@craft-agent/shared/pages/types').PageConfig>
  getPageData(workspaceId: string, pageSlug: string): Promise<import('@craft-agent/shared/pages/types').PageDataSnapshot | null>
  listPageGrants(workspaceId: string, pageSlug: string): Promise<import('@craft-agent/shared/pages/types').PageActionGrant[]>
  issuePageGrant(workspaceId: string, pageSlug: string, input: { action: import('@craft-agent/shared/pages/types').PageActionDescriptor; description?: string; ttlMs?: number }): Promise<import('@craft-agent/shared/pages/types').PageActionGrant>
  revokePageGrant(workspaceId: string, pageSlug: string, grantId: string): Promise<boolean>
  createPageLease(workspaceId: string, pageSlug: string): Promise<{ lease: import('@craft-agent/shared/pages/types').PageRenderLease; content: string }>
  releasePageLease(workspaceId: string, leaseId: string): Promise<void>
  executePageAction(workspaceId: string, request: import('@craft-agent/shared/pages/types').PageActionRequest): Promise<import('@craft-agent/shared/pages/types').PageActionResult>
  cancelPageAction(workspaceId: string, requestId: string): Promise<boolean>
  getPageShareCapabilities(): Promise<{ sharingEnabled: boolean }>
  /** What `includeData` would publish + key paths that look credential-bearing (warn-only). */
  getPageShareDataScan(workspaceId: string, pageSlug: string): Promise<{ snapshotBytes: number | null; secretCandidates: string[] }>
  publishPage(workspaceId: string, pageSlug: string, options: { includeData: boolean; password?: string; viewOnlyAcknowledged?: boolean }): Promise<import('@craft-agent/shared/pages/types').PageConfig>
  setPagePublicationPassword(workspaceId: string, pageSlug: string, password: string | null): Promise<import('@craft-agent/shared/pages/types').PageConfig>
  unpublishPage(workspaceId: string, pageSlug: string): Promise<{ config: import('@craft-agent/shared/pages/types').PageConfig; warning?: 'remote-copy-may-remain' }>
  /** Read a page's cached poster as a data URL — only returns when fresh (digest matches current content). */
  getPageThumbnail(workspaceId: string, pageSlug: string): Promise<{ dataUrl: string; digest: string } | null>
  /** Request a (re)capture of a page's poster (no-op on hosts without a capturer). */
  regeneratePageThumbnail(workspaceId: string, pageSlug: string): Promise<boolean>
  onPagesChanged(callback: (workspaceId: string, pages: import('@craft-agent/shared/pages/types').LoadedPage[]) => void): () => void

  // Language
  changeLanguage(lang: string): Promise<void>
  /** Fires in every window except the one that changed the language. */
  onLanguageChanged(cb: (lang: string) => void): () => void

  // Resources (cross-workspace export/import)
  exportResources(workspaceId: string, options: ExportResourcesOptions): Promise<ExportResult>
  importResources(workspaceId: string, bundle: ResourceBundle, mode: ResourceImportMode): Promise<ResourceImportResult>

}
// Memory types
export type MemoryType = import('@craft-agent/shared/memory').MemoryType;
export interface MemoryEntry {
  id: string;
  type: MemoryType;
  content: string;
  tags: string[];
  confidence: number;
  createdAt: string;
  sourceSessionId: string;
}
export interface MemoryStats {
  totalEntries: number;
  entriesByType: Record<string, number>;
  totalExtractions: number;
  lastExtractionAt?: string;
}
/** Progress of a memory consolidation run, pushed from the workspace server. */
export interface MemoryConsolidationProgress {
  /** Phase of the run: 'running' | 'done' | 'cancelled' | 'error'. */
  phase: 'running' | 'done' | 'cancelled' | 'error';
  /** Sessions processed successfully so far (marked + persisted). */
  done: number;
  /** Total sessions selected for this run. */
  total: number;
  /** Session ID of the session that just completed (running frames only). */
  sessionId?: string;
  /** New global memories promoted from that session (running/done). */
  promoted: number;
  /** Existing global memories moved to trash by that session (running/done). */
  trashed: number;
  /** Human-readable error for phase 'error'. */
  message?: string;
  /** True while a cancel is in flight (cooperative cancel between batches). */
  cancelling?: boolean;
}


// =============================================================================
// Navigation types (renderer-only)
// =============================================================================

/**
 * Right sidebar panel types
 */
export type RightSidebarPanel =
  | { type: 'files'; path?: string }
  | { type: 'history' }
  | { type: 'none' }

/**
 * Session filter options
 */
export type SessionFilter =
  | { kind: 'allSessions' }
  | { kind: 'archived' }

/**
 * Settings subpage options - re-exported from settings-registry (single source of truth)
 */
export type { SettingsSubpage } from './settings-registry'
import { isValidSettingsSubpage, type SettingsSubpage } from './settings-registry'

/**
 * Sessions navigation state
 */
export interface SessionsNavigationState {
  navigator: 'sessions'
  filter: SessionFilter
  details: { type: 'session'; sessionId: string } | null
  rightSidebar?: RightSidebarPanel
  /**
   */
  viewMode?: 'list' | 'board'
}

/**
 * Source type filter for sources navigation
 */
export interface SourceFilter {
  kind: 'type'
  sourceType: 'api' | 'mcp' | 'local'
}

/**
 * Sources navigation state
 */
export interface SourcesNavigationState {
  navigator: 'sources'
  filter?: SourceFilter
  details: { type: 'source'; sourceSlug: string } | { type: 'memory'; id: 'global' } | null
  rightSidebar?: RightSidebarPanel
}

/**
 * Settings navigation state
 *
 * `subpage: null` means the bare `settings` route — navigator-only view in compact
 * mode. On desktop, the content panel falls back to the App page so it isn't empty.
 * Sources/Skills/Automations use `details: null` for the same purpose.
 */
export interface SettingsNavigationState {
  navigator: 'settings'
  subpage: SettingsSubpage | null
  rightSidebar?: RightSidebarPanel
}

/**
 * Skills navigation state
 */
export interface SkillsNavigationState {
  navigator: 'skills'
  details: { type: 'skill'; skillSlug: string } | null
  rightSidebar?: RightSidebarPanel
}

/**
 * Projects navigation state
 */
export interface ProjectsNavigationState {
  navigator: 'projects'
  details: { type: 'project'; projectSlug: string } | null
  rightSidebar?: RightSidebarPanel
}

/**
 * Pages navigation state
 *
 * Bare `pages` (details: null) shows the full-width library grid — it never
 * auto-selects a page. Like board mode, the middle navigator collapses to
 * zero width while a pages route is active.
 */
export interface PagesNavigationState {
  navigator: 'pages'
  details: { type: 'page'; pageSlug: string } | null
  rightSidebar?: RightSidebarPanel
}

/**
 * Events navigation state
 *
 * Two sections share one navigator:
 * - `list`      → the received-event log (default)
 * - `listeners` → installed listener cards
 */
export interface EventsNavigationState {
  navigator: 'events'
  /** list = 事件日志, listeners = 插件卡片, inbox = 未处理事件, outbox = 发出消息。 */
  section: 'list' | 'listeners' | 'inbox' | 'outbox'
  /** Selected event id, outbox record id, or null. */
  details:
    | { type: 'event'; eventId: string }
    | { type: 'listener'; listenerId: string }
    | { type: 'outbox'; outboxId: string }
    | null
  rightSidebar?: RightSidebarPanel
}

/**
 * Task board navigator: a grouped task list plus one task's detail.
 */
export interface TasksNavigationState {
  navigator: 'tasks'
  /** Selected task id, or null for the list. */
  selectedTaskId: string | null
  rightSidebar?: RightSidebarPanel
}

/**
 * Agents navigator (migrated from 设置/智能体 to the main window's left nav):
 * a role-profile list plus one agent's detail. Placed above the sources nav
 * item on purpose — roles are who does the work, sources are what they touch.
 */
export interface AgentsNavigationState {
  navigator: 'agents'
  details: { type: 'agent'; id: string } | null
  rightSidebar?: RightSidebarPanel
}

/**
 * Unified navigation state
 */
export type NavigationState =
  | SessionsNavigationState
  | SourcesNavigationState
  | SettingsNavigationState
  | SkillsNavigationState
  | ProjectsNavigationState
  | PagesNavigationState
  | EventsNavigationState
  | TasksNavigationState
  | AgentsNavigationState

export const isSessionsNavigation = (
  state: NavigationState
): state is SessionsNavigationState => state.navigator === 'sessions'

export const isTasksNavigation = (
  state: NavigationState
): state is TasksNavigationState => state.navigator === 'tasks'

export const isAgentsNavigation = (
  state: NavigationState
): state is AgentsNavigationState => state.navigator === 'agents'

export const isSourcesNavigation = (
  state: NavigationState
): state is SourcesNavigationState => state.navigator === 'sources'

export const isSettingsNavigation = (
  state: NavigationState
): state is SettingsNavigationState => state.navigator === 'settings'

export const isSkillsNavigation = (
  state: NavigationState
): state is SkillsNavigationState => state.navigator === 'skills'

export const isProjectsNavigation = (
  state: NavigationState
): state is ProjectsNavigationState => state.navigator === 'projects'

export const isPagesNavigation = (
  state: NavigationState
): state is PagesNavigationState => state.navigator === 'pages'

export const isEventsNavigation = (
  state: NavigationState
): state is EventsNavigationState => state.navigator === 'events'

/**
 * The plugins section of the events navigator.
 *
 * `isEventsNavigation` is true for both sections, so the sidebar could not tell
 * 事件 from 插件 — both lit up at once. These two narrow it to one section each.
 */
export const isEventListenersNavigation = (state: NavigationState): boolean =>
  state.navigator === 'events' && state.section === 'listeners'

export const isEventListNavigation = (state: NavigationState): boolean =>
  state.navigator === 'events' && state.section === 'list'

/** The 收件箱 section: arrived events nobody has finished acting on yet. */
export const isEventInboxNavigation = (state: NavigationState): boolean =>
  state.navigator === 'events' && state.section === 'inbox'

/** The 发件箱 section: outbound messages and their delivery state. */
export const isEventOutboxNavigation = (state: NavigationState): boolean =>
  state.navigator === 'events' && state.section === 'outbox'

export const DEFAULT_NAVIGATION_STATE: NavigationState = {
  navigator: 'sessions',
  filter: { kind: 'allSessions' },
  details: null,
}

export const getNavigationStateKey = (state: NavigationState): string => {
  if (state.navigator === 'sources') {
    if (state.details?.type === 'memory') return 'sources/memories'
    if (state.details?.type === 'source') {
      return `sources/source/${state.details.sourceSlug}`
    }
    return 'sources'
  }
  if (state.navigator === 'skills') {
    if (state.details?.type === 'skill') {
      return `skills/skill/${state.details.skillSlug}`
    }
    return 'skills'
  }
  if (state.navigator === 'agents') {
    if (state.details?.type === 'agent') {
      return `agents/agent/${state.details.id}`
    }
    return 'agents'
  }
  if (state.navigator === 'projects') {
    if (state.details?.type === 'project') {
      return `projects/project/${state.details.projectSlug}`
    }
    return 'projects'
  }
  if (state.navigator === 'pages') {
    if (state.details?.type === 'page') {
      return `pages/page/${state.details.pageSlug}`
    }
    return 'pages'
  }
  if (state.navigator === 'events') {
    if (state.details?.type === 'event') return `events/list/event/${state.details.eventId}`
    if (state.details?.type === 'listener') return `events/listeners/listener/${state.details.listenerId}`
    return `events/${state.section}`
  }
  if (state.navigator === 'settings') {
    if (state.subpage === null) return 'settings'
    return `settings:${state.subpage}`
  }
  if (state.navigator === 'tasks') {
    return state.selectedTaskId ? `tasks/${encodeURIComponent(state.selectedTaskId)}` : 'tasks'
  }
  // Chats
  const f = state.filter
  const base: string = f.kind
  if (state.details) {
    return `${base}/chat/${state.details.sessionId}`
  }
  return base
}

export const parseNavigationStateKey = (key: string): NavigationState | null => {
  // Handle sources
  if (key.startsWith('agents/agent/')) {
    const agentId = key.slice(13)
    if (agentId) {
      return { navigator: 'agents', details: { type: 'agent', id: agentId } }
    }
    return null
  }
  if (key === 'agents') return { navigator: 'agents', details: null }
  if (key === 'sources/memories') return { navigator: 'sources', details: { type: 'memory', id: 'global' } }
  if (key === 'sources') return { navigator: 'sources', details: null }
  if (key.startsWith('sources/source/')) {
    const sourceSlug = key.slice(15)
    if (sourceSlug) {
      return { navigator: 'sources', details: { type: 'source', sourceSlug } }
    }
    return { navigator: 'sources', details: null }
  }

  // Handle events
  if (key === 'events' || key === 'events/list') {
    return { navigator: 'events', section: 'list', details: null }
  }
  if (key === 'events/listeners') {
    return { navigator: 'events', section: 'listeners', details: null }
  }
  if (key.startsWith('events/list/event/')) {
    const eventId = key.slice('events/list/event/'.length)
    if (eventId) {
      return { navigator: 'events', section: 'list', details: { type: 'event', eventId } }
    }
    return { navigator: 'events', section: 'list', details: null }
  }
  if (key.startsWith('events/listeners/listener/')) {
    const listenerId = key.slice('events/listeners/listener/'.length)
    if (listenerId) {
      return { navigator: 'events', section: 'listeners', details: { type: 'listener', listenerId } }
    }
    return { navigator: 'events', section: 'listeners', details: null }
  }

  // Handle skills
  if (key === 'skills') return { navigator: 'skills', details: null }
  if (key.startsWith('skills/skill/')) {
    const skillSlug = key.slice(13)
    if (skillSlug) {
      return { navigator: 'skills', details: { type: 'skill', skillSlug } }
    }
    return { navigator: 'skills', details: null }
  }


  // Handle projects
  if (key === 'projects') return { navigator: 'projects', details: null }
  if (key.startsWith('projects/project/')) {
    const projectSlug = key.slice(17)
    if (projectSlug) {
      return { navigator: 'projects', details: { type: 'project', projectSlug } }
    }
    return { navigator: 'projects', details: null }
  }

  // Handle pages
  if (key === 'pages') return { navigator: 'pages', details: null }
  if (key.startsWith('pages/page/')) {
    const pageSlug = key.slice(11)
    if (pageSlug) {
      return { navigator: 'pages', details: { type: 'page', pageSlug } }
    }
    return { navigator: 'pages', details: null }
  }

  // Handle tasks
  if (key === 'tasks') return { navigator: 'tasks', selectedTaskId: null }
  if (key.startsWith('tasks/')) {
    const taskId = key.slice('tasks/'.length)
    if (taskId) return { navigator: 'tasks', selectedTaskId: taskId }
    return { navigator: 'tasks', selectedTaskId: null }
  }

  // Handle settings
  if (key === 'settings') return { navigator: 'settings', subpage: null }
  if (key.startsWith('settings:')) {
    const subpage = key.slice(9)
    if (isValidSettingsSubpage(subpage)) {
      return { navigator: 'settings', subpage }
    }
  }

  // Handle sessions
  const parseSessionsKey = (filterKey: string, sessionId?: string): NavigationState | null => {
    let filter: SessionFilter
    if (filterKey === 'allSessions') filter = { kind: 'allSessions' }
    else if (filterKey === 'flagged') filter = { kind: 'allSessions' }
    else if (filterKey === 'archived') filter = { kind: 'archived' }
    else if (filterKey.startsWith('state:')) {
      // Status dimension removed — legacy keys resolve to the unfiltered list
      filter = { kind: 'allSessions' }
    } else if (filterKey.startsWith('view:')) {
      // View dimension removed — legacy keys resolve to the unfiltered list
      filter = { kind: 'allSessions' }
    } else {
      return null
    }
    return {
      navigator: 'sessions',
      filter,
      details: sessionId ? { type: 'session', sessionId } : null,
    }
  }

  // Check for session details
  if (key.includes('/session/')) {
    const [filterPart, , sessionId] = key.split('/')
    return parseSessionsKey(filterPart, sessionId)
  }

  // Simple filter key
  return parseSessionsKey(key)
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
