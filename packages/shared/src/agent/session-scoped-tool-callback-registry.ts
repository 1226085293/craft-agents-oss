/**
 * Session-Scoped Tool Callback Registry
 *
 * Extracted from session-scoped-tools.ts to break the dependency between
 * the callback registry (shared by Pi paths) and the Pi SDK
 * adapter layer (only used by PiAgent).
 *
 * The registry is a simple Map keyed by sessionId. Each backend registers
 * callbacks when a session starts and merges additional callbacks (e.g.
 * browser pane functions) as they become available.
 */

import type { LLMQueryRequest, LLMQueryResult } from './llm-tool.ts';
import type { SpawnSessionFn } from './spawn-session-tool.ts';
import type { BrowserPaneFns } from './browser-tools.ts';
import type { AuthRequest } from '@craft-agent/session-tools-core';
import { debug } from '../utils/debug.ts';

/**
 * Callbacks that can be registered per-session
 */
export interface SessionScopedToolCallbacks {
  /**
   * Called when a plan is submitted via SubmitPlan tool.
   * Receives the path to the plan markdown file.
   */
  onPlanSubmitted?: (planPath: string) => void;

  /**
   * Called when authentication is requested via OAuth/credential tools.
   * The auth UI should be shown and execution paused.
   */
  onAuthRequest?: (request: AuthRequest) => void;

  /**
   * Agent-native LLM query callback for call_llm tool (OAuth path).
   * Each agent backend sets this to its own queryLlm implementation.
   */
  queryFn?: (request: LLMQueryRequest) => Promise<LLMQueryResult>;

  /**
   * Callback for spawn_session tool — creates an independent session and sends initial prompt.
   * Each agent backend delegates to its onSpawnSession callback.
   */
  spawnSessionFn?: SpawnSessionFn;

  /**
   * Browser pane functions for browser_* tools.
   * Set by the Electron session manager — wraps BrowserPaneManager
   * with the session's bound browser instance.
   */
  browserPaneFns?: BrowserPaneFns;

  /** Archive (archived=true) or unarchive (archived=false) a session by ID. */
  archiveSessionFn?: (sessionId: string, archived: boolean) => void | Promise<void>;
  /** Get detailed info about a session (defaults to current). */
  getSessionInfoFn?: (sessionId?: string) => import('@craft-agent/session-tools-core').SessionInfo | null;
  /** List sessions in the workspace with pagination. */
  listSessionsFn?: (options?: import('@craft-agent/session-tools-core').ListSessionsOptions) => import('@craft-agent/session-tools-core').ListSessionsResult;
  /** List background tasks (running + terminal) for a session from the main-process registry. */
  listBackgroundTasksFn?: (sessionId?: string) => import('@craft-agent/session-tools-core').BackgroundTaskInfo[];
  /** Read the tail of a background task's output by task/shell ID. */
  getBackgroundTaskOutputFn?: (taskId: string, tailLines?: number) => Promise<string | null>;
  /** Stop a running background task and record who stopped it. */
  stopBackgroundTaskFn?: (taskId: string, stoppedBy?: 'model' | 'user') => Promise<import('@craft-agent/session-tools-core').BackgroundTaskStopResult>;
  /** Resolve label display names to IDs. */
  /** Resolve a status display name to its ID. */
  /** Send a message to another session (inter-session messaging). Resolves with delivery status. */
  sendAgentMessageFn?: (sessionId: string, message: string, attachments?: Array<{ path: string; name?: string }>) => Promise<import('@craft-agent/session-tools-core').SendAgentMessageResult>;
  /**
   * True when the text is a session-level slash command (`/stop`). Commands
   * skip the sender envelope so the target can parse them as commands.
   */
  isSessionCommand?: (text: string) => boolean;
  /** Follow another session: each finished turn is posted to it and wakes it. */
  subscribeSessionFn?: (sessionId: string) => { subscribed: boolean; targetIds: string[] };
  /** Stop following a session. Idempotent. */
  unsubscribeSessionFn?: (sessionId: string) => { unsubscribed: boolean; targetIds: string[] };
  /** Session ids this session currently follows. */
  listSubscriptionsFn?: () => string[];
  /** Get messaging bindings for a session. */
  getMessagingBindingsFn?: (sessionId: string) => Array<{ platform: string; channelId: string; threadId?: number; channelName?: string; enabled: boolean }>;
  /** Unbind messaging channels from a session. Returns count of removed bindings. */
  unbindMessagingChannelFn?: (sessionId: string, platform?: string) => number;
  /** Deliver a local file to messaging channels bound to this session. */
  deliverFileToMessagingFn?: (args: {
    path: string;
    filename?: string;
    caption?: string;
    target?: 'active_channel' | 'mobile' | 'all_bound_channels';
    platform?: 'telegram' | 'whatsapp' | 'lark' | 'qq' | 'wechat';
  }) => Promise<{
    filename: string;
    sent: number;
    failed: number;
    failures: Array<{ platform: string; channelId: string; error: string }>;
  }>;
  /**
   * Pages tools (list/get/create/update/write data/delete) — grouped in one
   * object because the six operations always ship together. Wired by
   * SessionManager to the invoking session's workspace.
   */
  pages?: import('@craft-agent/session-tools-core').PagesToolCallbacks;
}

// Registry of callbacks keyed by sessionId
const sessionScopedToolCallbackRegistry = new Map<string, SessionScopedToolCallbacks>();

/**
 * Register callbacks for a specific session
 */
export function registerSessionScopedToolCallbacks(
  sessionId: string,
  callbacks: SessionScopedToolCallbacks
): void {
  sessionScopedToolCallbackRegistry.set(sessionId, callbacks);
  debug('session-scoped-tools', `Registered callbacks for session ${sessionId}`);
}

/**
 * Merge additional callbacks into an existing session's callback set.
 * Used by the Electron session manager to add browser pane functions
 * after the agent has already registered its core callbacks.
 */
export function mergeSessionScopedToolCallbacks(
  sessionId: string,
  callbacks: Partial<SessionScopedToolCallbacks>
): void {
  const existing = sessionScopedToolCallbackRegistry.get(sessionId) ?? {};
  sessionScopedToolCallbackRegistry.set(sessionId, { ...existing, ...callbacks });
  debug('session-scoped-tools', `Merged callbacks for session ${sessionId}`);
}

/**
 * Unregister callbacks for a session
 */
export function unregisterSessionScopedToolCallbacks(sessionId: string): void {
  sessionScopedToolCallbackRegistry.delete(sessionId);
  debug('session-scoped-tools', `Unregistered callbacks for session ${sessionId}`);
}

/**
 * Get callbacks for a session
 */
export function getSessionScopedToolCallbacks(sessionId: string): SessionScopedToolCallbacks | undefined {
  return sessionScopedToolCallbackRegistry.get(sessionId);
}
