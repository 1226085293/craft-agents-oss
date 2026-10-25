/**
 * Branch asset inheritance.
 *
 * A forked session copies messages, but message payloads reference files by
 * `{{SESSION_PATH}}` — which remaps to the BRANCH directory. Anything the
 * parent stored under that placeholder must be copied, or the branch shows
 * broken images and the agent cannot re-read an externalized tool result.
 *
 * 2026-10-18 audit of a real fork (261018-bold-bonsai ← 261016-true-sparrow):
 *   attachments/       4 pasted images   → thumbnails survived (inline base64),
 *                                          full-size images did not open
 *   long_responses/    1 Bash output     → agent re-read would fail
 *   plans/             1 plan .md        → plan link would fail
 *   tool-metadata.json 155 KB            → tool display names lost
 *
 * `turns/` had the same class of bug (see copyTurnLogsForBranch in turn-log.ts)
 * and is copied separately because relief needs it for compaction.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Directories under a session that hold files referenced by messages. */
export const BRANCH_ASSET_DIRS = ['attachments', 'downloads', 'plans', 'long_responses'] as const

/** Single-file caches that make history render correctly. */
export const BRANCH_ASSET_FILES = ['tool-metadata.json'] as const

/**
 * Refuse to copy an asset tree larger than this. A branch must stay cheap:
 * someone with a 2 GB downloads/ should not pay it twice on every fork.
 */
const MAX_ASSET_TREE_BYTES = 200 * 1024 * 1024

function treeSize(path: string): number {
  let total = 0
  let entries
  try {
    entries = readdirSync(path, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = join(path, entry.name)
    try {
      total += entry.isDirectory() ? treeSize(full) : statSync(full).size
    } catch {
      // Vanished mid-walk (concurrent cleanup) — ignore this entry.
    }
  }
  return total
}

export interface BranchAssetsCopyResult {
  /** Directory names copied (or skipped when over the size cap). */
  copiedDirs: string[]
  /** Single files copied. */
  copiedFiles: string[]
  /** Directories skipped because they exceeded the size cap. */
  skippedDirs: string[]
}

/**
 * Copy the parent session's message-referenced assets into the branch.
 *
 * Idempotent (never overwrites an existing branch file) and best-effort: a
 * failure here must never fail the branch. Synchronous because it runs on the
 * same critical path as the existing turn-log/anchors copies and the payloads
 * are small in the common case.
 */
export function copySessionAssetsForBranch(
  sourceSessionPath: string,
  branchSessionPath: string,
  /** Overridable so tests can exercise the size cap without 200MB fixtures. */
  maxTreeBytes: number = MAX_ASSET_TREE_BYTES,
): BranchAssetsCopyResult {
  const result: BranchAssetsCopyResult = { copiedDirs: [], copiedFiles: [], skippedDirs: [] }

  for (const dir of BRANCH_ASSET_DIRS) {
    const src = join(sourceSessionPath, dir)
    if (!existsSync(src)) continue
    const size = treeSize(src)
    if (size > maxTreeBytes) {
      result.skippedDirs.push(dir)
      continue
    }
    const dest = join(branchSessionPath, dir)
    try {
      mkdirSync(dest, { recursive: true })
      // force:false — an existing branch file wins (idempotent re-runs).
      cpSync(src, dest, { recursive: true, force: false, errorOnExist: false })
      result.copiedDirs.push(dir)
    } catch {
      // Best-effort: skip this directory, keep the branch usable.
    }
  }

  for (const file of BRANCH_ASSET_FILES) {
    const src = join(sourceSessionPath, file)
    if (!existsSync(src)) continue
    const dest = join(branchSessionPath, file)
    if (existsSync(dest)) continue
    try {
      cpSync(src, dest)
      result.copiedFiles.push(file)
    } catch {
      // Best-effort.
    }
  }

  return result
}
