/**
 * Branch-fork materialization helpers.
 *
 * A Craft branch session copies the parent's transcript, and its Pi backend
 * session is materialized by `SessionManager.forkFrom(parentFile, …)` on the
 * first subprocess spawn. That fork is ONE-SHOT: `forkFrom` copies the parent's
 * session file exactly as it exists at spawn time.
 *
 * Re-forking on every spawn is a cross-session context leak (2026-10-18,
 * sessions 261016-true-sparrow → 261018-vital-moor): each new subprocess
 * re-read the parent's LIVE transcript, so every message the parent received
 * AFTER the branch point showed up inside the branch — the branch then answered
 * the parent's user message — and the branch's own post-branch turns were
 * discarded at the same time.
 *
 * So the fork is gated on "this branch has no Pi session of its own yet".
 * Once `forkFrom` has written a session file into the branch's `.pi-sessions`
 * directory, later spawns resume it via `continueRecent()` instead.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Find the most recent .jsonl session file in a directory. */
export function findMostRecentSessionFile(sessionDir: string): string | null {
  if (!existsSync(sessionDir)) return null;
  let best: { path: string; mtime: number } | null = null;
  for (const entry of readdirSync(sessionDir)) {
    if (!entry.endsWith('.jsonl')) continue;
    const fullPath = join(sessionDir, entry);
    const mtime = statSync(fullPath).mtimeMs;
    if (!best || mtime > best.mtime) {
      best = { path: fullPath, mtime };
    }
  }
  return best?.path ?? null;
}

/**
 * Whether a branch still needs its one-shot fork from the parent.
 *
 * False as soon as the branch owns a Pi session file — including branches
 * created by older builds, whose persisted `branchFromSessionPath` was never
 * retired (they must resume their own session, not re-fork the parent).
 */
export function shouldForkBranch(sessionDir: string): boolean {
  return findMostRecentSessionFile(sessionDir) === null;
}
