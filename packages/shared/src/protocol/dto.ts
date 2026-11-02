/**
 * Server DTO types — data shapes used by RPC handlers and SessionManager.
 *
 * These were previously in apps/electron/src/shared/types.ts.
 * Extracted here so handler code in @craft-agent/server-core can import
 * from @craft-agent/shared/protocol without reaching into the app.
 */

import type {
  Message,
  TypedError,
  ContentBadge,
  ToolDisplayMeta,
  AnnotationV1,
  StoredAttachment,
  PermissionRequest as BasePermissionRequest,
} from '@craft-agent/core/types'
import type { PermissionMode } from '../agent/mode-types'
import type { ThinkingLevel } from '../agent/thinking-levels'
import type { CustomEndpointConfig } from '../config/llm-connections'
import type {
  AuthRequest as SharedAuthRequest,
  CredentialInputMode as SharedCredentialInputMode,
  CredentialAuthRequest as SharedCredentialAuthRequest,
} from '../agent/index'
import type { SdkMcpServerConfig } from '../agent/backend/types'

// Re-export generateMessageId for handler convenience
export { generateMessageId } from '@craft-agent/core/types'
/**
 * Electron-specific Session type (includes runtime state).
 * Extends core Session with messages array and processing state.
 */
export interface Session {
  id: string
  workspaceId: string
  workspaceName: string
  name?: string
  /** Preview of first user message (from JSONL header, for lazy-loaded sessions) */
  preview?: string
  lastMessageAt: number
  messages: Message[]
  isProcessing: boolean
  /** Permission mode for this session ('safe', 'ask', 'allow-all') */
  permissionMode?: PermissionMode
  lastReadMessageId?: string
  /**
   * Explicit unread flag - single source of truth for NEW badge.
   * Set to true when assistant message completes while user is NOT viewing.
   * Set to false when user views the session (and not processing).
   */
  hasUnread?: boolean
  enabledSourceSlugs?: string[]
  sourceScope?: 'auto' | 'only' | 'exclude'
  workingDirectory?: string
  sessionFolderPath?: string
  sharedUrl?: string
  sharedId?: string
  model?: string
  llmConnection?: string
  thinkingLevel?: ThinkingLevel
  /**
   * LLM gateway strategy id this session routes through.
   *
   * Mirrors `model` / `llmConnection`: per-session, restored on load. Absent
   * means the user has not picked a routing policy yet, which the composer
   * shows as an explicit prompt instead of a silent fallback.
   */
  strategy?: string
  lastMessageRole?: 'user' | 'assistant' | 'plan' | 'tool' | 'error'
  lastFinalMessageId?: string
  isAsyncOperationOngoing?: boolean
  /** @deprecated Use isAsyncOperationOngoing instead */
  isRegeneratingTitle?: boolean
  currentStatus?: {
    message: string
    statusType?: string
  }
  createdAt?: number
  messageCount?: number
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    contextTokens: number
    costUsd: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    /** Model's context window size in tokens (from SDK modelUsage) */
    contextWindow?: number
  }
  /** When true, session is hidden from session list (e.g., mini edit sessions) */
  hidden?: boolean
  isArchived?: boolean
  archivedAt?: number
  supportsBranching?: boolean
  /** Workspace-scoped project id this session is bound to (undefined = unbound) */
  projectId?: string
  /** Parent session id — when set, this session is a subtask of the parent (undefined = top-level task) */
  parentSessionId?: string
  /**
   * Messages waiting for the current turn to finish, in send order. The
   * renderer shows them in a panel ABOVE the composer (2026-10-22) instead of
   * as transcript bubbles — they are not part of the conversation yet.
   * `attachments` are the persisted metadata so the edit action can restore
   * them into the composer without a round-trip to disk.
   */
  queuedMessages?: QueuedMessageSummary[]
}

/**
 * Payload returned by the `editQueuedMessage` command: the message has already
 * left the queue, and the composer rehydrates from this.
 */
export interface QueuedMessageEditResult {
  /** Id the renderer used to address the queued row. */
  messageId: string
  /** Original user-visible text. */
  text: string
  /** Persisted attachments, re-read from disk by the renderer on edit. */
  attachments?: StoredAttachment[]
}

/**
 * One entry of a session's pending send queue. Mirrors the backend
 * `messageQueue` rows that belong to a user message (synthetic restart-recovery
 * rows have no `messageId` and are filtered out before reaching the renderer).
 */
