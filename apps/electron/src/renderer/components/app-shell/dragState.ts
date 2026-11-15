/**
 * Drag state
 *
 * `DataTransfer.getData()` is unreadable during `dragover` (the payload is only
 * exposed on `drop`), so a drop target cannot tell *which* item is hovering over
 * it. That is exactly the information needed to reject invalid targets while the
 * pointer is still moving — "can this folder go inside that one?" — and to let
 * the cursor show the no-drop sign instead of silently accepting the gesture.
 *
 * The drag source records its id here on `dragstart` and clears it on `dragend`.
 */

export interface DragState {
  /** Id of the folder being dragged, if any. */
  folderId: string | null
  /** Id of the session being dragged, if any. */
  sessionId: string | null
  /** Folder the dragged session already lives in (null = unfiled). */
  sessionFolderId: string | null
  /** Project scope of the dragged folder/session (null = All Sessions). */
  projectId: string | null
}

export const dragState: DragState = { folderId: null, sessionId: null, sessionFolderId: null, projectId: null }

/**
 * Drag-and-drop is off.
 *
 * A task's sessions are filed automatically now: the folder is created from the task id and every
 * session it opens lands in it, so nobody is re-filing conversations by hand. What drag-and-drop
 * still offers in that arrangement is the ability to move a row out of the group that explains it —
 * a worker conversation dragged out of 「T-1」 reads as an unrelated session, and the next reader
 * has no way to know which task it belonged to.
 *
 * Turned off at the one place a drag starts rather than at each source and target: `beginFolderDrag`
 * and `beginSessionDrag` are the only two ways `dragState` ever becomes non-null, and every drop
 * handler already reads it to decide whether the gesture is valid. With the state never set, every
 * target refuses without needing to know this flag exists.
 *
 * Re-enabling is a one-line change here; the drag sources and targets are untouched.
 */
export const DRAG_ENABLED = false

export function beginFolderDrag(folderId: string, projectId: string | null): void {
  if (!DRAG_ENABLED) return
  dragState.folderId = folderId
  dragState.sessionId = null
  dragState.sessionFolderId = null
  dragState.projectId = projectId
}

export function beginSessionDrag(sessionId: string, folderId: string | null, projectId: string | null): void {
  if (!DRAG_ENABLED) return
  dragState.sessionId = sessionId
  dragState.folderId = null
  dragState.sessionFolderId = folderId
  dragState.projectId = projectId
}

export function endDrag(): void {
  dragState.folderId = null
  dragState.sessionId = null
  dragState.sessionFolderId = null
  dragState.projectId = null
}

// The source row clears the state on its own `dragend`, but that only runs while
// the row is still mounted: a drop that navigates (or any gesture the browser
// abandons) can leave a stale id behind. Every later drop is then validated
// against the wrong item — e.g. "this session already lives in that folder" —
// and silently does nothing, which reads as "dragging stopped working".
//
// Bubble phase on purpose: drop handlers read `dragState` (cross-scope folder
// moves), so the reset must run after they finish.
if (typeof window !== 'undefined') {
  const reset = () => endDrag()
  window.addEventListener('dragend', reset)
  window.addEventListener('drop', reset)
  window.addEventListener('mouseup', reset)
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') reset()
  })
}
