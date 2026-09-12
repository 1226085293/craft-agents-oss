/**
 * Forced compaction for `stopReason="length"` with zero output tokens.
 *
 * Incident (2026-08-28): a session ran on a custom-endpoint model whose real
 * upstream limits were tighter than the configured contextWindow. At ~112K
 * context — below the SDK's `shouldCompact2` threshold (114688 for a 131072
 * window) — the model repeatedly returned `stopReason="length"` with
 * `usage.output === 0`: it burned its entire output budget on hidden reasoning
 * and produced no visible reply. Auto-resume (defense followUp) kept the same
 * ~112K context, so every resume re-truncated and the guardrail eventually
 * FAILED the turn. Manual "continue" worked only because it eventually pushed
 * context past the SDK threshold → compaction → model recovered.
 *
 * Fix: `length` + `output === 0` is itself a signal the model cannot produce a
 * visible reply at the current context — regardless of how close it is to the
 * threshold (misconfiguration: configured window > real upstream window). Force
 * a compaction even when the SDK's threshold check says no.
 *
 * Guard rails (prevent infinite compaction loops):
 *  - Skip tiny contexts (a fresh few-thousand-token session hitting
 *    length+output=0 is a different failure; compacting a tiny context is a
 *    no-op that would burn a model call per turn).
 *  - Skip when context has NOT actually shrunk since the last forced
 *    compaction (absolute delta below tolerance) — the compaction was
 *    ineffective (model is broken / nothing to compact), so stop forcing and
 *    let the normal defense + guardrail path take over.
 *
 * Channel budget lane (2026-09-13 lively-forest):
 *  - A model's declared `contextWindow` and the largest request its CHANNEL
 *    actually accepts are two different numbers. Groq's free tier declares
 *    openai/gpt-oss-120b with a 131072 window but rejects any request over
 *    8000 tokens ("Request too large ... Limit 8000, Requested 61426"). The
 *    SDK only compacts at ~87.5% of the declared window (114688), so a session
 *    dies at 8K and never compacts — 14x below the only threshold that exists.
 *  - `contextTokenBudget` states the channel's real ceiling. When context
 *    approaches it, compaction is forced regardless of stopReason, so the
 *    session degrades gracefully instead of walling into a hard 413.
 */

import type { AgentSession } from '@earendil-works/pi-coding-agent';

/** Below this context size, a length+output=0 stop is not a context problem. */
export const FORCED_COMPACTION_MIN_TOKENS = 8_000;

/**
 * If the context size has changed by less than this since the last forced
 * compaction, treat the compaction as ineffective and stop forcing. The SDK's
 * own compaction shrinks context dramatically (e.g. 131K → 35K), so an
 * effective compaction always produces an absolute delta well above this.
 */
export const FORCED_COMPACTION_MIN_REDUCTION = 4_000;

/**
 * Fraction of `contextTokenBudget` at which compaction is forced. Compact
 * before the wall, not on it — rounding and tokenizer drift mean a request
 * that measures at 100% of the budget on our side can cost more upstream.
 */
export const BUDGET_COMPACTION_RATIO = 0.9;