export interface QueuedMessageSummary {
  /** Stable identity for reorder/edit/remove — the message id, or the
   * optimistic id before the backend ack lands. */
  id: string
  /** Canonical persisted message id (absent on transient optimistic rows). */
  messageId?: string
  /** Frontend's optimistic id, used to match the panel row before ack. */
  optimisticMessageId?: string
  /** User-visible text. */
  message: string
  /** Persisted attachments (includes thumbnailBase64 for previews). */
  attachments?: StoredAttachment[]
  /** Send time (epoch ms) — shown as a relative hint in the panel. */
  timestamp?: number
}

export interface CreateSessionOptions {
  name?: string
  permissionMode?: PermissionMode
  /**
   * Reasoning/thinking level override. When set, takes precedence over workspace
   * and global defaults. Silently ignored by the underlying SDK on non-reasoning
   * models (e.g. gpt-4o) — provider drivers don't attach the reasoning param to
   * the API request for models with `reasoning: false` in the Pi SDK catalog.
   */
  thinkingLevel?: ThinkingLevel
  /**
   * Working directory for the session:
   * - 'user_default' or undefined: Use workspace's configured default working directory
   * - 'none': No working directory (session folder only)
   * - Absolute path string: Use this specific path
   */
  workingDirectory?: string | 'user_default' | 'none'
  model?: string
  llmConnection?: string
  /**
   * LLM gateway strategy group the new session routes through. Falls back to the
   * workspace default (`defaults.strategy`) — the same resolution the desktop
   * composer uses — so a session created outside the UI is never left on
   * 未选择策略组.
   */
  strategy?: string
  systemPromptPreset?: 'default' | 'mini' | string
  hidden?: boolean
  enabledSourceSlugs?: string[]
  /**
   * Message ID to branch from. This is a hard context cutoff:
   * the new session must not include model context from later parent messages.
   */
  branchFromMessageId?: string
  /** Parent session ID used together with branchFromMessageId. */
  branchFromSessionId?: string
  /** Bind the new session to a workspace project (inherits project's workingDirectory). */
  projectId?: string
  /** Folder id inside that project's tree (or the root tree when no project). Undefined = root. */
  folderId?: string | null
  /** Mark the new session as a subtask of this parent session (undefined = top-level task). */
  parentSessionId?: string
  /**
   * Explicit MCP server configurations for this session.
   * When provided, the session uses an isolated MCP pool with only these servers,
   * instead of building from enabledSourceSlugs.
   */
  mcpServerConfigs?: Record<string, SdkMcpServerConfig>;
}

export interface RemoteSessionTransferPayload {
  sourceSessionId: string
  name?: string
  permissionMode?: PermissionMode
  summary: string
}

