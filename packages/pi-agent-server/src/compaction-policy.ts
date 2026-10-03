/**
 * Compact-policy helpers shared by the server entry (`index.ts`).
 *
 * Extracted into a standalone module so the policy — wait semantics, the
 * W < R budget invariant, and the "Already compacted" translation — is unit
 * testable without booting the JSONL server. All functions are pure except
 * for the deliberate `log` injection point in {@link waitForCompaction}.
 */

export interface CompactionWaitResult {
  /** True when an in-flight compaction was observed (and then either awaited or hit the wait ceiling). */
  waited: boolean;
  /** True when the wait ceiling elapsed while a compaction was STILL running. */
  timedOut: boolean;
}

export type WaitLogger = (message: string) => void;

/**
 * Wait for an in-flight compaction to finish before the caller proceeds.
 *
 * Returns the outcome instead of silently choosing a policy so each caller
 * can decide: the prompt path ignores the result (its historical behavior is
 * "proceed anyway" after the ceiling), while the manual-compact path treats
 * `timedOut` as an honest hard stop to avoid racing a still-running
 * compaction (blind-proceeding re-opens the SDK race this function exists to
 * prevent). The ceiling itself is caller-supplied so W (wait budget) can be
 * kept strictly below R (RPC budget) — otherwise the RPC timer fires first
 * and this function's honest error can never reach the user.
 */
export async function waitForCompaction(
  session: { isCompacting: boolean },
  timeoutMs: number,
  log: WaitLogger = () => {},
  pollMs = 200,
): Promise<CompactionWaitResult> {
  if (!session.isCompacting) return { waited: false, timedOut: false };
  log('Waiting for in-flight compaction to finish before prompt...');
  const start = Date.now();
  while (session.isCompacting) {
    if (Date.now() - start > timeoutMs) {
      // Final re-check: the compaction may have finished during the last poll
      // gap (≤pollsMs) — never report "still running" right after it finished.
      if (!session.isCompacting) break;
      log(`Compaction wait timed out after ${Math.floor(timeoutMs / 1000)}s, reporting still-running`);
      return { waited: true, timedOut: true };
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  log('Compaction finished, proceeding with prompt');
  return { waited: true, timedOut: false };
}

/**
 * Manual-compact wait budget (W). Must stay strictly below the main-process
 * RPC budget (R, see CRAFT_PI_COMPACT_RPC_TIMEOUT_MS in pi-agent.ts) so the
 * subprocess's honest "still running" verdict always reaches the user before
 * the RPC timer gives up on this request. Default 240s < 300s RPC default.
 * Override with CRAFT_PI_COMPACT_WAIT_TIMEOUT_MS.
 */
export function getCompactWaitTimeoutMs(): number {
  const raw = process.env.CRAFT_PI_COMPACT_WAIT_TIMEOUT_MS;
  if (!raw) return 240_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 240_000;
}

export interface CompactionRecord {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

/**
 * Read the most recent persisted compaction record from a session store's
 * entries array. Used to synthesize a truthful success reply when a manual
 * compact request was completed by the compaction it waited on.
 */
export function findLastCompactionRecord(entries: readonly unknown[]): CompactionRecord | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type?: string; summary?: string; firstKeptEntryId?: string; tokensBefore?: number };
    if (entry?.type === 'compaction' && typeof entry.summary === 'string') {
      return {
        summary: entry.summary,
        firstKeptEntryId: String(entry.firstKeptEntryId ?? ''),
        tokensBefore: Number(entry.tokensBefore ?? 0),
      };
    }
  }
  return null;
}

export type AlreadyCompactedTranslation =
  | { success: true; note: string; result: CompactionRecord }
  | null;

/**
 * Decide whether an "Already compacted" failure after a wait should be
 * reported as success.
 *
 * Translation applies ONLY when the request actually waited on a live
 * compaction (`wait.waited`) — that wait is what proves the preceding
 * compaction was the one completing this request. Requests that arrive after
 * the compaction has finished (`waited=false`) keep the guard error, which is
 * then an honest statement about a stale/duplicate request rather than a
 * lie about work that never happened.
 */
export function translateAlreadyCompacted(
  wait: CompactionWaitResult,
  errorMessage: string | undefined,
  record: CompactionRecord | null,
): AlreadyCompactedTranslation {
  if (errorMessage !== 'Already compacted') return null;
  if (!wait.waited) return null;
  if (!record) return null;
  return {
    success: true,
    note: 'completed by the preceding compaction',
    result: record,
  };
}