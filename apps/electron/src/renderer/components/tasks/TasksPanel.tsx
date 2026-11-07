/**
 * Task board container.
 *
 * Owns the data (list + selected detail) so both mounts — the navigator list
 * and the content pane — read the same live task set. Kept deliberately thin:
 * presentation lives in `TaskBoardPanel`.
 */

import * as React from 'react'

import { useTasks, useTaskDetail } from '@/hooks/useAgents'
import { useNavigation } from '@/contexts/NavigationContext'
import { TaskBoardPanel, type TaskDetailView, type TaskListItem } from './TaskBoardPanel'
import { TaskDetailPanelView } from './TaskDetailPanelView'
import { resolvePlanJumps, type JournalLine, type PlanJumpTarget } from '@/lib/plan-jump'
import { requestSessionJump } from '@/lib/session-jump'

/** Detail payload from the RPC is `{ task, journal? }`. */
function toDetail(raw: unknown): { detail: TaskDetailView; journal: JournalLine[] } | null {
  if (!raw || typeof raw !== 'object') return null
  const maybe = (raw as { task?: unknown }).task
  if (!maybe || typeof maybe !== 'object') return null
  const lines = (raw as { journal?: unknown }).journal
  const journal = Array.isArray(lines) ? (lines as JournalLine[]) : []
  return { detail: maybe as TaskDetailView, journal }
}

export interface TasksPanelProps {
  workspaceId: string
  selectedTaskId: string | null
  onSelect: (taskId: string) => void
  onCloseDetail: () => void
}

/** Change what starts a task; shared by the list and the detail pane. */
function updateTaskTrigger(workspaceId: string, id: string, trigger: unknown): void {
  void (window.electronAPI as unknown as {
    tasksUpdateTrigger?: (workspaceId: string, id: string, trigger: unknown) => Promise<unknown>
  }).tasksUpdateTrigger?.(workspaceId, id, trigger)
}

/** Navigator (left-2) list. */
export function TasksListPanel({
  workspaceId,
  selectedTaskId,
  onSelect,
  onCloseDetail,
}: TasksPanelProps): React.JSX.Element {
  const { tasks } = useTasks(workspaceId)
  const { navigateToSession } = useNavigation()

  const cancel = (id: string) => {
    void (window.electronAPI as unknown as {
      tasksUpdate?: (workspaceId: string, id: string, status: string) => Promise<unknown>
    }).tasksUpdate?.(workspaceId, id, 'canceled')
  }

  const run = (id: string) => {
    void (window.electronAPI as unknown as {
      tasksRun?: (workspaceId: string, id: string) => Promise<unknown>
    }).tasksRun?.(workspaceId, id)
  }

  /** Pause keeps the task; cancelling ends it. They are different answers. */
  const pause = (id: string) => {
    void (window.electronAPI as unknown as {
      tasksUpdate?: (workspaceId: string, id: string, status: string, options?: unknown) => Promise<unknown>
    }).tasksUpdate?.(workspaceId, id, 'paused', { pauseReason: 'waiting' })
  }

  const remove = (id: string) => {
    void (window.electronAPI as unknown as {
      tasksDelete?: (workspaceId: string, id: string) => Promise<unknown>
    }).tasksDelete?.(workspaceId, id)
  }

  /**
   * Delete several tasks, then drop the selection if it pointed at any of them.
   *
   * The detail pane is keyed by the selected id. Leaving it pointing at a record
   * that no longer exists is what made a deleted task keep rendering in the
   * content column — so closing the selection is part of deleting, and it has to
   * cover the multi-select case where the open task is one of many removed.
   */
  const removeMany = (ids: string[]) => {
    for (const id of ids) remove(id)
    if (selectedTaskId && ids.includes(selectedTaskId)) onCloseDetail()
  }

  return (
    <div className="relative h-full min-h-0">
      <TaskBoardPanel
        tasks={tasks as TaskListItem[]}
        selectedId={selectedTaskId ?? undefined}
        onSelect={onSelect}
        onCloseDetail={onCloseDetail}
        onResume={run}
        onCancel={cancel}
        onRun={run}
        onOpenSession={(sessionId) => navigateToSession(sessionId)}
        onPause={pause}
        onDelete={remove}
        onDeleteMany={removeMany}
        onUpdateTrigger={(id, trigger) => updateTaskTrigger(workspaceId, id, trigger)}
      />
    </div>
  )
}

/** Content (left-3) pane for one selected task. */
export function TaskDetailPanel({
  workspaceId,
  taskId,
}: {
  workspaceId: string
  taskId: string
}): React.JSX.Element {
  const { detail: raw, settled } = useTaskDetail(workspaceId, taskId)
  const parsed = toDetail(raw)
  const detail = parsed?.detail
  const { navigateToSession } = useNavigation()

  if (!detail) {
    // Two very different states used to look identical. Still fetching is a
    // moment; a task that cannot be read is gone — deleted from the navigator,
    // most likely — and the honest thing is to send the user back to "pick one"
    // rather than leave the last-rendered task on screen as if it still existed.
    if (!settled) {
      return <div className="p-4 text-xs text-muted-foreground">读取任务中…</div>
    }
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
        从左侧选一个任务，查看它的交接与验收。
      </div>
    )
  }

  return (
    <div className="h-full min-h-0">
      <TaskDetailPanelView
        detail={detail}
        planJumps={resolvePlanJumps(detail.spec?.plan, parsed?.journal, detail.currentSessionId)}
        onJumpToStep={(target) => {
          if (!target.sessionId) return
          requestSessionJump({ sessionId: target.sessionId, at: target.at })
          navigateToSession(target.sessionId)
        }}
        onOpenSession={(sessionId) => navigateToSession(sessionId)}
        onResume={(id) => {
          void (window.electronAPI as unknown as {
            tasksRun?: (workspaceId: string, id: string) => Promise<unknown>
          }).tasksRun?.(workspaceId, id)
        }}
        onRun={(id) => {
          void (window.electronAPI as unknown as {
            tasksRun?: (workspaceId: string, id: string) => Promise<unknown>
          }).tasksRun?.(workspaceId, id)
        }}
        onUpdateTrigger={(id, trigger) => updateTaskTrigger(workspaceId, id, trigger)}
        onCancel={(id) => {
          void (window.electronAPI as unknown as {
            tasksUpdate?: (workspaceId: string, id: string, status: string) => Promise<unknown>
          }).tasksUpdate?.(workspaceId, id, 'canceled')
        }}
      />
    </div>
  )
}
