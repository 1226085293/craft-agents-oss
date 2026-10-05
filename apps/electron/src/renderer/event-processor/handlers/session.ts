/**
 * Session Event Handlers
 *
 * Handles complete, error, sources_changed, etc.
 * Pure functions that return new state - no side effects.
 */

import type {
  SessionState,
  ProcessResult,
  CompleteEvent,
  ErrorEvent,
  TypedErrorEvent,
  SourcesChangedEvent,
  LabelsChangedEvent,
  ProjectIdChangedEvent,
  SessionStatusChangedEvent,
  SessionMetadataChangedEvent,
  SessionFlaggedEvent,
  SessionUnflaggedEvent,
  SessionArchivedEvent,
  SessionUnarchivedEvent,
  NameChangedEvent,
  PermissionRequestEvent,
  CredentialRequestEvent,
  PlanSubmittedEvent,
  StatusEvent,
  RetryEvent,
  InfoEvent,
  SystemStopNoticeEvent,
  InterruptedEvent,
  TitleGeneratedEvent,
  TitleRegeneratingEvent,
  AsyncOperationEvent,
  WorkingDirectoryChangedEvent,
  PermissionModeChangedEvent,
  SessionModelChangedEvent,
  LLMConnectionChangedEvent,
  UserMessageEvent,
  SessionClearedEvent,
  MessageAnnotationsUpdatedEvent,
  SessionSharedEvent,
  SessionUnsharedEvent,
  AuthRequestEvent,
  AuthCompletedEvent,
  UsageUpdateEvent,
  Effect,
} from '../types'
import type { Message } from '../../../shared/types'
import { generateMessageId, appendMessage, updateMessageAt, clearRetryStatus, dropCompactingStatus } from '../helpers'

/**
 * Handle complete - agent loop finished
 *
 * Sets isProcessing: false, clears streaming state.
 * Also marks any running tools as complete (fail-safe).
 */
export function handleComplete(
  state: SessionState,
  event: CompleteEvent
): ProcessResult {
  const session = clearRetryStatus(state.session)

  // Fail-safe: mark any non-terminal tools as complete.
  // Catches 'executing' (normal) and 'backgrounded' (spurious — e.g. foreground Agent
  // whose result contained agentId:). Genuinely backgrounded tasks have isBackground=true
  // AND a taskId, so they're excluded — task_completed will finalize them.
  const TERMINAL_TOOL_STATUSES = new Set(['completed', 'error'])
  let updatedMessages = session.messages
  const hasRunningTools = session.messages.some(
    m => m.role === 'tool'
      && !TERMINAL_TOOL_STATUSES.has(m.toolStatus ?? '')
      && !(m.isBackground && m.taskId)  // Don't force-complete genuine background tasks
  )

  if (hasRunningTools) {
    updatedMessages = session.messages.map(m => {
      if (
        m.role === 'tool'
        && !TERMINAL_TOOL_STATUSES.has(m.toolStatus ?? '')
        && !(m.isBackground && m.taskId)
      ) {
        return { ...m, toolStatus: 'completed' as const, toolResult: m.toolResult ?? '' }
      }
      return m
    })
  }

  // Clear isQueued from any user messages once the turn completes. Pi's steer
  // path never emits a 'processing' status update to clear it (the message is
  // injected mid-stream and absorbed into the current response), so this is
  // the natural place to drop the indicator. Claude's queued path has already
  // cleared via the 'processing' status update before this fires; this is
  // a safe no-op for that case.
  const hasQueuedUserBubbles = updatedMessages.some(m => m.role === 'user' && m.isQueued)
  if (hasQueuedUserBubbles) {
    updatedMessages = updatedMessages.map(m =>
      m.role === 'user' && m.isQueued ? { ...m, isQueued: false } : m
    )
  }

  return {
    state: {
      session: {
        ...session,
        messages: updatedMessages,
        isProcessing: false,
        currentStatus: undefined,  // Clear any lingering status
        // Update tokenUsage from complete event (for real-time context counter updates)
        tokenUsage: event.tokenUsage ?? session.tokenUsage,
        // Update hasUnread flag from main process (state machine for NEW badge)
        // Only update if explicitly provided - undefined means "don't change"
        ...(event.hasUnread !== undefined && { hasUnread: event.hasUnread }),
      },
      streaming: null,
    },
    effects: [],
  }
}

