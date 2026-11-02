/**
 * useHydrateBackgroundTasks — restore the composer's task rows from disk.
 *
 * The row state lives in a plain Jotai atom, so a reload (or a session switch)
 * used to drop every row while the work kept running in the background — the
 * rows outlived the UI in the wrong direction. The backend already persists
 * every not-yet-delivered task (`background-tasks.json`), so this reads that
 * list back once per session and seeds the atom.
 *
 * Merging rules:
 * - Only records that are still worth showing are taken: a `delivered` record is
 *   gone by definition, and the store deletes those anyway.
 * - Existing in-memory entries win, because they carry live state (stopping,
 *   fresh progress) that the persisted snapshot cannot know.
 * - `backgrounded -> running` and `orphaned_pending -> stopped` map the store's
 *   delivery-oriented statuses onto the row's lifecycle statuses.
 */

import * as React from 'react'
import { useAtom } from 'jotai'

import { backgroundTasksAtomFamily, type BackgroundTask } from '@/atoms/sessions'

/** Persisted `kind` → the composer row's `type`. */
function rowTypeFor(kind: string): BackgroundTask['type'] {
  switch (kind) {
    case 'subscription':
      return 'subscription'
    case 'bash':
      return 'shell'
    default:
      return 'agent'
  }
}

/**
 * Persisted `status` → the row's lifecycle status.
 *
 * `orphaned_pending` means Craft Agent died before the result was delivered, so
 * the work did not finish: it reads as stopped, and the restart nudge explains
 * why. `*_pending` states are results waiting for delivery, not running work.
 */
function rowStatusFor(status: string): BackgroundTask['status'] {
  switch (status) {
    case 'running':
      return 'running'
    case 'backgrounded':
      return 'running'
    case 'completed_pending':
      return 'completed'
    case 'stopped_pending':
      return 'stopped'
    case 'orphaned_pending':
      return 'stopped'
    case 'completed':
      return 'completed'
    case 'stopped':
      return 'stopped'
    case 'failed':
      return 'failed'
    default:
      return 'running'
  }
}

export function useHydrateBackgroundTasks(sessionId: string | undefined): void {
  // Read+write: a live event may have seeded a row between mount and the IPC
  // reply, and a blind overwrite would erase it.
  const [currentTasks, setTasks] = useAtom(backgroundTasksAtomFamily(sessionId ?? ''))
  const currentRef = React.useRef(currentTasks)
  currentRef.current = currentTasks
  // One hydration per session per mount: re-running would fight live events.
  const hydratedFor = React.useRef<string | null>(null)

  React.useEffect(() => {
    if (!sessionId) return
    if (hydratedFor.current === sessionId) return
    // NOTE: the guard is committed only after a successful write. Setting it
    // before the await let React's double-invoked effect (StrictMode) mark the
    // session as hydrated while the FIRST run's cleanup cancelled its own write,
    // so no rows were ever restored.
    let cancelled = false

    void (async () => {
      try {
        const records = await window.electronAPI.listBackgroundTasks(sessionId)
        console.log('[bg-hydrate] fetched', records.length, 'records for', sessionId)
        if (cancelled || records.length === 0) return
        // Direct set with the records we just read. The previous version merged
        // inside a Jotai updater, but the updater never ran (the atom had no
        // subscribers at hydration time), so restored rows were silently dropped.
        const restored = records.map((record) => {
          const id = record.externalId ?? record.id
          return {
            id,
            type: rowTypeFor(record.kind),
            toolUseId: record.toolUseId ?? id,
            startTime: record.startedAt,
            elapsedSeconds: 0,
            lastSignalAt: record.completedAt ?? record.startedAt,
            intent: record.intent,
            status: rowStatusFor(record.status),
            ...(record.completedAt ? { completedAt: record.completedAt } : {}),
            ...(record.outputFile ? { outputFile: record.outputFile } : {}),
          } satisfies BackgroundTask
        })
        const known = new Set(currentRef.current.flatMap((t) => [t.id, t.toolUseId]))
        const merged = restored.filter((row) => !known.has(row.id))
        console.log('[bg-hydrate] restoring', merged.length, 'of', restored.length, 'rows')
        setTasks([...merged, ...currentRef.current])
        hydratedFor.current = sessionId
        console.log('[bg-hydrate] restored', merged.length, 'rows')
      } catch (err) {
        console.error('[background-tasks] failed to hydrate rows', err)
      }
    })()

    return () => { cancelled = true }
  }, [sessionId, setTasks])
}
