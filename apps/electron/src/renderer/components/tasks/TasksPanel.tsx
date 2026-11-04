/**
 * Task board container.
 *
 * Owns the data (list + selected detail) so both mounts — the navigator list
 * and the content pane — read the same live task set. Kept deliberately thin:
 * presentation lives in `TaskBoardPanel`.
 */

import * as React from 'react'

import { useTasks, useTaskDetail } from '@/hooks/useAgents'
import { TaskBoardPanel, type TaskDetailView, type TaskListItem } from './TaskBoardPanel'

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

/** Navigator (left-2) list. */
export function TasksListPanel({
  workspaceId,
  selectedTaskId,
  onSelect,
  onCloseDetail,
}: TasksPanelProps): React.JSX.Element {
  const { tasks } = useTasks(workspaceId)

  const resume = (id: string) => {
    void (window.electronAPI as unknown as {
      tasksUpdate?: (workspaceId: string, id: string, status: string) => Promise<unknown>
    }).tasksUpdate?.(workspaceId, id, 'running')
  }

  const cancel = (id: string) => {
    void (window.electronAPI as unknown as {
      tasksUpdate?: (workspaceId: string, id: string, status: string) => Promise<unknown>
    }).tasksUpdate?.(workspaceId, id, 'canceled')
  }

  return (
    <div className="relative h-full min-h-0">
      <TaskBoardPanel
        tasks={tasks as TaskListItem[]}
        selectedId={selectedTaskId ?? undefined}
        onSelect={onSelect}
        onCloseDetail={onCloseDetail}
        onResume={resume}
        onCancel={cancel}
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

  if (!detail) {
    return <div className="p-4 text-xs text-muted-foreground">读取任务中…</div>
  }

  // Reuse the board's detail rendering by handing it a single-item list and no
  // selection: the panel shows the detail overlay as its only content.
  return (
    <div className="relative h-full min-h-0">
      <TaskBoardPanel
        tasks={[
          {
            id: detail.id,
            name: detail.name,
            status: detail.status,
            priority: 0,
            updatedAt: detail.updatedAt,
            sessionCount: detail.sessionIds.length,
            pauseReason: detail.pauseReason,
          },
        ]}
        selectedId={detail.id}
        detail={detail}
        onSelect={() => undefined}
        onCloseDetail={() => undefined}
        onResume={(id) => {
          void (window.electronAPI as unknown as {
            tasksUpdate?: (workspaceId: string, id: string, status: string) => Promise<unknown>
          }).tasksUpdate?.(workspaceId, id, 'running')
        }}
        onCancel={(id) => {
          void (window.electronAPI as unknown as {
            tasksUpdate?: (workspaceId: string, id: string, status: string) => Promise<unknown>
          }).tasksUpdate?.(workspaceId, id, 'canceled')
        }}
      />
    </div>
  )
}