export interface ImportRemoteSessionTransferResult {
  sessionId: string
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export interface PermissionModeState {
  permissionMode: PermissionMode
  previousPermissionMode?: PermissionMode
  transitionDisplay?: string
  modeVersion: number
  changedAt: string
  changedBy: 'user' | 'system' | 'restore' | 'automation' | 'unknown'
}

// ---------------------------------------------------------------------------
// Session events (main → renderer)
// ---------------------------------------------------------------------------

// turnId: Correlation ID from the API's message.id, groups all events in an assistant turn
export type SessionEvent =
  | { type: 'text_discard'; sessionId: string; turnId: string }
  | { type: 'text_demote'; sessionId: string; turnId: string }
  /**
   * Re-promote an intermediate reply to the result bubble (2026-10-07,
   * session 261007-wise-horizon). Carries the demoted text so the
   * messaging-channel renderer can re-attach it ahead of the drained
   * steer's answer; the session record flips isIntermediate on the
   * matching message so it is a result bubble on reload too.
   */
  | { type: 'text_promote'; sessionId: string; turnId: string; text: string }
  | { type: 'text_delta'; sessionId: string; delta: string; turnId?: string }
  | { type: 'text_complete'; sessionId: string; text: string; isIntermediate?: boolean; turnId?: string; parentToolUseId?: string; timestamp?: number; /** Streaming start time (first text_delta) for process-card ordering; `timestamp` stays the completion time */ startedAt?: number; messageId?: string }
  | { type: 'thinking_delta'; sessionId: string; delta: string; turnId?: string }
  | { type: 'thinking_complete'; sessionId: string; text: string; turnId?: string; timestamp?: number; startedAt?: number; messageId?: string }
  | { type: 'tool_start'; sessionId: string; toolName: string; toolUseId: string; toolInput: Record<string, unknown>; toolIntent?: string; toolDisplayName?: string; toolDisplayMeta?: ToolDisplayMeta; turnId?: string; parentToolUseId?: string; timestamp?: number; messageId?: string }
  | { type: 'tool_result'; sessionId: string; toolUseId: string; toolName: string; result: string; turnId?: string; parentToolUseId?: string; isError?: boolean; timestamp?: number }
  | { type: 'error'; sessionId: string; error: string; timestamp?: number }
  | { type: 'typed_error'; sessionId: string; error: TypedError; timestamp?: number }
  | { type: 'complete'; sessionId: string; tokenUsage?: Session['tokenUsage']; hasUnread?: boolean; backgroundTasksAlive?: boolean }
  | { type: 'interrupted'; sessionId: string; message?: Message }
  // The pending send queue changed (enqueue / cancel / edit / reorder / drain).
  // Carries the full ordered queue so every window converges on one order.
  | { type: 'queued_messages_changed'; sessionId: string; queuedMessages: QueuedMessageSummary[] }
  | { type: 'status'; sessionId: string; message: string; statusType?: 'compacting' | 'compaction_summary' | 'verification' | 'verification_passed' | 'verification_failed'; statusParams?: Record<string, string | number>; timestamp?: number }
  | { type: 'info'; sessionId: string; message: string; statusType?: 'compaction_complete' | 'compaction_summary' | 'verification' | 'verification_passed' | 'verification_failed' | 'system_stop' | 'background_wake'; statusParams?: Record<string, string | number>; level?: 'info' | 'warning' | 'error' | 'success'; timestamp?: number; finalText?: string; stopReason?: string }
  | { type: 'system_stop_notice'; sessionId: string; reason: string; message: string; timestamp?: number }
  | { type: 'title_generated'; sessionId: string; title: string }
  | { type: 'title_regenerating'; sessionId: string; isRegenerating: boolean }
  | { type: 'async_operation'; sessionId: string; isOngoing: boolean }
  | { type: 'working_directory_changed'; sessionId: string; workingDirectory: string }
  | { type: 'permission_request'; sessionId: string; request: PermissionRequest }
  | { type: 'permission_resolved'; sessionId: string; requestId: string; allowed: boolean }
  | { type: 'credential_request'; sessionId: string; request: CredentialRequest }
  | { type: 'permission_mode_changed'; sessionId: string; permissionMode: PermissionMode; previousPermissionMode?: PermissionMode; transitionDisplay?: string; modeVersion?: number; changedAt?: string; changedBy?: PermissionModeState['changedBy'] }
  | { type: 'plan_submitted'; sessionId: string; message: Message }
  | { type: 'sources_changed'; sessionId: string; enabledSourceSlugs: string[]; sourceScope?: 'auto' | 'only' | 'exclude' }
  | { type: 'project_id_changed'; sessionId: string; projectId: string | null }
  | { type: 'connection_changed'; sessionId: string; connectionSlug: string; supportsBranching?: boolean }
  | { type: 'task_backgrounded'; sessionId: string; toolUseId: string; taskId: string; intent?: string; turnId?: string; kind?: 'workflow' | 'subscription' | 'tool'; workflowId?: string }
  | { type: 'shell_backgrounded'; sessionId: string; toolUseId: string; shellId: string; intent?: string; command?: string; turnId?: string }
  | { type: 'task_progress'; sessionId: string; toolUseId: string; elapsedSeconds: number; turnId?: string }
  | { type: 'task_completed'; sessionId: string; taskId: string; status: 'completed' | 'failed' | 'stopped'; outputFile?: string; output?: string; summary?: string; turnId?: string; kind?: 'tool' }
  | { type: 'workflow_agent_completed'; sessionId: string; workflowId: string; agentId: string; turnId?: string }
  | { type: 'shell_killed'; sessionId: string; shellId: string }
  | { type: 'background_task_started'; sessionId: string; taskId: string; kind: string; intent?: string; startedAt: number; backgroundedAt?: number }
  | { type: 'background_task_updated'; sessionId: string; taskId: string; status: string; outputFile?: string; tail?: string; stopSource?: string }
  | { type: 'background_task_stopping'; sessionId: string; taskId: string; stopSource?: string }
  | { type: 'background_task_completed'; sessionId: string; taskId: string; status: string; exitCode?: number; outputFile?: string; tail?: string; stopSource?: string }
  | { type: 'background_task_delivered'; sessionId: string; taskId: string; messageId?: string; deliveredAt: number }
  | { type: 'background_task_deleted'; sessionId: string; taskId: string }
  | { type: 'user_message'; sessionId: string; message: Message; status: 'accepted' | 'queued' | 'processing'; optimisticMessageId?: string }
  | { type: 'message_removed'; sessionId: string; messageId: string }
  | { type: 'session_cleared'; sessionId: string }
  | { type: 'session_archived'; sessionId: string }
  | { type: 'session_unarchived'; sessionId: string }
  | { type: 'name_changed'; sessionId: string; name?: string }
  | { type: 'session_model_changed'; sessionId: string; model: string | null }
  | { type: 'session_metadata_changed'; sessionId: string; changes: Partial<Pick<Session, 'hasUnread' | 'lastReadMessageId'>> & { projectId?: string | null; folderId?: string | null; archivedFolderId?: string | null; archivedFolderPath?: string[]; archivedProjectId?: string; archivedByParent?: string; sortOrder?: string; pinnedAt?: number } }
  | { type: 'session_deleted'; sessionId: string }
  | { type: 'session_created'; sessionId: string }
  | { type: 'session_shared'; sessionId: string; sharedUrl: string }
  | { type: 'session_unshared'; sessionId: string }
  | { type: 'auth_request'; sessionId: string; message: Message; request: SharedAuthRequest }
  | { type: 'auth_completed'; sessionId: string; requestId: string; success: boolean; cancelled?: boolean; error?: string }
  | { type: 'usage_update'; sessionId: string; tokenUsage: { inputTokens: number; contextWindow?: number } }
  | { type: 'message_annotations_updated'; sessionId: string; messageId: string; annotations: AnnotationV1[] }
  | { type: 'working_directory_error'; sessionId: string; error: string }

export interface SendMessageOptions {
  skillSlugs?: string[]
  badges?: ContentBadge[]
  optimisticMessageId?: string
  /**
   * Per-send override for messages submitted while a session is already
   * processing. Desktop uses this for Codex-style queue-vs-steer controls;
   * messaging channels use it to keep phone follow-ups as in-flight guidance.
   */
  midStreamBehavior?: 'steer' | 'queue'
  /**
   * When true, the message drives a turn (reaches the model) but is marked
   * `hidden` on the persisted `Message` so it never renders as a transcript
   * bubble. Used for system-generated nudges (e.g. WS2 background-task-completion
   * surfacing) that should wake the agent without looking user-authored.
   */
  hidden?: boolean
  /**
   * Per-send permission-mode override applied ONLY while this message's turn
   * is processed. The persisted/diagnostics mode is untouched — no events,
   * no UI change, no modeVersion bump. Messaging channels pass 'safe' so a
   * desktop `ask` session processes mobile chats read-only without changing
   * the desktop mode. Cleared when the turn completes.
   */
  permissionModeOverride?: PermissionMode
  /**
   * Messaging platform the message arrived from (telegram/qq/whatsapp/wechat/
   * lark). When set, the session injects platform-aware context so the agent
   * knows where the user is chatting and can adapt its reply format (e.g. use
   * deliver_file for files instead of Markdown links on plain-text platforms).
   */
  platform?: string
  /**
   * True when the message was composed and sent from the desktop client (as
   * opposed to arriving from a bound mobile/chat channel). The session manager
   * uses this to reset the `mobileEngaged` flag so a desktop-originated turn
   * shows the unread badge until the user views it, rather than inheriting a
   * stale "read-on-phone" state from an earlier phone message.
   */
  fromDesktop?: boolean
}

// ---------------------------------------------------------------------------
// Session commands (consolidated operations)
// ---------------------------------------------------------------------------

export type SessionCommand =
  | { type: 'archive' }
  | { type: 'unarchive' }
  | { type: 'rename'; name: string }
  | { type: 'markRead' }
  | { type: 'markUnread' }
  | { type: 'setActiveViewing'; workspaceId: string }
  | { type: 'setPermissionMode'; mode: PermissionMode }
  | { type: 'setThinkingLevel'; level: ThinkingLevel }
  | { type: 'setSessionStrategy'; strategy: string }
  | { type: 'updateWorkingDirectory'; dir: string }
  | { type: 'setSources'; sourceSlugs: string[]; sourceScope?: 'auto' | 'only' | 'exclude' }
  | { type: 'setProjectId'; projectId: string | null }
  /** Move the session into a folder of its current scope (null = root). */
  | { type: 'setFolder'; folderId: string | null }
  /** Atomic cross-scope move: project + folder + optional archive flip (D19/D31). */
  | { type: 'moveToScope'; projectId: string | null; folderId: string | null; archived?: boolean }
  /** Manual order among siblings of the same kind (D32). */
  | { type: 'setSortOrder'; sortOrder: string }
  /** Pin/unpin within the sibling group (D33). */
  | { type: 'setPinned'; pinned: boolean }
  | { type: 'showInFinder' }
  | { type: 'copyPath' }
  | { type: 'shareToViewer' }
  | { type: 'updateShare' }
  | { type: 'revokeShare' }
  | { type: 'refreshTitle' }
  | { type: 'setConnection'; connectionSlug: string }
  | { type: 'setPendingPlanExecution'; planPath: string; draftInputSnapshot?: string }
  | { type: 'markCompactionComplete' }
  | { type: 'clearSession' }
  | { type: 'markPendingPlanExecutionDispatched' }
  | { type: 'clearPendingPlanExecution' }
  | { type: 'cancelQueuedMessage'; messageId: string }
  | { type: 'guideQueuedMessage'; messageId: string }
  /** Reorder the pending queue. `messageIds` is the full new order; rows not
   *  listed keep their relative position after the listed ones. */
  | { type: 'reorderQueuedMessages'; messageIds: string[] }
  /** Remove a queued message from the queue and hand its payload back so the
   *  renderer can put text + attachments into the composer for editing. */
  | { type: 'editQueuedMessage'; messageId: string }
  | { type: 'addAnnotation'; messageId: string; annotation: AnnotationV1 }
  | { type: 'removeAnnotation'; messageId: string; annotationId: string }
  | { type: 'updateAnnotation'; messageId: string; annotationId: string; patch: Partial<AnnotationV1> }

export interface NewChatActionParams {
  input?: string
  name?: string
}

// ---------------------------------------------------------------------------
// Permission / credential types
// ---------------------------------------------------------------------------

export type { BasePermissionRequest }

/**
 * Permission request with session context (for multi-session Electron app)
 */
export interface PermissionRequest extends BasePermissionRequest {
  sessionId: string
}

export interface PermissionResponseOptions {
  rememberForMinutes?: number
  /** 数据源调用确认策略：once=仅本次 / session=本会话 / always=工具级始终允许（持久）/ deny=本会话禁止 / deny-permanent=工具级永久禁止（持久） */
  sourcePermission?: 'once' | 'session' | 'always' | 'deny' | 'deny-permanent'
}

// Re-export for handler convenience
export type { SharedCredentialInputMode as CredentialInputMode }
export type CredentialRequest = SharedCredentialAuthRequest
export type { SharedAuthRequest as AuthRequest }

export interface CredentialResponse {
  type: 'credential'
  value?: string
  username?: string
  password?: string
  headers?: Record<string, string>
  cancelled: boolean
}

// ---------------------------------------------------------------------------
// Directory browsing types (remote mode)
// ---------------------------------------------------------------------------

/** Server-side directory listing result (for remote directory browsing). */
export interface DirectoryListingResult {
  /** Normalized absolute path of the listed directory (after resolve(), not symlink-resolved). */
  currentPath: string
  /** Parent directory path, or null if at root. */
  parentPath: string | null
  /** Pre-split breadcrumb segments for display (computed server-side). */
  breadcrumbs: Array<{ name: string; path: string }>
  /** Server platform info. */
  platform: 'win32' | 'darwin' | 'linux'
  /** Whether the server truncated the directory list for safety/performance. */
  truncated: boolean
  /** Total number of matching child directories before truncation. */
  totalEntries: number
  /** Child directory entries. */
  entries: Array<{ name: string; path: string; isSymlink: boolean }>
}

// ---------------------------------------------------------------------------
// File types
// ---------------------------------------------------------------------------

export interface FileAttachment {
  type: 'image' | 'text' | 'pdf' | 'office' | 'audio' | 'unknown'
  path: string
  name: string
  mimeType: string
  base64?: string
  text?: string
  size: number
  thumbnailBase64?: string
  /** Path where file is stored in session attachments folder */
  storedPath?: string
  /** Path to converted markdown version, when available */
  markdownPath?: string
  /** Set once the attachment is persisted at attach time (storeAttachment). */
  id?: string
  wasResized?: boolean
  /** Base64 of the resized image, when the original was auto-resized for API limits. */
  resizedBase64?: string
  originalSize?: number
}

export interface SessionFile {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  children?: SessionFile[]
}

export interface FileSearchResult {
  name: string
  path: string
  type: 'file' | 'directory'
  relativePath: string
}

// ---------------------------------------------------------------------------
// LLM connection types
// ---------------------------------------------------------------------------


export interface LlmConnectionSetup {
  slug: string
  credential?: string
  baseUrl?: string | null
  defaultModel?: string | null
  models?: string[] | null
  piAuthProvider?: string
  modelSelectionMode?: 'automaticallySyncedFromProvider' | 'userDefined3Tier'
  /** When true, reject setup if the connection doesn't already exist (reauth guard). */
  updateOnly?: boolean
  /** Custom endpoint protocol for arbitrary OpenAI/Anthropic-compatible APIs */
  customEndpoint?: CustomEndpointConfig
  /** IAM credentials for Pi+Bedrock (piAuthProvider='amazon-bedrock') connections */
  iamCredentials?: {
    accessKeyId: string
    secretAccessKey: string
    sessionToken?: string
  }
  /** AWS region for Pi+Bedrock connections */
  awsRegion?: string
  /** Bedrock authentication method — determines auth type for Pi+Bedrock connections */
  /** Bedrock auth method — only the AWS credential chain remains; IAM was removed. */
  bedrockAuthMethod?: 'environment'
}

export interface TestLlmConnectionParams {
  provider: 'anthropic' | 'pi'
  apiKey: string
  connectionSlug?: string
  baseUrl?: string
  model?: string
  piAuthProvider?: string
  /** Optional custom endpoint protocol hint so setup tests mirror runtime routing */
  customEndpoint?: CustomEndpointConfig
}

export interface TestLlmConnectionResult {
  success: boolean
  error?: string
}

// ---------------------------------------------------------------------------
// Source / skill types
// ---------------------------------------------------------------------------

export interface SkillFile {
  name: string
  type: 'file' | 'directory'
  size?: number
  children?: SkillFile[]
}

export interface OAuthResult {
  success: boolean
  error?: string
}

export interface McpValidationResult {
  success: boolean
  error?: string
  tools?: string[]
}

export interface McpToolWithPermission {
  name: string
  description?: string
  allowed: boolean
}

export interface McpToolsResult {
  success: boolean
  error?: string
  tools?: McpToolWithPermission[]
}

// ---------------------------------------------------------------------------
// Search types
// ---------------------------------------------------------------------------

export interface SessionSearchMatch {
  sessionId: string
  lineNumber: number
  snippet: string
}

export interface SessionSearchResult {
  sessionId: string
  matchCount: number
  matches: SessionSearchMatch[]
}

// ---------------------------------------------------------------------------
// Session result types
// ---------------------------------------------------------------------------

export interface UnreadSummary {
  totalUnreadSessions: number
  byWorkspace: Record<string, number>
  hasUnreadByWorkspace: Record<string, boolean>
}

export interface ShareResult {
  success: boolean
  url?: string
  error?: string
}

export interface RefreshTitleResult {
  success: boolean
  title?: string
  error?: string
}

// ---------------------------------------------------------------------------
// Plan types
// ---------------------------------------------------------------------------

export interface PlanStep {
  id: string
  description: string
  tools?: string[]
  status?: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'
}

export interface Plan {
  id: string
  title: string
  summary?: string
  steps: PlanStep[]
  questions?: string[]
  state?: 'creating' | 'refining' | 'ready' | 'executing' | 'completed' | 'cancelled'
  createdAt?: number
  updatedAt?: number
}

// ---------------------------------------------------------------------------
// System types
// ---------------------------------------------------------------------------

export interface GitBashStatus {
  found: boolean
  path: string | null
  platform: 'win32' | 'darwin' | 'linux'
}

export interface UpdateInfo {
  available: boolean
  currentVersion: string
  latestVersion: string | null
  downloadState: 'idle' | 'downloading' | 'ready' | 'installing' | 'error'
  downloadProgress: number
  error?: string
}

// ---------------------------------------------------------------------------
// Workspace types
// ---------------------------------------------------------------------------

export interface WorkspaceSettings {
  name?: string
  model?: string
  permissionMode?: PermissionMode
  cyclablePermissionModes?: PermissionMode[]
  thinkingLevel?: ThinkingLevel
  workingDirectory?: string
  localMcpEnabled?: boolean
  defaultLlmConnection?: string
  enabledSourceSlugs?: string[]
  /** Default strategy group for new sessions; '' = none (pick per session). */
  strategy?: string
}


// ---------------------------------------------------------------------------
// Automation types
// ---------------------------------------------------------------------------

export type TestAutomationAction =
  | { type: 'prompt'; prompt: string; llmConnection?: string; model?: string; thinkingLevel?: ThinkingLevel }
  | { type: 'webhook'; url: string; method?: string; headers?: Record<string, string>; bodyFormat?: 'json' | 'form' | 'raw'; body?: unknown; captureResponse?: boolean; auth?: { type: 'basic'; username: string; password: string } | { type: 'bearer'; token: string } }
  | { type: 'script'; script: string; args?: string[]; runtime?: 'bun' | 'node' | 'python3'; timeoutMs?: number; page?: string }

export interface TestAutomationPayload {
  workspaceId: string
  automationId?: string
  automationName?: string
  actions: TestAutomationAction[]
  permissionMode?: PermissionMode
  /** Forwarded from the matcher; routes test-run sessions into a Telegram topic when paired. */
  telegramTopic?: string
  /** QQ group channelIds to bind test-run sessions to. */
  qqChannels?: string[]
}

export type TestAutomationActionResult =
  | { type: 'prompt'; success: boolean; stderr?: string; sessionId?: string; duration: number }
  | { type: 'webhook'; success: boolean; url: string; statusCode: number; error?: string; duration: number }
  | { type: 'script'; success: boolean; script: string; exitCode: number | null; stdout?: string; error?: string; duration: number }

export interface TestAutomationResult {
  actions: TestAutomationActionResult[]
}

// ---------------------------------------------------------------------------
// Window types
// ---------------------------------------------------------------------------

export type WindowCloseRequestSource = 'keyboard-shortcut' | 'window-button' | 'unknown'

export interface WindowCloseRequest {
  source: WindowCloseRequestSource
}

// ---------------------------------------------------------------------------
// Browser / navigation types (data shapes used by BroadcastEventMap)
// ---------------------------------------------------------------------------

export interface BrowserInstanceInfo {
  id: string
  url: string
  title: string
  favicon: string | null
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  boundSessionId: string | null
  ownerType: 'session' | 'manual'
  ownerSessionId: string | null
  isVisible: boolean
  agentControlActive: boolean
  themeColor: string | null
  /**
   * Workspace that owns this browser instance, or `null` for unbound manual
   * windows. Renderers filter the tab strip / status badge by `activeWorkspaceId`
   * so a session in workspace A doesn't see windows opened by workspace B.
   * Missing/null entries always pass the filter — this keeps older renderers
   * and main processes that pre-date the field working unchanged.
   */
  workspaceId?: string | null
}

/**
 * One standalone Page window (a real OS window, not an in-app overlay).
 * The id is stable per (workspace, page) so opening the same page twice
 * focuses the existing window instead of creating a duplicate.
 */
export interface PageWindowInfo {
  id: string
  pageSlug: string
  workspaceId: string
  /** Window title as set by the page renderer (page name). */
  title: string
  isMinimized: boolean
  isFocused: boolean
}

export interface DeepLinkNavigation {
  view?: string
  tabType?: string
  tabParams?: Record<string, string>
  action?: string
  actionParams?: Record<string, string>
}

// ============================================================================
// In-process LLM gateway
// ============================================================================

/** Live scheduling state for the settings page's status strips. */
export interface LlmGatewayStatusPayload {
  running: boolean
  port: number
  baseUrl: string
  enabled: boolean
  /**
   * Config rebuild counter. The settings page re-reads the config when this
   * moves, so edits made outside the app land without a manual refresh.
   * Optional for forward/backward compatibility.
   */
  generation?: number
  strategies: Array<{
    id: string
    type: string
    providers: number
    /** Display name; the id is a slug and reads badly for non-ASCII names. */
    name?: string
    /** Public models the group declares, in declared order. */
    models?: string[]
    /**
     * The subset of `models` usable right now (availability windows applied).
     * Empty with a non-empty `models` means every window is closed — the
     * composer shows that state instead of naming a model that will fail.
     */
    openModels?: string[]
    enabled?: boolean
    usable?: boolean
    reason?: string
  }>
  /**
   * Last upstream model each strategy routed to, `strategyId -> model`.
   * History, used to size the context ring. The composer's "next request"
   * label predicts from `openModels` instead. Optional so a renderer talking to
   * an older main process still compiles.
   */
  lastModels?: Record<string, string>
  coolingKeys: number
  inFlight: number
  /** Per-key cooldown state; drives the countdowns in the provider key table. */
  keyStates?: Array<{
    provider: string
    keyId: string
    cooling: boolean
    cooldownRemaining: number
    inFlight: number
    available: boolean
    weight: number
  }>
}

/** Per-key scheduling snapshot, for the provider detail key table. */
export interface LlmGatewayKeyState {
  keyId: string
  cooling: boolean
  cooldownRemaining: number
  inFlight: number
  available: boolean
}

/**
 * One stage of a request's path through the gateway.
 *
 * Spans the pipeline the provider detail trace timeline renders — picking a
 * provider, retrying, cooling a key, the upstream's first chunk, stream end and
 * the usage write — so a slow request can be attributed to a stage rather than
 * the provider as a whole.
 */
export interface LlmTraceStage {
  stage:
    | 'provider_selected'
    | 'retry_provider'
    | 'cooldown_provider'
    | 'upstream_first_chunk'
    | 'stream_end'
    | 'usage_recorded'
  /** Milliseconds since the request started. Null when the stage never ran. */
  atMs: number | null
}

export interface LlmTraceRow {
  ts: number
  model: string
  keyId: string
  /** Owning chat session; absent for memory-extraction and system calls. */
  sessionId?: string
  status: 'success' | 'error'
  statusCode?: number
  attempts: number
  retried: boolean
  promptTokens: number
  completionTokens: number
  totalTokens: number
  firstByteMs?: number
  totalMs?: number
  error?: string
  stages: LlmTraceStage[]
}

export interface LlmProviderKeyUsage {
  keyId: string
  requests: number
  success: number
  failed: number
  successRate: number | null
  promptTokens: number
  completionTokens: number
  totalTokens: number
  avgFirstByteMs: number | null
  hourly: Array<{ hour: number; success: number; failed: number }>
}

/** Everything the provider detail view's three tabs need, in one round-trip. */
export interface LlmProviderDetailPayload {
  provider: string
  requests: number
  success: number
  retried: number
  failed: number
  successRate: number | null
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** Hour-of-day 0..23 x outcome, for the 24h request line and key heatmap. */
  hourly: Array<{ hour: number; success: number; failed: number }>
  keys: LlmProviderKeyUsage[]
  /** Most recent requests, newest first, each with its stage timeline. */
  recent: LlmTraceRow[]
}

/** Params for the gateway's explicit "test connection" probe. */
export interface LlmGatewayTestConnectionParams {
  /** Provider id from `llm-config.json`. */
  providerId: string
  /** Which key to probe; defaults to the provider's first enabled key. */
  keyId?: string
  /** Override the upstream model used for the probe. */
  model?: string
}

export interface LlmGatewayTestConnectionResult {
  success: boolean
  /** Classified, human-readable failure reason, present on failure. */
  error?: string
  /** Probe round-trip time, ms. Always present, success or failure. */
  elapsedMs: number
}

/**
 * Ask a provider's upstream which models it exposes.
 *
 * `llm-config.json` stores `models` as upstream-id -> public-name, and the
 * settings page could only ever show the ids already configured somewhere —
 * there was no way to learn what a freshly added provider actually serves, so
 * a provider with valid keys sat at "模型 0 个" and every test refused to run
 * (the probe needs a model name). This closes that loop.
 */
export interface LlmGatewayListModelsParams {
  /** Provider id from `llm-config.json`. */
  providerId: string
  /** Which key to authenticate with; defaults to the provider's first enabled key. */
  keyId?: string
}

export interface LlmGatewayListModelsResult {
  success: boolean
  /** Classified, human-readable failure reason, present on failure. */
  error?: string
  /** Upstream model ids, in the order the upstream returned them. */
  models: string[]
  /** Round-trip time, ms. Always present, success or failure. */
  elapsedMs: number
}
