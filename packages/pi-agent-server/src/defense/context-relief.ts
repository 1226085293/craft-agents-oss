/**
 * Context Relief — no-LLM compaction via turn-log files.
 *
 * One compaction path for BOTH triggers (manual /compact and automatic
 * threshold/overflow), in three steps — the order is user-confirmed and must
 * not be shuffled:
 *
 *   1. RELIEF (this module): intercept `session_before_compact` and supply
 *      the compaction result ourselves — NO LLM call. The checkpoint lists
 *      each archived turn's user message, its final conclusion, and a
 *      pointer to the full turn file on disk. The SDK treats it exactly like
 *      a normal compaction: entries before `firstKeptEntryId` are replaced
 *      by this text and the agent continues immediately.
 *   2. THRESHOLD CHECK: estimate the post-relief context (tokensBefore -
 *      discarded + checkpoint tokens). When it still exceeds the ceiling —
 *      10% of the CURRENT model's context window, resolved per event — the
 *      hook returns undefined.
 *   3. LLM COMPACTION (fallback): the SDK's own summarization runs instead.
 *      Guarantees relief never leaves the session stuck above the ceiling.
 *
 * The full per-turn record (user message, guidance, process blocks with full
 * results, assistant bubbles) lives in sessions/{id}/turns/*.md written by
 * the turn-log archiver; this module only reads those files.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  estimateTokens as sdkEstimateTokens,
  sessionEntryToContextMessages as sdkSessionEntryToContextMessages,
} from '@earendil-works/pi-coding-agent';
import type {
  ExtensionAPI,
  InlineExtension,
  SessionBeforeCompactEvent,
} from '@earendil-works/pi-coding-agent';

export interface ContextReliefDeps {
  /** Craft session dir — turn logs live in {sessionPath}/turns/. */
  sessionPath?: string;
  debugLog?: (msg: string) => void;
  /**
   * Post-relief context estimate ceiling as an ABSOLUTE token count. Used
   * only when `contextWindow` cannot be resolved. Prefer providing
   * `contextWindow` — the default policy is 10% of it.
   */
  reliefMaxTokens?: number;
  /**
   * Active model's context window, resolved PER EVENT — the model can change
   * mid-session, so this must never be captured once at registration.
   */
  contextWindow?: () => number;
  /**
   * Stash for the retained-region measurement taken during
   * `session_before_compact`, so the result path (which runs AFTER the SDK
   * decides who produced the summary) can attach the real number to BOTH the
   * relief and the LLM compaction.
   *
   * Keyed by nothing — there is at most one compaction in flight (the SDK
   * serializes them, and our manual gate skips concurrent requests).
   */
  lastRetainedMeasurement?: { retained: number; keepRecentTokens: number; measuredAt: number };
}

/** Fallback ceiling when neither reliefMaxTokens nor contextWindow resolves. */
export const DEFAULT_RELIEF_MAX_TOKENS = 50_000;

/**
 * Post-relief context budget = 10% of the CURRENT model's context window.
 * Ratio-based instead of a fixed number: a 1M-window model tolerates ~100k of
 * residual context while a 200k one only ~20k — a fixed 50k is wrong for both.
 */
export const RELIEF_CONTEXT_RATIO = 0.1;

/** Per-turn budget inside the relief summary (chars). */
const USER_MSG_MAX_CHARS = 200;
const CONCLUSION_MAX_CHARS = 300;
/** Total relief summary budget (chars) — keeps the checkpoint cheap. */
const SUMMARY_MAX_CHARS = 8_000;

export interface TurnFileRef {
  /** Absolute path to the turn markdown file. */
  path: string;
  /** File name only (for the pointer line). */
  fileName: string;
}

function debug(deps: ContextReliefDeps, msg: string): void {
  try { deps.debugLog?.(`[context-relief] ${msg}`); } catch { /* best-effort */ }
}

/** List archived turn files, oldest first. Returns [] when the dir is absent. */
export function listTurnFiles(sessionPath: string | undefined): TurnFileRef[] {
  if (!sessionPath) return [];
  const dir = join(sessionPath, 'turns');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => ({ path: join(dir, f), fileName: f }));
  } catch {
    return [];
  }
}

