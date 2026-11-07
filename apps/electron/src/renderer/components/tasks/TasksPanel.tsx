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

/** Detail payload from the RPC is `{ task, journal? }`. */
function toDetail(raw: unknown): TaskDetailView | null {
  if (!raw || typeof raw !== 'object') return null
  const maybe = (raw as { task?: unknown }).task
  if (!maybe || typeof maybe !== 'object') return null
  return maybe as TaskDetailView
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
  const raw = useTaskDetail(workspaceId, taskId)
  const detail = toDetail(raw)
  const { navigateToSession } = useNavigation()

  if (!detail) {
    return <div className="p-4 text-xs text-muted-foreground">读取任务中…</div>
  }

  return (
    <div className="h-full min-h-0">
      <TaskDetailPanelView
        detail={detail}
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
