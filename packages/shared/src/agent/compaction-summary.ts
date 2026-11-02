/**
 * Token accounting for the user-visible compaction line
 *   压缩完成：约 A → B（保留 R，压缩 S）
 *
 * Three emitters produce this row (auto threshold compaction in the Pi event
 * adapter, manual `/compact` in PiAgent, gateway post-switch compaction) and
 * they had drifted apart, so the numbers are now derived in ONE place.
 *
 * Ground truth for B is the SDK's own `estimatedTokensAfter`
 * (`estimateMessagesTokens` over the post-compaction messages — see
 * agent-session.js in @earendil-works/pi-coding-agent). That is exactly what
 * the context ring shows, so the line must use it.
 *
 * `retained` must NOT be the subprocess's measured kept region:
 * `measureKeptRegionTokens` walks backwards and STOPS at the keepRecentTokens
 * floor while the SDK's cut point keeps whole turns, so it under-reports the
 * survivor by a few k tokens. Using it as the arrow target produced
 *   约 453.4k → 20.0k（保留 20.0k，压缩 427.5k）
 * where 20.0k was just the 20k floor, disagreed with the ring (25.9k), and
 * contradicted the row's own arithmetic (453.4 − 427.5 = 25.9).
 * 2026-11-01 session 261101-eager-fountain.
 *
 * Invariant kept by {@link buildCompactionSummaryParams}:
 *   retained + checkpoint + compacted === before
 * (`checkpoint` is the relief/fast-path summary text folded into `after`).
 */

export interface CompactionSummaryInput {
  /** SDK `tokensBefore` — the pre-compaction context size. */
  tokensBefore: number;
  /** SDK `estimatedTokensAfter` — the real post-compaction context size. */
  estimatedTokensAfter?: number;
  /** Subprocess-measured kept region (fallback only, see file header). */
  retained?: number;
  /** Relief checkpoint text tokens (folded into `after`, reported apart). */
  checkpoint?: number;
  /** True when the zero-LLM relief path produced the compaction. */
  viaRelief?: boolean;
}

/** Shape of the `statusParams` consumed by `chat.compactionSummary` i18n. */
export interface CompactionSummaryParams {
  before: number;
  after: number;
  retained: number;
  compacted: number;
  checkpoint: number;
  viaRelief: number;
  /** Assignable to `Record<string, string | number>` (AgentEvent statusParams). */
  [key: string]: number;
}

/**
 * Build the summary row params, or `null` when there is nothing truthful to
 * report (unknown pre-compaction size) — callers then skip the row entirely
 * rather than render `0 → 0`.
 */
export function buildCompactionSummaryParams(
  input: CompactionSummaryInput,
): CompactionSummaryParams | null {
  const before = Math.max(0, Math.round(Number(input.tokensBefore) || 0));
  if (before <= 0) return null;

  const checkpoint = Math.max(0, Math.round(Number(input.checkpoint) || 0));
  const measuredRetained = Math.max(0, Math.round(Number(input.retained) || 0));
  const sdkAfter = Number(input.estimatedTokensAfter);

  // Prefer the SDK's real post-compaction size; fall back to the subprocess
  // estimate (kept region + checkpoint text) when it is unavailable.
  const candidate = Number.isFinite(sdkAfter) && sdkAfter > 0
    ? sdkAfter
    : measuredRetained + checkpoint;
  // A compaction never grows the context; clamping keeps `compacted` >= 0 and
  // the identity below honest even when the SDK estimate overshoots.
  const after = Math.max(0, Math.min(before, Math.round(candidate)));

  return {
    before,
    after,
    // What survived as conversation: `after` minus the checkpoint text, which
    // is reported separately. For the LLM path (checkpoint 0) this is `after`
    // itself — the same choice the auto LLM path has always made.
    retained: Math.max(0, after - checkpoint),
    compacted: Math.max(0, before - after),
    checkpoint,
    viaRelief: input.viaRelief ? 1 : 0,
  };
}
