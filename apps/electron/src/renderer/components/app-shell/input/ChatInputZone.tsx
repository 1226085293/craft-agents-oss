import * as React from 'react'
import { cn } from '@/lib/utils'
import { CHAT_LAYOUT } from '@/config/layout'
import type { PermissionMode } from '@craft-agent/shared/agent/modes'
import { ActiveOptionBadges } from '../ActiveOptionBadges'
import { InputContainer } from './InputContainer'
import { InputErrorBoundary } from './InputErrorBoundary'
import { QueuedMessagesPanel } from './QueuedMessagesPanel'
import type { QueuedMessageSummary } from '../../../../shared/types'

interface ChatInputZoneProps {
  compactMode?: boolean
  showOptionBadges?: boolean
  permissionMode?: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
  sessionId: string
  sessionFolderPath?: string
  /**
   * Pending send queue (2026-10-22 queued-panel). Rendered as a compact list
   * ABOVE the input: drag handle on the left, guide/edit/delete on the right.
   */
  queuedMessages?: QueuedMessageSummary[]
  onReorderQueuedMessages?: (messageIds: string[]) => void
  onGuideQueuedMessage?: (messageId: string) => void
  onEditQueuedMessage?: (messageId: string) => void
  onCancelQueuedMessage?: (messageId: string) => void
  className?: string
  inputProps: React.ComponentProps<typeof InputContainer>
}

export function ChatInputZone({
  compactMode = false,
  showOptionBadges,
  permissionMode = 'ask',
  onPermissionModeChange,
  sessionId,
  sessionFolderPath,
  queuedMessages,
  onReorderQueuedMessages,
  onGuideQueuedMessage,
  onEditQueuedMessage,
  onCancelQueuedMessage,
  className,
  inputProps,
}: ChatInputZoneProps) {
  const shouldShowOptionBadges = showOptionBadges ?? !compactMode
  const inputResetKey = `${sessionId}::${inputProps.structuredInput?.type ?? 'freeform'}`

  const handleClearDraft = React.useCallback(() => {
    inputProps.onInputChange?.('')
    inputProps.onAttachmentsChange?.([])
  }, [inputProps])

  return (
    <div className={cn(
      CHAT_LAYOUT.maxWidth,
      'mx-auto w-full mt-1',
      compactMode ? 'px-2 pb-3' : 'px-3 @xs/panel:px-4 pb-4',
      className,
    )}>
      {shouldShowOptionBadges ? (
        <ActiveOptionBadges
          permissionMode={permissionMode}
          onPermissionModeChange={onPermissionModeChange}
          sessionId={sessionId}
          sessionFolderPath={sessionFolderPath}
        />
      ) : null}

      {/* Background tasks used to render here as a chip row above the composer.
          They now live inside the composer toolbar (BackgroundTasksPopover /
          ChildSessionsPopover), so this zone renders nothing for them. */}

      {/* Pending send queue — sits directly above the composer (2026-10-22).
          Renders nothing when the queue is empty. */}
      {queuedMessages && queuedMessages.length > 0 && onReorderQueuedMessages && onGuideQueuedMessage && onEditQueuedMessage && onCancelQueuedMessage && (
        <QueuedMessagesPanel
          items={queuedMessages}
          onReorder={onReorderQueuedMessages}
          onGuide={onGuideQueuedMessage}
          onEdit={onEditQueuedMessage}
          onCancel={onCancelQueuedMessage}
          className="mb-2"
        />
      )}

      <InputErrorBoundary
        sessionId={sessionId}
        resetKey={inputResetKey}
        onClearDraft={handleClearDraft}
      >
        <InputContainer
          {...inputProps}
          compactMode={compactMode}
          permissionMode={permissionMode}
          onPermissionModeChange={onPermissionModeChange}
          sessionFolderPath={sessionFolderPath}
          sessionId={sessionId}
        />
      </InputErrorBoundary>
    </div>
  )
}
