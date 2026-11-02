/**
 * BackgroundTaskToolbar — the two composer buttons that surface session-level
 * background status, shared by the desktop and compact layouts.
 *
 * The two buttons sit immediately to the right of the permission-mode selector
 * ("执行"): BackgroundTasksPopover (background work) then ChildSessionsPopover
 * (followed sessions). Both render nothing when their list is empty, and the
 * live output viewer (TaskOutputViewer) is owned here so the click-through
 * works identically in both layouts.
 *
 * Moved out of FreeFormInput so the buttons can live next to the permission
 * mode control — which in the desktop layout is in ActiveOptionBadges (above the
 * composer), while in the compact layout it is inside the composer toolbar row.
 */

import * as React from 'react'
import { useCallback } from 'react'

import { navigate, routes } from '@/lib/navigate'
import type { BackgroundTask } from '@/atoms/sessions'
import { BackgroundTasksPopover } from './BackgroundTasksPopover'
import { ChildSessionsPopover } from './ChildSessionsPopover'
import { TaskOutputViewer } from './TaskOutputViewer'

export interface BackgroundTaskToolbarProps {
  sessionId: string
}

export function BackgroundTaskToolbar({ sessionId }: BackgroundTaskToolbarProps) {
  const [outputTask, setOutputTask] = React.useState<BackgroundTask | null>(null)

  const handleStopTask = useCallback(async (taskId: string) => {
    if (!sessionId) return
    await window.electronAPI.stopBackgroundTask(sessionId, taskId, 'user')
  }, [sessionId])

  const handleShowOutput = useCallback((task: BackgroundTask) => {
    setOutputTask(task)
  }, [])

  const handleOpenChildSession = useCallback((task: BackgroundTask) => {
    navigate(routes.view.allSessions(task.id))
  }, [])

  const handleStopChildSession = useCallback(async (task: BackgroundTask) => {
    if (!sessionId) return
    await window.electronAPI.stopBackgroundTask(sessionId, task.id, 'user')
  }, [sessionId])

  return (
    <>
      <BackgroundTasksPopover
        sessionId={sessionId}
        onStopTask={handleStopTask}
        onShowOutput={handleShowOutput}
      />
      <ChildSessionsPopover
        sessionId={sessionId}
        onOpenSession={handleOpenChildSession}
        onStopSession={handleStopChildSession}
      />
      <TaskOutputViewer task={outputTask} onClose={() => setOutputTask(null)} />
    </>
  )
}
