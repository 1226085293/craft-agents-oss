/**
 * Session plan state and path helpers.
 * Shared by the Claude and Pi backends.
 */

import { getSessionPlansPath } from '../sessions/storage.ts';

const sessionPlanFilePaths = new Map<string, string>();

/** Get the last submitted plan file path for a session. */
export function getLastPlanFilePath(sessionId: string): string | null {
  return sessionPlanFilePaths.get(sessionId) ?? null;
}

/** Set the last submitted plan file path for a session. */
export function setLastPlanFilePath(sessionId: string, path: string): void {
  sessionPlanFilePaths.set(sessionId, path);
}

/** Clear plan file state for a session. */
export function clearPlanFileState(sessionId: string): void {
  sessionPlanFilePaths.delete(sessionId);
}

/** Get the plans directory for a session. */
export function getSessionPlansDir(workspacePath: string, sessionId: string): string {
  return getSessionPlansPath(workspacePath, sessionId);
}

/** Check if a path is within a session's plans directory. */
export function isPathInPlansDir(path: string, workspacePath: string, sessionId: string): boolean {
  return path.startsWith(getSessionPlansDir(workspacePath, sessionId));
}