/**
 * Handle error - simple error event
 */
export function handleError(
  state: SessionState,
  event: ErrorEvent
): ProcessResult {
  const { streaming } = state
  // A failed turn ends any in-flight compaction: drop the pending
  // "Compacting context..." row (the error card carries the failure).
  const session = dropCompactingStatus(clearRetryStatus(state.session))

  // Fail-safe: Mark any running tools as failed
  const messagesWithFailedTools = session.messages.map(m =>
    m.role === 'tool' && m.toolResult === undefined && m.toolStatus !== 'completed' && m.toolStatus !== 'error'
      ? { ...m, toolStatus: 'error' as const, toolResult: 'Error occurred', isError: true }
      : m
  )

  const errorMessage: Message = {
    id: generateMessageId(),
    role: 'error',
    content: event.error,
    timestamp: event.timestamp ?? Date.now(),
  }

  return {
    state: {
      session: {
        ...session,
        messages: [...messagesWithFailedTools, errorMessage],
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle typed_error - error with structured details
 */
export function handleTypedError(
  state: SessionState,
  event: TypedErrorEvent
): ProcessResult {
  const { streaming } = state
  // See handleError: the failed turn ends any in-flight compaction, so the
  // pending compacting row is dropped alongside the retry status.
  const session = dropCompactingStatus(clearRetryStatus(state.session))

  // Fail-safe: Mark any running tools as failed
  const messagesWithFailedTools = session.messages.map(m =>
    m.role === 'tool' && m.toolResult === undefined && m.toolStatus !== 'completed' && m.toolStatus !== 'error'
      ? { ...m, toolStatus: 'error' as const, toolResult: 'Error occurred', isError: true }
      : m
  )

  const errorMessage: Message = {
    id: generateMessageId(),
    role: 'error',
    content: event.error.title
      ? `${event.error.title}: ${event.error.message}`
      : event.error.message,
    timestamp: event.timestamp ?? Date.now(),
    errorCode: event.error.code,
    errorTitle: event.error.title,
    errorDetails: event.error.details,
    errorOriginal: event.error.originalError,
    errorCanRetry: event.error.canRetry,
    errorActions: event.error.actions?.map(a => ({
      key: a.key,
      label: a.label,
      action: a.action,
      url: a.url,
      sourceSlug: a.sourceSlug,
    })),
  }

  return {
    state: {
      session: {
        ...session,
        messages: [...messagesWithFailedTools, errorMessage],
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Retry progress is transient, not transcript history. Only SDK lifecycle
 * events may end backoff — a delayed token/tool event is not proof of recovery.
 */
export function handleRetry(state: SessionState, event: RetryEvent): ProcessResult {
  const session = clearRetryStatus(state.session)
  if (event.phase !== 'backoff') {
    return { state: { session, streaming: state.streaming }, effects: [] }
  }

  // Replace prior progress rather than accumulating a running row per attempt.
  const retryMessage: Message = {
    id: generateMessageId(),
    role: 'status',
    statusType: 'retrying',
    content: event.message,
    timestamp: Date.now(),
  }
  return {
    state: {
      session: {
        ...appendMessage(session, retryMessage),
        currentStatus: { message: event.message, statusType: 'retrying' },
      },
      streaming: state.streaming,
    },
    effects: [],
  }
}

/**
 * Handle status - status message (e.g., compacting)
 * Stores on session for ProcessingIndicator AND appends as message for TurnCard activity.
 *
 * Compacting status is idempotent: repeated "Compacting context..." messages
 * (e.g. a second compaction_start for the same in-flight compaction, or the
 * Claude backend re-emitting its compacting status) update the existing row
 * in place instead of stacking duplicate lines in the process block.
 */
export function handleStatus(
  state: SessionState,
  event: StatusEvent
): ProcessResult {
  const { session, streaming } = state

  // Idempotent compacting: a repeated compacting status updates the existing
  // row in place instead of stacking another "Compacting context..." line.
  const compactingIdx =
    event.statusType === 'compacting'
      ? session.messages.findIndex(m => m.role === 'status' && m.statusType === 'compacting')
      : -1

  const statusMessage: Message = {
    id: generateMessageId(),
    role: 'status',
    content: event.message,
    timestamp: event.timestamp ?? Date.now(),
    statusType: event.statusType,
  }

  const updatedSession =
    compactingIdx !== -1
      ? updateMessageAt(session, compactingIdx, { content: event.message })
      : appendMessage(session, statusMessage)

  return {
    state: {
      session: {
        ...updatedSession,
        // Also store on session for ProcessingIndicator
        currentStatus: {
          message: event.message,
          statusType: event.statusType,
        },
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle info - info message (may update existing compacting message)
 */
export function handleInfo(
  state: SessionState,
  event: InfoEvent
): ProcessResult {
  const { session, streaming } = state

  // If this is a compaction complete, update the existing compacting message and clear currentStatus
  if (event.statusType === 'compaction_complete') {
    const updatedMessages = session.messages.map(m =>
      m.role === 'status' && m.statusType === 'compacting'
        ? { ...m, role: 'info' as const, content: event.message, statusType: 'compaction_complete' as const, infoLevel: event.level }
        : m
    )
    return {
      state: {
        session: {
          ...session,
          messages: updatedMessages,
          currentStatus: undefined,  // Clear status from ProcessingIndicator
        },
        streaming,
      },
      effects: [],
    }
  }

  // Verification result (2026-10-02 redesign): close the pending status card.
  // The verified reply is delivered separately as text_complete after this
  // event so the card always disappears before its result bubble appears.
  if (event.statusType === 'verification_passed') {
    const updatedMessages = session.messages.map(m =>
      m.role === 'status' && m.statusType === 'verification'
        ? { ...m, role: 'info' as const, content: event.message, statusType: 'verification_passed' as const, infoLevel: (event.level ?? 'success') as Message['infoLevel'] }
        : m
    )
    return {
      state: {
        session: {
          ...session,
          messages: updatedMessages,
          currentStatus: undefined,
        },
        streaming,
      },
      effects: [],
    }
  }
  if (event.statusType === 'verification_failed') {
    // Failed: mark the card as a warning — the LLM continues (followUp), so
    // no bubble is replayed here; the continuation's reply renders normally.
    const updatedMessages = session.messages.map(m =>
      m.role === 'status' && m.statusType === 'verification'
        ? { ...m, role: 'info' as const, content: event.message, statusType: 'verification_failed' as const, infoLevel: 'warning' as Message['infoLevel'] }
        : m
    )
    return {
      state: {
        session: {
          ...session,
          messages: updatedMessages,
          currentStatus: undefined,
        },
        streaming,
      },
      effects: [],
    }
  }

  // Otherwise, add as new info message
  const infoMessage: Message = {
    id: generateMessageId(),
    role: 'info',
    content: event.message,
    timestamp: event.timestamp ?? Date.now(),
    infoLevel: event.level,
  }

  return {
    state: {
      session: appendMessage(session, infoMessage),
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle system_stop_notice — a guardrail in the agent host stopped the turn
 * on its own (busy-limit call cap, no-progress repeat streak, defense
 * recovery exhausted). The user never pressed Stop, so show a persistent,
 * clearly-labelled notice with the real reason plus a "send continue" hint
 * instead of leaving the session looking silently hung.
 *
 * Rendered as a unified `error` message (same card as e.g. the "Pi agent
 * stream stalled" error) rather than a ⚠️ info/warning bubble: it IS an
 * error state, and mixing two visual languages for terminal errors makes
 * the process block look broken (2026-10-04 fleet-mist feedback).
 */
export function handleSystemStopNotice(
  state: SessionState,
  event: SystemStopNoticeEvent
): ProcessResult {
  const { session, streaming } = state
  const reason = event.reason && event.reason !== 'system_stop'
    ? ` (${event.reason})`
    : ''
  const notice: Message = {
    id: generateMessageId(),
    role: 'error',
    content: `This turn was stopped by the system guardrail${reason}: ${event.message}\nSend "continue" to resume where it left off.`,
    timestamp: event.timestamp ?? Date.now(),
  }
  return {
    state: {
      session: {
        ...appendMessage(session, notice),
        currentStatus: undefined, // clear any lingering "Thinking…" status
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle interrupted - agent was interrupted.
 *
 * Two distinct shapes:
 * - **User-initiated stop** (`event.message` present): user clicked the Stop
 *   button. We render the "Response interrupted" notice, drop queued user
 *   bubbles, and restore their text to the input field so the user can edit
 *   and re-send.
 * - **Silent redirect** (`event.message` absent): the agent aborted internally
 *   so a new message could be processed. The backend's `processNextQueuedMessage`
 *   will auto-replay queued messages — we must NOT remove the queued bubbles
 *   nor restore them to the input, otherwise the user perceives a silent drop
 *   (#616).
 */
export function handleInterrupted(
  state: SessionState,
  event: InterruptedEvent
): ProcessResult {
  const { session } = state
  const effects: Effect[] = []
  const isUserInitiated = !!event.message

  // Clear transient streaming state (isPending, isStreaming) and mark running tools as interrupted
  // These fields are not persisted, so this matches the state after a reload
  // Also filter out status messages - they are transient UI state that shouldn't persist after interruption
  const keptMessages = session.messages
    .filter(m => m.role !== 'status')  // Remove transient status messages
    // Only drop queued bubbles when the user explicitly stopped — silent
    // redirects auto-replay them so they must remain visible (#616).
    .filter(m => !(isUserInitiated && m.isQueued))

  // Index of the assistant message to flag as aborted. Walks back to the last
  // assistant message unless that one already delivered a final response — a
  // landed final is a real result, and there is no in-flight commentary left
  // to suppress in that case.
  let lastAbortedIdx = -1
  for (let i = keptMessages.length - 1; i >= 0; i--) {
    const m = keptMessages[i]!
    if (m.role !== 'assistant') continue
    if (m.isIntermediate === false && !m.isPending) break
    lastAbortedIdx = i
    break
  }

  const updatedMessages = keptMessages
    .map((m, i) => {
      // Mark running tools as interrupted
      if (m.role === 'tool' && m.toolResult === undefined && m.toolStatus !== 'completed' && m.toolStatus !== 'error') {
        return { ...m, toolStatus: 'error' as const, toolResult: 'Interrupted', isError: true }
      }
      // Clear pending state on assistant messages (transient streaming state)
      if (m.role === 'assistant' && m.isPending) {
        return { ...m, isPending: false, isStreaming: false, ...(i === lastAbortedIdx ? { aborted: true } : {}) }
      }
      // Flag the in-flight assistant message as aborted for restart recovery and
      // defense evaluation. The backend persists the same marker server-side.
      if (i === lastAbortedIdx) {
        return { ...m, aborted: true }
      }
      return m
    })

  // Only add the "Response interrupted" message if provided (not a silent redirect)
  const messages = event.message
    ? [...updatedMessages, event.message]
    : updatedMessages

  // Restore queued message text to the input field — only on user-initiated
  // stops. Silent redirects keep the bubble in chat and rely on the backend's
  // auto-replay (#616).
  if (isUserInitiated && event.queuedMessages && event.queuedMessages.length > 0) {
    effects.push({
      type: 'restore_input',
      text: event.queuedMessages.join('\n\n'),
    })
  }

  return {
    state: {
      session: {
        ...session,
        isProcessing: false,
        messages,
        currentStatus: undefined,  // Clear any lingering status
      },
      streaming: null,
    },
    effects,
  }
}

/**
 * Handle title_generated - update session title and clear regenerating state
 */
export function handleTitleGenerated(
  state: SessionState,
  event: TitleGeneratedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        name: event.title,
        // Clear regenerating state - title generation completed
        isRegeneratingTitle: false,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle title_regenerating - set regenerating state for shimmer effect
 * @deprecated Use handleAsyncOperation instead
 */
export function handleTitleRegenerating(
  state: SessionState,
  event: TitleRegeneratingEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        isRegeneratingTitle: event.isRegenerating,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle async_operation - set async operation state for shimmer effect
 * Generic handler for any async operation (sharing, updating share, revoking, title regeneration)
 */
export function handleAsyncOperation(
  state: SessionState,
  event: AsyncOperationEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        isAsyncOperationOngoing: event.isOngoing,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle working_directory_changed - update session working directory (user-initiated via UI)
 */
export function handleWorkingDirectoryChanged(
  state: SessionState,
  event: WorkingDirectoryChangedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: { ...session, workingDirectory: event.workingDirectory },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle permission_mode_changed - return effect for parent to handle session options
 */
export function handlePermissionModeChanged(
  state: SessionState,
  event: PermissionModeChangedEvent
): ProcessResult {
  return {
    state,
    effects: [{
      type: 'permission_mode_changed',
      sessionId: event.sessionId,
      permissionMode: event.permissionMode,
      previousPermissionMode: event.previousPermissionMode,
      transitionDisplay: event.transitionDisplay,
      modeVersion: event.modeVersion,
      changedAt: event.changedAt,
      changedBy: event.changedBy,
    }],
  }
}

/**
 * Handle session_model_changed - update session model
 */
export function handleSessionModelChanged(
  state: SessionState,
  event: SessionModelChangedEvent
): ProcessResult {
  const { session, streaming } = state

  // The agent-reported context window belongs to the model that produced it.
  // Drop it so the context-usage ring falls back to the NEW model's window
  // (registry / connection-model lookup, then the user-configured default
  // from config.json) immediately; the next usage event from the agent
  // re-populates it with the corrected value.
  const tokenUsage = session.tokenUsage && session.tokenUsage.contextWindow !== undefined
    ? { ...session.tokenUsage, contextWindow: undefined }
    : session.tokenUsage

  return {
    state: {
      session: { ...session, model: event.model ?? undefined, tokenUsage },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle connection_changed - sync session.llmConnection to renderer state
 */
export function handleConnectionChanged(
  state: SessionState,
  event: LLMConnectionChangedEvent
): ProcessResult {
  const { session, streaming } = state

  // A connection change implies a model (or at least a model pool) change —
  // the previously reported context window may no longer apply. Clear it so
  // the ring re-resolves from the (possibly new) model; the next usage event
  // re-populates it.
  const tokenUsage = session.tokenUsage && session.tokenUsage.contextWindow !== undefined
    ? { ...session.tokenUsage, contextWindow: undefined }
    : session.tokenUsage

  return {
    state: {
      session: {
        ...session,
        llmConnection: event.connectionSlug,
        tokenUsage,
        ...(event.supportsBranching !== undefined && { supportsBranching: event.supportsBranching }),
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle user_message - confirms optimistic user message from backend
 *
 * Three statuses:
 * - 'accepted': Message is being processed (confirms optimistic message)
 * - 'queued': Message was queued during ongoing response (adds if not present, marks as queued)
 * - 'processing': Queued message is now being processed (updates status)
 */
export function handleUserMessage(
  state: SessionState,
  event: UserMessageEvent
): ProcessResult {
  const { session, streaming } = state
  const { message, status } = event

  // Find existing message by ID match (backend ID, optimistic ID, or content+timestamp fallback)
  const existingIndex = session.messages.findIndex(m =>
    m.role === 'user' && (
      m.id === message.id ||
      (event.optimisticMessageId && m.id === event.optimisticMessageId) ||
      (m.content === message.content && Math.abs(m.timestamp - message.timestamp) < 5000)
    )
  )

  let updatedMessages: Message[]

  if (existingIndex >= 0) {
    const existingMessage = session.messages[existingIndex]

    // Event sequence protection: don't regress from 'processing' back to 'queued'
    // This handles out-of-order events (e.g., 'processing' arrives before 'queued')
    if (status === 'queued' && existingMessage.isQueued === false) {
      // Already progressed past queued state, ignore this late 'queued' event
      return { state, effects: [] }
    }

    // Update existing message — clear isPending, set isQueued based on status.
    //
    // - 'queued'     → isQueued = true  (Claude path: backend queued for re-send)
    // - 'processing' → isQueued = false (queued message is now actually running)
    // - 'accepted'   → isQueued = false (Pi steer path: agent has the message)
    //
    // A queued message is re-stamped by SessionManager when replay starts so it
    // sorts after the prior turn's final assistant response. Apply that canonical
    // timestamp on the processing transition; otherwise the already-mounted
    // optimistic bubble keeps its queue-time timestamp until the session reloads.
    //
    // We deliberately do NOT swap `m.id` to the backend's canonical id here.
    // ChatDisplay's `getTurnKey` keys user-message bubbles by id, and a swap
    // would unmount/remount the UserMessageBubble — wiping its local timer
    // state and dropping the queued chip mid-flight. The canonical backend
    // id is irrelevant to subsequent events: they all use
    // `event.optimisticMessageId` for routing (see the findIndex above).
    updatedMessages = session.messages.map((m, i) => {
      if (i === existingIndex) {
        return {
          ...m,
          ...(status === 'processing' ? { timestamp: message.timestamp } : {}),
          ...message,
          // Preserve the optimistic id to avoid remounting the bubble; copy the
          // backend fields (notably isGuidance) onto the existing UI message.
          id: m.id,
          isPending: false,
          isQueued: status === 'queued',
          isGuidance: message.isGuidance ?? m.isGuidance,
        }
      }
      return m
    })
  } else {
    // Message not found (e.g., queued message from backend) - add it
    const newMessage: Message = {
      ...message,
      isPending: false,
      isQueued: status === 'queued',
    }
    updatedMessages = [...session.messages, newMessage]
  }

  return {
    state: {
      session: {
        ...session,
        messages: updatedMessages,
        lastMessageAt: Date.now(),
        lastMessageRole: 'user',  // Clear plan badge when user responds
        // Set isProcessing when message is accepted/processing (enables multi-window sync).
        // For 'queued' status the current turn is STILL running (the message was queued
        // mid-stream while the agent continues), so preserve the existing value — flipping
        // it false here would make groupMessagesByTurn treat the session as complete and
        // prematurely promote the in-flight thinking text into a "final" reply box (#616).
        isProcessing: status === 'accepted' || status === 'processing'
          ? true
          : session.isProcessing,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle message_removed - remove a queued message canceled from another control/window.
 */
export function handleMessageRemoved(
  state: SessionState,
  event: { messageId: string }
): ProcessResult {
  const { session, streaming } = state
  return {
    state: {
      session: {
        ...session,
        messages: session.messages.filter(m => m.id !== event.messageId),
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle session_cleared - remove visible messages and reset runtime context state.
 */
export function handleSessionCleared(
  state: SessionState,
  _event: SessionClearedEvent
): ProcessResult {
  const { session } = state
  return {
    state: {
      session: {
        ...session,
        messages: [],
        isProcessing: false,
        currentStatus: undefined,
        tokenUsage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          contextTokens: 0,
          costUsd: 0,
        },
        lastMessageRole: undefined,
        lastFinalMessageId: undefined,
        preview: undefined,
        messageCount: 0,
        hasUnread: false,
        lastReadMessageId: undefined,
      },
      streaming: null,
    },
    effects: [],
  }
}

/**
 * Handle message_annotations_updated - update annotations on a specific message.
 */
export function handleMessageAnnotationsUpdated(
  state: SessionState,
  event: MessageAnnotationsUpdatedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        messages: session.messages.map(m =>
          m.id === event.messageId
            ? { ...m, annotations: event.annotations }
            : m
        ),
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle sources_changed - update session's enabled sources
 */
export function handleSourcesChanged(
  state: SessionState,
  event: SourcesChangedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        enabledSourceSlugs: event.enabledSourceSlugs,
        sourceScope: event.sourceScope,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle labels_changed - update session's labels
 */
export function handleLabelsChanged(
  state: SessionState,
  event: LabelsChangedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        labels: event.labels,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle project_id_changed - update session's projectId binding
 */
export function handleProjectIdChanged(
  state: SessionState,
  event: ProjectIdChangedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        projectId: event.projectId ?? undefined,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle session_status_changed - update session's sessionStatus (external metadata change or agent tool)
 */
export function handleSessionStatusChanged(
  state: SessionState,
  event: SessionStatusChangedEvent
): ProcessResult {
  const { session, streaming } = state
  return {
    state: {
      session: { ...session, sessionStatus: event.sessionStatus },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle session_metadata_changed - merge programmatic metadata changes (taskNodeCount,
 * kanbanColumn, and the taskDraft→taskSlug promotion on orchestrator adoption) that don't
 * propagate via the header-signature file watch.
 */
export function handleSessionMetadataChanged(
  state: SessionState,
  event: SessionMetadataChangedEvent
): ProcessResult {
  const { session, streaming } = state
  return {
    state: {
      session: { ...session, ...event.changes },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle session_flagged - mark session as flagged
 */
export function handleSessionFlagged(
  state: SessionState,
  _event: SessionFlaggedEvent
): ProcessResult {
  const { session, streaming } = state
  return {
    state: {
      session: { ...session, isFlagged: true },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle session_unflagged - mark session as unflagged
 */
export function handleSessionUnflagged(
  state: SessionState,
  _event: SessionUnflaggedEvent
): ProcessResult {
  const { session, streaming } = state
  return {
    state: {
      session: { ...session, isFlagged: false },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle session_archived - mark session as archived
 */
export function handleSessionArchived(
  state: SessionState,
  _event: SessionArchivedEvent
): ProcessResult {
  const { session, streaming } = state
  return {
    state: {
      session: { ...session, isArchived: true, archivedAt: Date.now() },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle session_unarchived - mark session as unarchived
 */
export function handleSessionUnarchived(
  state: SessionState,
  _event: SessionUnarchivedEvent
): ProcessResult {
  const { session, streaming } = state
  return {
    state: {
      session: { ...session, isArchived: false, archivedAt: undefined },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle name_changed - update session name (external metadata change)
 */
export function handleNameChanged(
  state: SessionState,
  event: NameChangedEvent
): ProcessResult {
  const { session, streaming } = state
  return {
    state: {
      session: { ...session, name: event.name },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle permission_request - return effect for parent to handle
 */
export function handlePermissionRequest(
  state: SessionState,
  event: PermissionRequestEvent
): ProcessResult {
  return {
    state,
    effects: [{
      type: 'permission_request',
      request: event.request,
    }]
  }
}

/**
 * Handle credential_request - return effect for parent to handle
 */
export function handleCredentialRequest(
  state: SessionState,
  event: CredentialRequestEvent
): ProcessResult {
  return {
    state,
    effects: [{
      type: 'credential_request',
      request: event.request,
    }]
  }
}

/**
 * Handle plan_submitted - add plan message to session
 */
export function handlePlanSubmitted(
  state: SessionState,
  event: PlanSubmittedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: appendMessage(session, event.message),
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle session_shared - session was shared to viewer
 */
export function handleSessionShared(
  state: SessionState,
  event: SessionSharedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        sharedUrl: event.sharedUrl,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle session_unshared - session share was revoked
 */
export function handleSessionUnshared(
  state: SessionState,
  _event: SessionUnsharedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        sharedUrl: undefined,
        sharedId: undefined,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle auth_request - add auth-request message to session
 * This is the unified auth flow - execution is paused until auth completes
 */
export function handleAuthRequest(
  state: SessionState,
  event: AuthRequestEvent
): ProcessResult {
  const { session, streaming } = state

  // Add auth-request message to session
  return {
    state: {
      session: {
        ...appendMessage(session, event.message),
        isProcessing: false,  // Agent execution is paused
      },
      streaming: null,  // Clear any streaming state
    },
    effects: [],
  }
}

/**
 * Handle auth_completed - update auth-request message status
 * The agent will resume via a new user message (sent by session manager)
 */
export function handleAuthCompleted(
  state: SessionState,
  event: AuthCompletedEvent
): ProcessResult {
  const { session, streaming } = state

  // Update the auth-request message status
  const updatedMessages = session.messages.map(m => {
    if (
      m.role === 'auth-request' &&
      m.authRequestId === event.requestId &&
      m.authStatus === 'pending'
    ) {
      return {
        ...m,
        authStatus: event.success
          ? ('completed' as const)
          : event.cancelled
            ? ('cancelled' as const)
            : ('failed' as const),
        authError: event.error,
      }
    }
    return m
  })

  return {
    state: {
      session: {
        ...session,
        messages: updatedMessages,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle usage_update - real-time context usage during processing
 * Merges usage update into existing tokenUsage (preserves outputTokens, costUsd, etc.)
 */
export function handleUsageUpdate(
  state: SessionState,
  event: UsageUpdateEvent
): ProcessResult {
  const { session, streaming } = state

  // Merge usage update into existing tokenUsage, providing defaults for required fields
  const updatedTokenUsage = {
    inputTokens: event.tokenUsage.inputTokens,
    outputTokens: session.tokenUsage?.outputTokens ?? 0,
    totalTokens: session.tokenUsage?.totalTokens ?? 0,
    contextTokens: session.tokenUsage?.contextTokens ?? 0,
    costUsd: session.tokenUsage?.costUsd ?? 0,
    ...(session.tokenUsage?.cacheReadTokens !== undefined && { cacheReadTokens: session.tokenUsage.cacheReadTokens }),
    ...(session.tokenUsage?.cacheCreationTokens !== undefined && { cacheCreationTokens: session.tokenUsage.cacheCreationTokens }),
    ...(event.tokenUsage.contextWindow && { contextWindow: event.tokenUsage.contextWindow }),
  }

  return {
    state: {
      session: {
        ...session,
        tokenUsage: updatedTokenUsage,
      },
      streaming,
    },
    effects: [],
  }
}
