/**
 * FS-Watch — Filesystem-fact based write detection
 *
 * Replaces command-text regex classification for the "did a write happen"
 * question. Regex blacklists (rm|cp|git push|...) can never be complete:
 * any scripting interpreter (python3/node/perl), third-party CLI, or
 * heredoc can mutate files without matching the pattern.
 *
 * Instead of guessing intent from command text, we observe facts: snapshot
 * candidate files at turn start and compare mtimes at evaluation time.
 * Any mutation method leaves an mtime trace — language-agnostic,
 * tool-agnostic.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Directories never worth watching (huge / irrelevant / session-internal). */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', '.next', '.cache',
  '.venv', 'venv', '__pycache__', '.turbo', 'coverage',
]);

/**
 * Top-level directories (relative to cwd) owned by the Craft Agent framework.
 * These are written by the host on every turn (session transcripts, logs,
 * tool metadata) and would otherwise poison write evidence with constant
 * false positives. Only exact top-level matches are skipped — a `data` or
 * `sessions` dir deeper in a user's project is still watched.
 */
const FRAMEWORK_TOP_LEVEL = new Set([
  'sessions', '.pi-sessions', 'data', 'labels', 'tasks', 'statuses',
  '.claude-plugin',
]);

/** File names that are always runtime state, never user-work artifacts. */
const NOISE_FILES = new Set([
  '.DS_Store', 'tool-metadata.json',
  'events.jsonl',   // framework event stream — appended every turn
  'config.json',    // framework workspace config
  'theme.json',     // framework theme
]);

/** Max files scanned per turn — safety valve for huge workspaces. */
const MAX_SCAN = 20_000;

export interface FsWriteEvidence {
  /** Files whose mtime is newer than the turn-start marker. */
  modifiedFiles: string[];
  /** Whether the scan hit the cap (evidence may be incomplete). */
  truncated: boolean;
}

export class FsWatch {
  private turnStartMs = 0;
  private readonly skipDirs: Set<string>;

  constructor(skipDirs: Set<string> = SKIP_DIRS) {
    this.skipDirs = skipDirs;
  }

  /** Anchor the turn-start timestamp. Call when a new prompt begins. */
  markTurnStart(): void {
    this.turnStartMs = Date.now();
  }

  /**
   * Detect files modified since the last markTurnStart().
   * Returns null evidence when no anchor was set (feature inactive).
   */
  detectWrites(cwd: string): FsWriteEvidence | null {
    if (!this.turnStartMs) return null;
    const modified: string[] = [];
    let visited = 0;
    let truncated = false;

    const walk = (dir: string): void => {
      if (truncated || visited > MAX_SCAN) {
        truncated = true;
        return;
      }
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // unreadable dir — not our business
      }
      for (const entry of entries) {
        if (visited > MAX_SCAN) {
          truncated = true;
          return;
        }
        visited += 1;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          const rel = relative(cwd, full);
          const isTopLevel = !rel.includes('/');
          // Framework dirs are only skipped at cwd top level; deeper dirs
          // with the same name belong to user work and stay watched.
          if (
            this.skipDirs.has(entry.name) ||
            (isTopLevel && FRAMEWORK_TOP_LEVEL.has(entry.name))
          ) {
            continue;
          }
          walk(full);
          continue;
        }
        if (NOISE_FILES.has(entry.name) || entry.name.endsWith('.log') || entry.name.endsWith('.pid')) continue;
        try {
          const st = statSync(full);
          if (st.mtimeMs > this.turnStartMs) {
            modified.push(relative(cwd, full));
          }
        } catch {
          // raced deletion — ignore
        }
      }
    };

    walk(cwd);
    return { modifiedFiles: modified, truncated };
  }
}
