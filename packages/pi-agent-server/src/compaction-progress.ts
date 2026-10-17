/**
 * Compaction heartbeat for the main-process turn-idle watchdog.
 *
 * While the Pi SDK runs a threshold/overflow compaction inside the
 * subprocess, the main stream is silent — no SDK events flow for the whole
 * summary call. The PiAgent's turn-idle watchdog (pi-agent.ts
 * `refreshTurnIdleWatchdog`; 300 s plain ceiling as of 2026-10-05, 120 s
 * before that) therefore false-positives "stream stalled" for any compaction
 * that takes longer than the cap (2026-10-04 incident: a 3m40s compaction
 * fired the error mid-"Compacting context...").
 *
 * The server emits a `compaction_progress` outbound event every ~30 s while
 * a compaction is in flight. Two consumers:
 *
 * 1. PiAgent (main process): every heartbeat is a turn-progress event that
 *    keeps the plain watchdog from expiring. The adapter intentionally does
 *    NOT surface ticks as UI status (a 2026-10-05 UI fix): the process block
 *    keeps a single "Compacting context..." row from compaction_start, and
 *    repeated per-tick rows would stack near-identical lines with stale
 *    embedded elapsed times.
 * 2. The heartbeat is BOUNDED — it stops at `getCompactionProgressCapMs()`
 *    (defaults to 15 min, the SAME budget as PiAgent's absolute compaction
 *    cap `DEFAULT_COMPACT_CAP_MS`). Keeping the two in sync is load-
 *    bearing: the main process judges liveness by heartbeat freshness
 *    (120s staleness window). An earlier 5-min heartbeat cap meant a
 *    healthy compaction whose summary generation outran the cap went
 *    SILENT at ~270s while still legitimately running — the staleness
 *    window then false-positived "compact stalled" (2026-10-17
 *    deft-tide: 9 heartbeats to 270s, compaction persisted successfully
 *    ~10 min in, user saw the stall error). Once the cap is reached a
 *    dead compaction still trips the main process's absolute deadline,
 *    so an unbounded timer is still not needed.
 */

export const COMPACTION_PROGRESS_INTERVAL_MS = 30_000;

/**
 * Heartbeat cap — MUST stay >= PiAgent.DEFAULT_COMPACT_CAP_MS (900s) so a
 * healthy long compaction never goes silent while still inside its legal
 * budget. A silent-but-alive compaction reads as "stalled" to the main
 * process's 120s staleness window.
 */
export const DEFAULT_COMPACTION_PROGRESS_CAP_MS = 15 * 60 * 1000;

export interface CompactionProgressEvent {
  type: 'compaction_progress';
  /** Wall-clock ms since the corresponding compaction_start. */
  elapsedMs: number;
}

export interface CompactionProgressHeartbeat {
  /** Begin emitting (restart-safe: a second start() replaces the first). */
  start(): void;
  /** Stop emitting and release the timer. Idempotent. */
  stop(): void;
}

export function getCompactionProgressCapMs(): number {
  const raw = process.env.CRAFT_PI_COMPACTION_IDLE_TIMEOUT_MS;
  if (!raw) return DEFAULT_COMPACTION_PROGRESS_CAP_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_COMPACTION_PROGRESS_CAP_MS;
}

export function createCompactionProgressHeartbeat(options: {
  /** Emits one outbound `compaction_progress` event (server → main process). */
  emit: (event: CompactionProgressEvent) => void;
  /** Heartbeat period. Defaults to COMPACTION_PROGRESS_INTERVAL_MS. */
  intervalMs?: number;
  /** Stop emitting after this much total compaction elapsed.
   *  Defaults to getCompactionProgressCapMs(). */
  capMs?: number;
}): CompactionProgressHeartbeat {
  const intervalMs = options.intervalMs ?? COMPACTION_PROGRESS_INTERVAL_MS;
  const capMs = options.capMs ?? getCompactionProgressCapMs();
  let timer: ReturnType<typeof setInterval> | null = null;
  let startedAt = 0;

  function tick(): void {
    const elapsedMs = Date.now() - startedAt;
    // Bounded: once the cap is reached, stop entirely — a dead compaction
    // must be able to trip the capped watchdog instead of being silenced
    // by heartbeats forever.
    if (elapsedMs >= capMs) {
      stop();
      return;
    }
    options.emit({ type: 'compaction_progress', elapsedMs });
  }

  function stop(): void {
    if (timer != null) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    start(): void {
      stop();
      startedAt = Date.now();
      timer = setInterval(tick, intervalMs);
      (timer as { unref?: () => void }).unref?.();
    },
    stop,
  };
}
