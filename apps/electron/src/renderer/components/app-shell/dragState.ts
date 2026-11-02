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

export function beginFolderDrag(folderId: string, projectId: string | null): void {
  dragState.folderId = folderId
  dragState.sessionId = null
  dragState.sessionFolderId = null
  dragState.projectId = projectId
}

export function beginSessionDrag(sessionId: string, folderId: string | null, projectId: string | null): void {
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
