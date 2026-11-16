import { formatDistanceToNowStrict } from "date-fns"
import type { Locale } from "date-fns"
import { Flag, ShieldAlert } from "lucide-react"
import { useActionLabel } from "@/actions"
import { cn } from "@/lib/utils"
import { rendererPerf } from "@/lib/perf"
import { Spinner } from "@craft-agent/ui"
import { EntityRow } from "@/components/ui/entity-row"
import { SessionMenu } from "./SessionMenu"
import { BatchSessionMenu } from "./BatchSessionMenu"
import { CompactSessionMenu } from "./CompactSessionMenu"
import { SessionProjectColorWrapper } from "./SessionProjectColorWrapper"
import { hasTransferTargets } from "./transfer-targets"
import { useProjectColorTreatment } from "@/hooks/useProjectColorTreatment"
import { getSessionTitle, getSessionPreviewText, highlightMatch, hasUnreadMeta, shortTimeLocale } from "@/utils/session"
import { useSessionListContext } from "@/context/SessionListContext"
import { useAppShellContext } from "@/context/AppShellContext"
import { navigate, routes } from "@/lib/navigate"
import { beginSessionDrag, endDrag, DRAG_ENABLED } from './dragState'
import type { SessionMeta } from "@/atoms/sessions"

export interface SessionItemProps {
  item: SessionMeta
  index: number
  itemProps: Record<string, unknown>
  isSelected: boolean
  isFirstInGroup: boolean
  isInMultiSelect: boolean
  onSelect: () => void
  onToggleSelect?: () => void
  onRangeSelect?: () => void
}

