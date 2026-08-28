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

type Logger = (message: string) => void;

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
export function applyForcedCompactionPatch(session: AgentSession, log?: Logger): () => void {
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

  const patched = async (assistantMessage: unknown, skipAbortedCheck = true): Promise<boolean> => {
    // Let the SDK decide first (threshold / overflow / before-compaction checks).
    const sdkResult = await original(assistantMessage, skipAbortedCheck);
    if (sdkResult) return true;

    const msg = assistantMessage as LengthZeroOutputMessage;
    if (!shouldForceCompaction(msg, lastForcedTotalTokens)) {
      return false;
    }

    const total = contextTokens(msg);
    const runAuto = sdk._runAutoCompaction!.bind(session);
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
