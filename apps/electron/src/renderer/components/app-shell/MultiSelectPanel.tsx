/**
 * MultiSelectPanel - Panel shown when multiple items are selected.
 *
 * Displays the selection count and optional batch action buttons.
 * Used for sessions (with archive actions), sources, and skills.
 */

import * as React from 'react'
import { Archive, CheckCircle2, Send } from 'lucide-react'
import { useTranslation, Trans } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'
import { isMac } from '@/lib/platform'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuSeparator,
} from '@/components/ui/styled-dropdown'

type MultiSelectEntityType = 'automation' | 'session' | 'skill' | 'source'

export interface MultiSelectPanelProps {
  /** Number of selected items */
  count: number
  /** Entity type used to resolve localized selection copy (default: "session") */
  entityType?: MultiSelectEntityType
  /** Callback when archiving all selected */
  onArchive?: () => void
  /** Callback when sending selected to another workspace */
  onSendToWorkspace?: () => void
  /** Callback when clearing the selection */
  onClearSelection?: () => void
  /** Optional className for the container */
  className?: string
}

export function MultiSelectPanel({
  count,
  entityType = 'session',
  onArchive,
  onSendToWorkspace,
  onClearSelection,
  className,
}: MultiSelectPanelProps) {
  const { t } = useTranslation()
  const clickLabel = t('multiSelect.click')

  const commandClick = (
    <KbdGroup>
      <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>
      <Kbd>{clickLabel}</Kbd>
    </KbdGroup>
  )

  const shiftClick = (
    <KbdGroup>
      <Kbd>⇧</Kbd>
      <Kbd>{clickLabel}</Kbd>
    </KbdGroup>
  )

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center h-full gap-6 p-8',
        className
      )}
    >
      {/* Selection count */}
      <div className="flex flex-col items-center gap-2">
        <div className="w-16 h-16 rounded-full bg-accent/10 flex items-center justify-center">
          <span className="text-2xl font-semibold text-accent">{count}</span>
        </div>
        <h2 className="text-lg font-medium text-foreground">
          {t(`multiSelect.selected.${entityType}`, { count })}
        </h2>
        <div className="text-sm text-foreground/50 flex flex-col items-center gap-1">
          <span>
            <Trans
              i18nKey="multiSelect.selectionHint"
              components={{
                cmdClick: commandClick,
                shiftClick,
              }}
            />
          </span>
          <span>
            <Trans
              i18nKey="multiSelect.clearSelection"
              components={{ kbd: <Kbd /> }}
            />
          </span>
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex flex-wrap justify-center gap-2">
        {onSendToWorkspace && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onSendToWorkspace}
            className="gap-2 bg-background shadow-minimal hover:bg-foreground/[0.03]"
          >
            <Send className="w-4 h-4" />
            {t('sessionMenu.sendToWorkspace')}
          </Button>
        )}
        {onArchive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onArchive}
            className="gap-2 bg-background shadow-minimal hover:bg-foreground/[0.03]"
          >
            <Archive className="w-4 h-4" />
            {t('sessionMenu.archive')}
          </Button>
        )}
      </div>

      {/* Keyboard hint moved below click hint */}
    </div>
  )
}