/** Extract a `## Heading` section body (up to the next `## ` heading). */
function extractSection(md: string, heading: string): string {
  const startIdx = md.indexOf(`\n## ${heading}`);
  if (startIdx < 0) return '';
  const bodyStart = md.indexOf('\n', startIdx + 1);
  if (bodyStart < 0) return '';
  const bodyEnd = md.indexOf('\n## ', bodyStart + 1);
  return md.slice(bodyStart, bodyEnd < 0 ? md.length : bodyEnd).trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/**
 * Build the no-LLM checkpoint from archived turn files. Pure.
 *
 * For each turn: heading (number + local time), user message, conclusion (if
 * any), and a pointer to the turn file. The pointer is what lets the resumed
 * agent re-read process blocks and full results with the Read tool.
 */
export function buildReliefSummary(turns: TurnFileRef[], budgetChars = SUMMARY_MAX_CHARS): string {
  const lines: string[] = [
    '[Context relief checkpoint — turns below were archived to disk, NOT summarized by an LLM. For details on any turn (process blocks, full tool results, guidance), read the turn file with the Read tool.]',
    '',
  ];
  let used = lines.join('\n').length;
  for (const turn of turns) {
    let md = '';
    try {
      md = readFileSync(turn.path, 'utf-8');
    } catch {
      continue; // unreadable file — skip rather than fail the relief
    }
    const headerMatch = md.match(/^# (Turn \d+ — .+)$/m);
    const header = headerMatch ? headerMatch[1] : turn.fileName;
    const userMsg = truncate(extractSection(md, 'User message'), USER_MSG_MAX_CHARS);
    const conclusion = truncate(extractSection(md, 'Conclusion'), CONCLUSION_MAX_CHARS);
    // The Details line is the non-negotiable part: even a turn whose text
    // cannot fit the budget MUST leave a pointer, otherwise a small budget
    // (e.g. 10% of a tiny window) could drop every entry and produce an
    // empty checkpoint.
    const pointer = `Details: ${turn.path}`;
    const overhead = `## ${header}`.length + pointer.length + 2;
    if (used + overhead > budgetChars) break;
    let block = `## ${header}`;
    if (userMsg && used + overhead + userMsg.length + 7 <= budgetChars) {
      block += `\nUser: ${userMsg}`;
    }
    if (conclusion && used + overhead + conclusion.length + 9 <= budgetChars) {
      block += `\nOutcome: ${conclusion}`;
    }
    block += `\n${pointer}`;
    lines.push(block, '');
    used += block.length + 2;
  }
  return lines.join('\n').trimEnd();
}

/** Rough token estimate: 4 chars per token (matches SDK's rough math). */
export function estimateCharsTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/**
 * Post-relief context estimate. `messagesToSummarize` will be discarded and
 * replaced by the summary, so: tokensBefore - tokensDiscarded + summaryTokens.
 */
/**
 * Estimate the post-relief context size.
 *
 * Kept region = the SDK's keepRecent floor + the checkpoint text. The
 * discarded region is NOT re-estimated from `messagesToSummarize`: a single
 * large tool result stringifies into a multi-megabyte blob whose ÷4 token
 * count is meaningless (it made the 2026-10-18 threshold check and UI line
 * both wildly wrong). Since relief replaces everything before the cut point
 * with the checkpoint, `before - kept` is the honest discarded figure.
 */
export function estimatePostReliefTokens(
  tokensBefore: number,
  summaryText: string,
  keepRecentTokens: number,
): number {
  const before = Math.max(0, tokensBefore);
  const kept = Math.max(0, Math.min(before, Math.round(keepRecentTokens)));
  return kept + estimateCharsTokens(summaryText.length);
}

/** True when the hook should fall through to the SDK's LLM compaction. */
export function shouldFallThroughToLlm(postReliefTokens: number, reliefMaxTokens: number): boolean {
  return postReliefTokens > reliefMaxTokens;
}

/**
 * Token accounting for the compaction-summary UI line
 * ("压缩完成：约 A → B（保留 R，压缩 S）").
 *
 * Semantics (user-verified 2026-10-18):
 *   before      real upstream usage (matches the UI ring)
 *   after       real post-compaction context (SDK's estimatedTokensAfter)
 *   retained    what the SDK KEEPS, in turn units — the keepRecent region the
 *               cut point landed on (always >= the keepRecentTokens floor)
 *   compacted   before - after (the tokens actually eliminated)
 *   checkpoint  tokens the generated checkpoint text itself adds back
 *
 * The identity the line must satisfy:
 *   before ≈ retained + compacted
 * which holds because the discarded region is `before` minus everything the
 * SDK keeps.
 *
 * ⚠️ NEVER estimate the discarded region from
 * `JSON.stringify(messagesToSummarize)` — a single large tool result
 * stringifies into a multi-megabyte blob whose ÷4 count is meaningless. That
 * bug produced the 2026-10-18 line
 *   "约403.6k→0.6k (保留0.0k, 压缩403.6k)"
 * where `retained` pinned to 0 and `after` collapsed to the checkpoint alone,
 * while the UI ring showed 50k. All four numbers must come from real values.
 */
export interface ReliefStats {
  before: number;
  retained: number;
  compacted: number;
  checkpoint: number;
  /** True when this compaction was produced by relief (false = LLM path). */
  viaRelief: boolean;
}

export function computeReliefStats(
  tokensBefore: number,
  messagesToSummarize: unknown[],
  summaryText: string,
  viaRelief: boolean,
  tokensAfter: number,
  /** Session entries from the event — used to measure the kept region for real. */
  branchEntries: unknown[] | undefined,
  /** The SDK's keepRecentTokens floor. */
  keepRecentTokens: number,
): ReliefStats {
  const before = Math.max(0, Math.round(tokensBefore));
  const after = Number.isFinite(tokensAfter) ? Math.max(0, Math.round(tokensAfter)) : before;
  const compacted = Math.max(0, before - after);
  const checkpoint = estimateCharsTokens(summaryText.length);

  // Retained = the kept region measured with the SDK's own accumulation
  // algorithm over the real branch entries. Falls back to the floor when the
  // entries are unavailable (defensive — the line must still render).
  let retained = Math.max(0, Math.min(after, Math.round(keepRecentTokens)));
  if (Array.isArray(branchEntries) && branchEntries.length > 0) {
    const measured = measureKeptRegionTokens(branchEntries, keepRecentTokens);
    if (measured > 0) retained = measured;
  }
  // Sanity: retained cannot exceed the context that actually survived.
  retained = Math.min(retained, after);

  void messagesToSummarize;
  return { before, retained, compacted, checkpoint, viaRelief };
}

/**
 * Walk the branch backwards accumulating estimated per-entry tokens until the
 * keepRecent floor is reached, mirroring the SDK's findCutPoint() so the number
 * on the summary line means the same thing the cut point actually kept.
 *
 * Uses the SDK's own entry->message and token estimators so the two can never
 * drift (they are exported from the package root and verified at import time).
 *
 * Exported so the result path can re-measure for the SDK's LLM compaction
 * (whose `details` has no stats slot).
 */
export function measureKeptRegionTokens(
  entries: readonly unknown[] | undefined,
  keepRecentTokens: number,
): number {
  if (!Array.isArray(entries) || entries.length === 0) return 0;
  let accumulated = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as Parameters<typeof sdkSessionEntryToContextMessages>[0];
    if (!entry || typeof entry !== 'object') continue;
    // Compaction entries are boundaries, not context content.
    if ((entry as { type?: string }).type === 'compaction') break;
    for (const message of sdkSessionEntryToContextMessages(entry)) {
      accumulated += sdkEstimateTokens(message);
    }
    if (accumulated >= keepRecentTokens) break;
  }
  return Math.round(accumulated);
}

/** Marker text every relief checkpoint starts with. */
const RELIEF_MARKER = '[Context relief checkpoint';

/**
 * Is there anything left worth relieving? After a relief pass, the oldest
 * entries ARE relief checkpoints. Compacting checkpoints into a new
 * checkpoint is a no-op, so hand those cases to the LLM path (which can at
 * least consolidate them into prose). Returns true when checkpoints make up
 * more than half of the character weight of the messages being summarized.
 */
export function isTrivialToSummarize(messages: unknown[]): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  let total = 0;
  let checkpoint = 0;
  for (const m of messages) {
    const chars = JSON.stringify(m ?? null).length;
    total += chars;
    if (typeof m === 'string' && m.includes(RELIEF_MARKER)) checkpoint += chars;
    else if (m && typeof m === 'object') {
      const text = JSON.stringify(m);
      if (text.includes(RELIEF_MARKER)) checkpoint += chars;
    }
  }
  if (total === 0) return false;
  return checkpoint * 2 > total;
}

