import * as React from 'react'
import { useTranslation } from "react-i18next"
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SlashCommandMenu, DEFAULT_SLASH_COMMAND_GROUPS, type SlashCommandId } from '@/components/ui/slash-command-menu'
import { ChevronDown, Info } from 'lucide-react'
import { PERMISSION_MODE_CONFIG, type PermissionMode } from '@craft-agent/shared/agent/modes'
import { useDynamicStack } from '@/hooks/useDynamicStack'
import { SessionInfoPopover } from './SessionInfoPopover'
import { BackgroundTaskToolbar } from './input/BackgroundTaskToolbar'

// ============================================================================
// Permission Mode Icon Component
// ============================================================================

function PermissionModeIcon({ mode, className }: { mode: PermissionMode; className?: string }) {
  const config = PERMISSION_MODE_CONFIG[mode]
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d={config.svgPath} />
    </svg>
  )
}

export interface ActiveOptionBadgesProps {
  /** Current permission mode */
  permissionMode?: PermissionMode
  /** Callback when permission mode changes */
  onPermissionModeChange?: (mode: PermissionMode) => void
  /** Session ID for opening preview windows */
  sessionId?: string
  /** Absolute path to the session folder (for Files header actions) */
  sessionFolderPath?: string
  // ── State/status badge (in dynamic stack) ──
  /** Available workflow states */
  /** Current session state ID */
  /** Callback when state changes */
  /** Additional CSS classes */
  className?: string
}

export function ActiveOptionBadges({
  permissionMode = 'ask',
  onPermissionModeChange,
  sessionId,
  sessionFolderPath,
  className,
}: ActiveOptionBadgesProps) {
  // Only render if a mode badge is present
  if (!permissionMode) {
    return null
  }

  return (
    <>
    <div className={cn("flex items-start gap-2 mb-2 px-px pt-px pb-0.5", className)}>
      {/* Left side: mode stack */}
      <div className="flex items-start gap-2 min-w-0 flex-1">
        {/* Permission Mode Badge */}
        {permissionMode && (
          <div className="shrink-0">
            <PermissionModeDropdown
              permissionMode={permissionMode}
              onPermissionModeChange={onPermissionModeChange}
              sessionId={sessionId}
            />
          </div>
        )}

        {/* Background work + followed sessions right after the mode button
            (执行 → 后台任务 → 子会话). The wrapper matches the 30px mode-badge
            height so the smaller h-6 trigger centers vertically instead of
            top-floating. Renders nothing when empty. */}
        <div className="flex h-[30px] items-center gap-1 shrink-0">
          {sessionId && <BackgroundTaskToolbar sessionId={sessionId} />}
        </div>

      </div>

      {/* Right side: Files popover button */}
      <div className="shrink-0">
        <FilesPopoverButton sessionId={sessionId} sessionFolderPath={sessionFolderPath} />
      </div>
    </div>
    </>
  )
}

function FilesPopoverButton({ sessionId, sessionFolderPath }: { sessionId?: string; sessionFolderPath?: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)

  if (!sessionId) return null

  return (
    <SessionInfoPopover
      sessionId={sessionId}
      sessionFolderPath={sessionFolderPath}
      trigger={(
        <button
          type="button"
          className={cn(
            "h-[30px] pl-[12px] pr-[14px] text-xs font-medium rounded-[8px] flex items-center gap-1.5 shrink-0",
            "outline-none select-none transition-colors shadow-minimal",
            "hover:bg-foreground/5 data-[state=open]:bg-foreground/5",
            "bg-[color-mix(in_srgb,var(--background)_97%,var(--foreground)_3%)]",
            "text-foreground/80",
          )}
        >
          <Info className="h-3.5 w-3.5 shrink-0" />
          <span className="whitespace-nowrap">{t("common.info")}</span>
        </button>
      )}
    />
  )
}

interface PermissionModeDropdownProps {
  permissionMode: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
  sessionId?: string
}

function PermissionModeDropdown({ permissionMode, onPermissionModeChange, sessionId }: PermissionModeDropdownProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  // Optimistic local state - updates immediately, syncs with prop
  const [optimisticMode, setOptimisticMode] = React.useState(permissionMode)

  // Sync optimistic state when prop changes (confirmation from backend)
  React.useEffect(() => {
    setOptimisticMode(permissionMode)
  }, [permissionMode])

  const activeCommands = React.useMemo((): SlashCommandId[] => {
    return [optimisticMode as SlashCommandId]
  }, [optimisticMode])

  // Handle command selection from dropdown
  const handleSelect = React.useCallback((commandId: SlashCommandId) => {
    if (commandId === 'safe' || commandId === 'ask' || commandId === 'allow-all') {
      setOptimisticMode(commandId)
      onPermissionModeChange?.(commandId)
    }
    setOpen(false)
  }, [onPermissionModeChange])

  // Get config for current mode (use optimistic state for instant UI update)
  const config = PERMISSION_MODE_CONFIG[optimisticMode]

  // Mode-specific styling using CSS variables (theme-aware)
  // - safe (Explore): foreground at 60% opacity - subtle, read-only feel
  // - ask (Ask to Edit): info color - amber, prompts for edits
  // - allow-all (Auto): accent color - purple, full autonomy
  const modeStyles: Record<PermissionMode, { className: string; shadowVar: string }> = {
    'safe': {
      className: 'bg-foreground/5 text-foreground/60',
      shadowVar: 'var(--foreground-rgb)',
    },
    'ask': {
      className: 'bg-info/10 text-info',
      shadowVar: 'var(--info-rgb)',
    },
    'allow-all': {
      className: 'bg-accent/5 text-accent',
      shadowVar: 'var(--accent-rgb)',
    },
  }
  const currentStyle = modeStyles[optimisticMode]

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-tutorial="permission-mode-dropdown"
          className={cn(
            "h-[30px] pl-2.5 pr-2 text-xs font-medium rounded-[8px] flex items-center gap-1.5 shadow-tinted outline-none select-none",
            currentStyle.className
          )}
          style={{ '--shadow-color': currentStyle.shadowVar } as React.CSSProperties}
        >
          <PermissionModeIcon mode={optimisticMode} className="h-3.5 w-3.5" />
          <span>{t(`mode.${optimisticMode}`)}</span>
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-auto p-0 rounded-[8px] bg-background text-foreground shadow-modal-small"
        side="top"
        align="start"
        sideOffset={4}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          // Don't auto-focus the text input on touch devices — it pulls up the virtual keyboard
          const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0
          if (!isTouchDevice) {
            window.dispatchEvent(new CustomEvent('craft:focus-input', {
              detail: { sessionId }
            }))
          }
        }}
      >
        <SlashCommandMenu
          commandGroups={DEFAULT_SLASH_COMMAND_GROUPS}
          activeCommands={activeCommands}
          onSelect={handleSelect}
          showFilter
        />
      </PopoverContent>
    </Popover>
  )
}