export interface LengthZeroOutputUsage {
  output?: number;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

export interface LengthZeroOutputMessage {
  stopReason?: string;
  usage?: LengthZeroOutputUsage;
}

/** Best-effort total context tokens from a message usage object. */
export function contextTokens(msg: LengthZeroOutputMessage): number {
  const u = msg.usage;
  if (!u) return 0;
  if (typeof u.totalTokens === 'number' && u.totalTokens > 0) return u.totalTokens;
  return (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
}

/**
 * Pure decision: should we FORCE a compaction for this terminal assistant
 * message, even though the SDK's own `shouldCompact` returned false?
 *
 * @param msg                   The terminal assistant message.
 * @param lastForcedTotalTokens Context size at the last forced compaction
 *                              (0 if none yet).
 */
export function shouldForceCompaction(
  msg: LengthZeroOutputMessage,
  lastForcedTotalTokens: number,
): boolean {
  if (!msg || msg.stopReason !== 'length') return false;
  if (!msg.usage || msg.usage.output !== 0) return false;
  const total = contextTokens(msg);
  if (total < FORCED_COMPACTION_MIN_TOKENS) return false;
  if (lastForcedTotalTokens > 0 && Math.abs(total - lastForcedTotalTokens) < FORCED_COMPACTION_MIN_REDUCTION) {
    return false;
  }
  return true;
}

/**
 * Pure decision: has the context grown into the channel's real ceiling?
 *
 * Unlike {@link shouldForceCompaction} this does not look at stopReason — the
 * point is to compact BEFORE the request is rejected, on any stop.
 *
 * @param total                        Current context size in tokens.
 * @param budget                       Channel ceiling (0 = unknown/disabled).
 * @param lastBudgetCompactionTotal    Context size at the previous
 *                                     budget-driven compaction (0 if none).
 */
export function shouldCompactForBudget(
  total: number,
  budget: number,
  lastBudgetCompactionTotal: number,
): boolean {
  if (budget <= 0 || total <= 0) return false;
  if (total < budget * BUDGET_COMPACTION_RATIO) return false;
  // Anti-loop: if the last budget compaction barely moved the needle, the
  // session genuinely does not fit this channel — stop burning model calls.
  if (
    lastBudgetCompactionTotal > 0 &&
    Math.abs(total - lastBudgetCompactionTotal) < FORCED_COMPACTION_MIN_REDUCTION
  ) {
    return false;
  }
  return true;
}

type Logger = (message: string) => void;

export interface ForcedCompactionOptions {
  log?: Logger;
  /**
   * Largest request (in tokens) this channel reliably accepts — i.e. the
   * ceiling enforced by the provider/gateway, which is often far below the
   * model's declared `contextWindow`. 0 or undefined disables the budget lane
   * and leaves only the original length+output=0 behaviour.
   */
  contextTokenBudget?: number;
  /**
   * Resolver form of `contextTokenBudget`. Called on every stop so a per-model
   * override still applies after a mid-session model switch. Takes precedence
   * over the static `contextTokenBudget`.
   */
  resolveContextTokenBudget?: () => number;
}

/**
 * Monkey-patch the Pi SDK session's private `_checkCompaction` so a terminal
 * `stopReason="length"` + `usage.output === 0` message triggers a forced
 * auto-compaction even when the SDK's `shouldCompact` threshold was not
 * reached. See module docstring for rationale + guard rails.
 *
 * The SDK's `_handlePostAgentRun` calls `_checkCompaction(msg)` after every
 * agent stop; when our patch returns true the SDK continues the run, exactly
 * as it would after a threshold/overflow compaction.
 *
 * Returns a restore function (not currently used — the patch is applied once
 * at session creation).
 */
export function applyForcedCompactionPatch(
  session: AgentSession,
  optionsOrLog?: ForcedCompactionOptions | Logger,
): () => void {
  // Accept the legacy second-argument logger for call sites that predate the
  // channel-budget lane.
  const options: ForcedCompactionOptions =
    typeof optionsOrLog === 'function' ? { log: optionsOrLog } : (optionsOrLog ?? {});
  const { log, contextTokenBudget = 0, resolveContextTokenBudget } = options;

  const sdk = session as unknown as {
    _checkCompaction?: (assistantMessage: unknown, skipAbortedCheck?: boolean) => Promise<boolean>;
    _runAutoCompaction?: (reason: string, willRetry: boolean) => Promise<boolean>;
  };
  const original = sdk._checkCompaction?.bind(session);
  if (!original || typeof sdk._runAutoCompaction !== 'function') {
    // SDK surface changed — nothing to patch.
    return () => {};
  }

  let lastForcedTotalTokens = 0;
  let lastBudgetCompactionTotal = 0;
  let budgetWarned = false;

  const patched = async (assistantMessage: unknown, skipAbortedCheck = true): Promise<boolean> => {
    // Let the SDK decide first (threshold / overflow / before-compaction checks).
    const sdkResult = await original(assistantMessage, skipAbortedCheck);
    if (sdkResult) return true;

    const msg = assistantMessage as LengthZeroOutputMessage;
    const runAuto = sdk._runAutoCompaction!.bind(session);

    // Lane 1 — channel budget: compact before the provider rejects the request.
    let budget = contextTokenBudget;
    if (resolveContextTokenBudget) {
      try {
        budget = resolveContextTokenBudget();
      } catch {
        // Resolver is best-effort; fall back to the static value.
      }
    }
    if (budget > 0) {
      const total = contextTokens(msg);
      if (total >= budget && !budgetWarned) {
        budgetWarned = true;
        log?.(
          `[forced-compaction] context ${total} tokens is at/over the channel budget ` +
            `${budget} — this session needs a larger-budget channel or ` +
            `compaction will not be able to keep it under the ceiling`,
        );
      }
      if (shouldCompactForBudget(total, budget, lastBudgetCompactionTotal)) {
        try {
          const forced = await runAuto('threshold', false);
          if (forced) {
            lastBudgetCompactionTotal = total;
            log?.(
              `[forced-compaction] context ${total} tokens reached ` +
                `${Math.round(BUDGET_COMPACTION_RATIO * 100)}% of the channel budget ` +
                `(${budget}) — forced auto-compaction`,
            );
            return true;
          }
        } catch (err) {
          log?.(`[forced-compaction] budget compaction failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // Lane 2 — the original length+output=0 guard.
    if (!shouldForceCompaction(msg, lastForcedTotalTokens)) {
      return false;
    }

    const total = contextTokens(msg);
    try {
      const forced = await runAuto('threshold', false);
      if (forced) {
        lastForcedTotalTokens = total;
        log?.(`[forced-compaction] length+output=0 at ${total} tokens — forced auto-compaction`);
        return true;
      }
    } catch (err) {
      log?.(`[forced-compaction] Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return false;
  };

  sdk._checkCompaction = patched;
  return () => {
    sdk._checkCompaction = original;
  };
}