export function SessionItem({
  item,
  itemProps,
  isSelected,
  isFirstInGroup,
  isInMultiSelect,
  onSelect,
  onToggleSelect,
  onRangeSelect,
}: SessionItemProps) {
  const ctx = useSessionListContext()
  const { workspaces, isCompactMode } = useAppShellContext()
  const canSendToWorkspace = hasTransferTargets(workspaces)
  const { hotkey: nextHotkey } = useActionLabel('chat.nextSearchMatch')
  const { hotkey: prevHotkey } = useActionLabel('chat.prevSearchMatch')
  const title = getSessionTitle(item)
  // For the active session, prefer logical match count over ripgrep count
  const activeMatch = ctx.activeChatMatchInfo
  const isActiveSession = isSelected && activeMatch?.sessionId === item.id
  const ripgrepMatchCount = ctx.contentSearchResults.get(item.id)?.matchCount
  const chatMatchCount = isActiveSession ? activeMatch!.count : ripgrepMatchCount
  const hasMatch = chatMatchCount != null && chatMatchCount > 0
  const hasPendingPrompt = ctx.hasPendingPrompt?.(item.id) ?? false
  const previewText = isCompactMode ? getSessionPreviewText(item) : null

  // Resolve the bound project so the row can show a project-themed stripe /
  // tint and reveal the project name on hover. Treatment is a user preference
  // under Appearance.
  const projectColorTreatment = useProjectColorTreatment()
  const boundProject = item.projectId
    ? ctx.projects?.find(p => p.id === item.projectId)
    : undefined
  const projectColor = boundProject?.color
  const projectName = boundProject?.name

  const handleClick = (e: React.MouseEvent) => {
    ctx.onFocusZone()
    if (e.button === 2) {
      if (ctx.isMultiSelectActive && !isInMultiSelect && onToggleSelect) onToggleSelect()
      return
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
      // Cmd+Shift+Click: open session in a new panel
      e.preventDefault()
      navigate(routes.view.allSessions(item.id), { newPanel: true })
      return
    }
    if ((e.metaKey || e.ctrlKey) && onToggleSelect) {
      // Cmd+Click: always toggle multi-select (standard OS behavior)
      e.preventDefault()
      onToggleSelect()
      return
    }
    if (e.shiftKey && onRangeSelect) {
      e.preventDefault()
      onRangeSelect()
      return
    }
    rendererPerf.startSessionSwitch(item.id)
    onSelect()
  }

  return (
    <SessionProjectColorWrapper color={projectColor} treatment={projectColorTreatment}>
    <EntityRow
      className="session-item"
      dataAttributes={{ 'data-session-id': item.id }}
      showSeparator={!isFirstInGroup}
      separatorClassName="pl-[38px] pr-4"
      isSelected={isSelected}
      isInMultiSelect={isInMultiSelect}
      // When a project stripe is drawn at the leading edge, suppress EntityRow's
      // own blue selection bar so they don't stack. The row's background tint
      // continues to convey "selected".
      suppressSelectionBar={!!projectColor}
      onMouseDown={handleClick}
      buttonProps={{
        ...itemProps,
        // D31: session rows are the drag source; dropping is handled by FolderTree / the list.
        // Off while DRAG_ENABLED is false — see dragState.ts: a task's sessions are filed
        // automatically and dragging one out of its task's folder loses the only thing tying it
        // to the work it belongs to.
        draggable: DRAG_ENABLED,
        onDragStart: (e: React.DragEvent) => {
          e.dataTransfer.setData('application/x-craft-session', item.id)
          e.dataTransfer.effectAllowed = 'move'
          beginSessionDrag(item.id, (item as { folderId?: string | null }).folderId ?? null, item.projectId ?? null)
        },
        onDragEnd: endDrag,
        onKeyDown: (e: React.KeyboardEvent) => {
          ;(itemProps as { onKeyDown: (event: React.KeyboardEvent) => void }).onKeyDown(e)
          ctx.onKeyDown(e, item)
        },
      }}
      menuContent={
        <SessionMenu
          item={item}
          onRename={() => ctx.onRenameClick(item.id, title)}
          onArchive={() => ctx.onArchive?.(item.id)}
          onUnarchive={() => ctx.onUnarchive?.(item.id)}
          onMarkUnread={() => ctx.onMarkUnread(item.id)}
          onOpenInNewWindow={() => ctx.onOpenInNewWindow(item)}
          onSendToWorkspace={ctx.onSendToWorkspace ? () => ctx.onSendToWorkspace!([item.id]) : undefined}
          hasTransferTargets={canSendToWorkspace}
          onDelete={() => ctx.onDelete(item.id)}
          projects={ctx.projects}
          onSetProjectId={ctx.onSetProjectId ? (pid) => ctx.onSetProjectId!(item.id, pid) : undefined}
        />
      }
      contextMenuContent={ctx.isMultiSelectActive && isInMultiSelect ? <BatchSessionMenu /> : undefined}
      isCompactMode={isCompactMode}
      compactMenu={({ open, onOpenChange }) => (
        <CompactSessionMenu
          open={open}
          onOpenChange={onOpenChange}
          trigger={null}
          title={title}
          item={item}
          hasTransferTargets={canSendToWorkspace}
          onRename={() => ctx.onRenameClick(item.id, title)}
          onArchive={() => ctx.onArchive?.(item.id)}
          onUnarchive={() => ctx.onUnarchive?.(item.id)}
          onMarkUnread={() => ctx.onMarkUnread(item.id)}
          onOpenInNewWindow={() => ctx.onOpenInNewWindow(item)}
          onSendToWorkspace={ctx.onSendToWorkspace ? () => ctx.onSendToWorkspace!([item.id]) : undefined}
          onDelete={() => ctx.onDelete(item.id)}
        />
      )}
      icon={
        <>
          <div className={cn(
            "flex items-center justify-center overflow-hidden gap-1",
            "transition-all duration-200 ease-out",
            (item.isProcessing || hasUnreadMeta(item) || hasPendingPrompt)
              ? "opacity-100 ml-0"
              : "!w-0 opacity-0 -ml-[10px]"
          )}>
            {item.isProcessing && <Spinner className="text-[10px]" />}
            {hasUnreadMeta(item) && (
              <svg className="text-accent h-3.5 w-3.5" viewBox="0 0 25 24" fill="currentColor">
                <g transform="translate(1.748, 0.7832)">
                  <path fillRule="nonzero" d="M10.9952443,22 C8.89638276,22 7.01311428,21.5426195 5.34543882,20.6278586 C4.85718403,21.0547471 4.29283758,21.3901594 3.65239948,21.6340956 C3.01196138,21.8780319 2.3651823,22 1.71206226,22 C1.5028102,22 1.34111543,21.9466389 1.22697795,21.8399168 C1.11284047,21.7331947 1.05735697,21.6016979 1.06052745,21.4454262 C1.06369794,21.2891545 1.13820435,21.1347886 1.28404669,20.9823285 C1.5693904,20.6621622 1.77547197,20.3400901 1.9022914,20.0161123 C2.02911082,19.6921344 2.09252054,19.3090783 2.09252054,18.8669439 C2.09252054,18.4553015 2.02276985,18.0646223 1.88326848,17.6949064 C1.74376711,17.3251906 1.5693904,16.9383229 1.36013835,16.5343035 C1.15088629,16.1302841 0.941634241,15.6748094 0.732382188,15.1678794 C0.523130134,14.6609494 0.348753423,14.0682606 0.209252054,13.3898129 C0.0697506845,12.7113652 0,11.9147609 0,11 C0,9.40679141 0.271076524,7.93936244 0.813229572,6.5977131 C1.35538262,5.25606376 2.11946966,4.09164934 3.1054907,3.10446985 C4.09151175,2.11729037 5.25507998,1.35308385 6.59619542,0.811850312 C7.93731085,0.270616771 9.40366047,0 10.9952443,0 C12.5868281,0 14.0531777,0.270616771 15.3942931,0.811850312 C16.7354086,1.35308385 17.900562,2.11729037 18.8897536,3.10446985 C19.8789451,4.09164934 20.6446174,5.25606376 21.1867704,6.5977131 C21.7289235,7.93936244 22,9.40679141 22,11 C22,12.5932086 21.7289235,14.0606376 21.1867704,15.4022869 C20.6446174,16.7439362 19.8805303,17.9083507 18.8945093,18.8955301 C17.9084883,19.8827096 16.74492,20.6469161 15.4038046,21.1881497 C14.0626891,21.7293832 12.593169,22 10.9952443,22 Z" />
                </g>
              </svg>
            )}
            {hasPendingPrompt && <ShieldAlert className="h-3.5 w-3.5 text-info" />}
          </div>
        </>
      }
      title={ctx.searchQuery ? highlightMatch(title, ctx.searchQuery) : title}
      titleClassName={cn("text-[13px]", item.isAsyncOperationOngoing && "animate-shimmer-text")}
      subtitle={previewText}
      titleSuffix={
        projectName ? (
          <div className="flex items-center gap-1">
            {!ctx.inProjectScope && (
              <span
                className="text-[11px] text-foreground/40 whitespace-nowrap truncate max-w-[120px] opacity-0 group-hover:opacity-100 transition-opacity duration-150"
                style={projectColor ? { color: projectColor } : undefined}
                title={projectName}
              >
                {projectName}
              </span>
            )}
          </div>
        ) : undefined
      }
      titleTrailing={hasMatch ? (
        <span
          className={cn(
            "inline-flex items-center justify-center min-w-[24px] px-1 py-0.5 rounded-[6px] text-[10px] font-medium tabular-nums leading-tight whitespace-nowrap shadow-tinted",
            isSelected
              ? "bg-yellow-300/50 border border-yellow-500 text-yellow-900"
              : "bg-yellow-300/10 border border-yellow-600/20 text-yellow-800"
          )}
          style={{
            '--shadow-color': isSelected ? '234, 179, 8' : '133, 77, 14',
          } as React.CSSProperties}
          title={`Matches found (${nextHotkey} next, ${prevHotkey} prev)`}
        >
          {chatMatchCount}
        </span>
      ) : item.lastMessageAt ? (
        <span className="text-[11px] text-foreground/40 whitespace-nowrap">
          {formatDistanceToNowStrict(new Date(item.lastMessageAt), { locale: shortTimeLocale as Locale, roundingMethod: 'floor' })}
        </span>
      ) : undefined}
    />
    </SessionProjectColorWrapper>
  )
}