/**
 * Resolve the post-relief ceiling for ONE event. The model's context
 * window is read per call because it can change mid-session (hot model
 * switch). Order: explicit reliefMaxTokens > 10% of live contextWindow >
 * CRAFT_RELIEF_MAX_TOKENS env > DEFAULT_RELIEF_MAX_TOKENS.
 */
export function resolveReliefMaxTokens(deps: ContextReliefDeps): number {
  if (deps.reliefMaxTokens != null && deps.reliefMaxTokens > 0) return deps.reliefMaxTokens;
  let window = 0;
  try {
    window = deps.contextWindow?.() ?? 0;
  } catch {
    window = 0;
  }
  if (window > 0) return Math.floor(window * RELIEF_CONTEXT_RATIO);
  const env = Number(process.env.CRAFT_RELIEF_MAX_TOKENS);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_RELIEF_MAX_TOKENS;
}

/**
 * Build the relief handler for a `session_before_compact` event. Pure-ish:
 * only reads turn files from disk. Any failure returns undefined so the SDK's
 * LLM compaction takes over (fail-open to the safe path).
 *
 * SAME PATH FOR MANUAL AND AUTO compaction (user-confirmed): relief first,
 * then the threshold check, then the LLM fallback. Manual /compact therefore
 * also gets the instant turn-file checkpoint; the LLM summary only runs when
 * the post-relief context still exceeds the ceiling.
 *
 * REPEATED COMPACTION (user-confirmed): once the content to be summarized is
 * mostly relief checkpoints, SKIP relief-first and return `undefined` (no
 * `compaction` key) so the SDK's own LLM path runs end to end.
 *
 * ⚠️ NEVER return a `compaction` object WITHOUT a `summary` string.
 *
 * Root cause of the `/compact` hard failure
 * `undefined is not an object (evaluating 'message.summary.length')`
 * (2026-10-18, session 261016-true-sparrow): the SDK's `compact()` branch is
 *
 *     if (result?.compaction) {           // agent-session.js
 *         extensionCompaction = result.compaction;
 *         summary = extensionCompaction.summary;   // ← undefined
 *     } else {
 *         summary = await this._runDefaultCompaction(...);   // LLM path
 *     }
 *     ...
 *     sessionManager.appendCompaction(summary, ...);   // ← writes the entry
 *
 * The branch tests the OBJECT, not `summary`. A summary-less compaction object
 * is therefore truthy, skips the LLM path, and persists a compaction entry
 * with NO `summary` field. That entry then poisons the session FOREVER: the
 * next compaction re-enters `findCutPoint()` → `estimateTokens()` →
 *
 *     case 'compactionSummary': chars = message.summary.length   // 💥
 *
 * which throws on every subsequent /compact until the entry is hand-edited.
 *
 * Returning `cancel` instead would surface "Compaction cancelled" as a
 * user-visible failure, and a summary-less `compaction` object is strictly
 * worse than either — always prefer `undefined` (LLM path) here. Losing our
 * `reliefStats` on that path is acceptable: PiAgent synthesizes the same
 * token-accounting row from `tokensBefore`/`estimatedTokensAfter`
 * (pi-agent.ts, `stats ?? { before, retained, compacted, viaRelief: false }`).
 */
