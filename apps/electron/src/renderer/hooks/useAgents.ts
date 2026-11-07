/**
 * Agent + task board data sources.
 *
 * Both follow the `useGatewayStrategies` shape: one fetch on mount, one push
 * subscription for live updates, and a memoised projection. Keeping them here
 * (rather than inline in ChatPage) means the sidebar panel and the composer
 * read the same list.
 */

import * as React from 'react'

import type { AgentOption } from '@/components/app-shell/input/AgentSelector'
import type { TaskListItem } from '@/components/tasks/TaskBoardPanel'

interface AgentsApi {
  agentsList?: (workspaceId: string) => Promise<AgentOption[]>
  onAgentsChanged?: (cb: (payload: { workspaceId: string }) => void) => () => void
}

interface TasksApi {
  tasksList?: (workspaceId: string, status?: string) => Promise<TaskListItem[]>
  tasksGet?: (workspaceId: string, id: string, includeJournal?: boolean) => Promise<unknown>
  tasksUpdate?: (workspaceId: string, id: string, status: string) => Promise<unknown>
  onTasksChanged?: (cb: (payload: { workspaceId: string }) => void) => () => void
}

function agentsApi(): AgentsApi {
  return window.electronAPI as unknown as AgentsApi
}

function tasksApi(): TasksApi {
  return window.electronAPI as unknown as TasksApi
}

export interface AgentsState {
  agents: AgentOption[]
  loading: boolean
  /** Re-read the file after a save/delete (the broadcast covers other windows). */
  reload: () => void
}

/** Role profiles the composer can offer for this workspace. */
export function useAgents(workspaceId: string | undefined): AgentsState {
  const [agents, setAgents] = React.useState<AgentOption[]>([])
  const [loading, setLoading] = React.useState(true)
  const [nonce, setNonce] = React.useState(0)

  React.useEffect(() => {
    if (!workspaceId) {
      setAgents([])
      setLoading(false)
      return
    }
    let cancelled = false

    const load = () => {
      void agentsApi()
        .agentsList?.(workspaceId)
        .then((list) => {
          if (!cancelled) setAgents(list ?? [])
        })
        .catch(() => {
          if (!cancelled) setAgents([])
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }

    load()
    const off = agentsApi().onAgentsChanged?.((payload) => {
      if (!cancelled && payload?.workspaceId === workspaceId) load()
    })

    return () => {
      cancelled = true
      off?.()
    }
  }, [workspaceId, nonce])

  return { agents, loading, reload: () => setNonce((n) => n + 1) }
}

export interface TasksState {
  tasks: TaskListItem[]
  reload: () => void
}

/** Task board list, kept live. */
export function useTasks(workspaceId: string | undefined): TasksState {
  const [tasks, setTasks] = React.useState<TaskListItem[]>([])
  const [nonce, setNonce] = React.useState(0)

  React.useEffect(() => {
    if (!workspaceId) {
      setTasks([])
      return
    }
    let cancelled = false

    const load = () => {
      void tasksApi()
        .tasksList?.(workspaceId)
        .then((list) => {
          if (!cancelled) setTasks(list ?? [])
        })
        .catch(() => {
          if (!cancelled) setTasks([])
        })
    }

    load()
    const off = tasksApi().onTasksChanged?.((payload) => {
      if (!cancelled && payload?.workspaceId === workspaceId) load()
    })

    return () => {
      cancelled = true
      off?.()
    }
  }, [workspaceId, nonce])

  return { tasks, reload: () => setNonce((n) => n + 1) }
}

/** Load one task with its journal (detail pane). */
export function useTaskDetail(workspaceId: string | undefined, id: string | undefined) {
  const [detail, setDetail] = React.useState<unknown>(null)
  const [settled, setSettled] = React.useState(false)

  React.useEffect(() => {
    if (!workspaceId || !id) {
      setDetail(null)
      setSettled(true)
      return
    }
    let cancelled = false
    setSettled(false)

    const load = () => {
      void tasksApi()
        .tasksGet?.(workspaceId, id, true)
        .then((result) => {
          if (cancelled) return
          setDetail(result ?? null)
          setSettled(true)
        })
        .catch(() => {
          if (cancelled) return
          // A rejected get means the record is gone (deleted, or the workspace
          // moved). That is an answer, not a pending state.
          setDetail(null)
          setSettled(true)
        })
    }

    load()
    // The detail pane used to be fetched once and then never again, so a task
    // deleted from the navigator kept rendering its last-known contents. Any
    // change in the workspace re-reads it; the miss becomes a null.
    const off = tasksApi().onTasksChanged?.((payload) => {
      if (!cancelled && payload?.workspaceId === workspaceId) load()
    })

    return () => {
      cancelled = true
      off?.()
    }
  }, [workspaceId, id])

  return { detail, settled }
}