export function handleSessionBeforeCompact(
  event: SessionBeforeCompactEvent,
  deps: ContextReliefDeps,
): { compaction?: { summary?: string; firstKeptEntryId: string; tokensBefore: number; details?: unknown }; cancel?: boolean } | undefined {
  const turns = listTurnFiles(deps.sessionPath);
  if (turns.length === 0) return undefined;

  const summary = buildReliefSummary(turns);
  if (!summary) return undefined;

  // Nothing meaningful left to relieve: the messages to be summarized are
  // (mostly) our own relief checkpoints — re-rendering the same index is a
  // no-op. Skip relief-first; the SDK's LLM compaction runs instead (we
  // return undefined below rather than a summary-less compaction object).
  const trivial = isTrivialToSummarize(event.preparation.messagesToSummarize);
  if (trivial) {
    debug(deps, 'remaining context is mostly relief checkpoints — skipping relief-first, handing to the LLM path');
  }

  const maxTokens = resolveReliefMaxTokens(deps);
  const keepRecentTokens = Math.max(
    0,
    Math.round(event.preparation.settings?.keepRecentTokens ?? 0),
  );
  // Measure the kept region HERE, on both paths. `branchEntries` is available
  // before the SDK runs, so the LLM path can report the same real `retained`
  // the relief path does instead of guessing from a floor.
  const measuredRetained = measureKeptRegionTokens(event.branchEntries, keepRecentTokens);
  if (deps.lastRetainedMeasurement) {
    deps.lastRetainedMeasurement.retained = measuredRetained;
    deps.lastRetainedMeasurement.keepRecentTokens = keepRecentTokens;
    deps.lastRetainedMeasurement.measuredAt = Date.now();
  }
  const postRelief = estimatePostReliefTokens(
    event.preparation.tokensBefore,
    summary,
    keepRecentTokens,
  );

  // THRESHOLD CHECK — the single gate every compaction runs through. Over the
  // ceiling (or when there is nothing left to relieve) we return undefined so
  // the SDK's own LLM summarization runs instead.
  const useRelief = !trivial && !shouldFallThroughToLlm(postRelief, maxTokens);
  if (!useRelief) {
    debug(deps, trivial
      ? 'relief skipped (all checkpoints) — LLM path runs'
      : `post-relief estimate ${postRelief} > ${maxTokens} — LLM path runs`);
  } else {
    debug(deps, `relief compaction: ${turns.length} turn file(s), post-relief ~${postRelief} tokens (keepRecent ${keepRecentTokens})`);
  }

  // Relief path: WE supply the summary (no LLM call).
  if (useRelief) {
    // Relief replaces everything before the cut point with the checkpoint, so
    // the post-compaction context is the kept region plus the checkpoint text.
    // This is exactly what the SDK will report as estimatedTokensAfter, and it
    // keeps `before - after` an honest "compacted" figure instead of the old
    // stringify-derived guess.
    const tokensAfter = postRelief;
    const stats = computeReliefStats(
      event.preparation.tokensBefore,
      event.preparation.messagesToSummarize,
      summary,
      true,
      tokensAfter,
      event.branchEntries,
      keepRecentTokens,
    );
    return {
      compaction: {
        summary,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details: { relief: true, turnFiles: turns.map((t) => t.path), reliefStats: stats },
      },
    };
  }

  // LLM path: return NO compaction object at all. See the warning above —
  // a summary-less object is truthy for the SDK, skips its LLM summarizer,
  // and persists a summary-less compaction entry that bricks every future
  // /compact in this session.
  //
  // `stats` is intentionally dropped: the SDK's own compaction produces
  // `details = { readFiles, modifiedFiles }` and has no slot for it, but
  // PiAgent re-synthesizes the token row from before/after counts.
  debug(deps, 'handing off to the SDK LLM compaction (no compaction object returned)');
  return undefined;
}

/** InlineExtension factory for the Pi SDK resource loader. */
export function createContextReliefExtension(deps: ContextReliefDeps): InlineExtension {
  return {
    name: 'craft-context-relief',
    hidden: true,
    factory: (api: ExtensionAPI) => {
      const handler = (event: SessionBeforeCompactEvent) => {
        try {
          return handleSessionBeforeCompact(event, deps);
        } catch (err) {
          debug(deps, `handler failed: ${err instanceof Error ? err.message : String(err)}`);
          return undefined;
        }
      };
      api.on('session_before_compact', handler as unknown as never);
    },
  };
}
