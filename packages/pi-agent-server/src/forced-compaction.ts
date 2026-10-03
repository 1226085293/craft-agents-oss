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

export interface CompactionHandoffInput {
  sessionJsonlPath: string;
  progressJsonlPath?: string;
  currentUserRequest?: string;
  progressSnapshot?: string;
  existingInstructions?: string;
}

const MAX_HANDOFF_CONTEXT_CHARS = 8_000;

/** Build the fixed summary contract appended to every default compaction prompt. */
export function buildCompactionHandoffInstructions(input: CompactionHandoffInput): string {
  const fixed = [
    'COMPACTION HANDOFF CONTRACT — produce a concise, durable handoff summary. Do not continue the conversation or answer the user.',
    'Required sections (preserve these headings and do not omit a section; write "None" when genuinely empty):',
    '1. Current user request verbatim: preserve the active request exactly, including constraints and acceptance criteria.',
    '2. Task checklist: Completed (each item with its result), In progress (exact current state), Blocked (blocker and needed input).',
    '3. Confirmed facts and conclusions: include evidence, exact values, and decisions already established.',
    '4. Rejected paths and reasons: record failed/ruled-out approaches and why; never present them as next steps.',
    '5. Next actions: list the smallest concrete next steps in order.',
    '6. Key file paths and IDs: preserve exact paths, identifiers, commands, and error text needed to resume.',
    'When updating an earlier compaction summary, merge its still-valid state with new conversation evidence; do not drop completed items or rejected-path reasons merely because they are old.',
    `Transcript recovery pointer: the full conversation is persisted at ${input.sessionJsonlPath}. If a required detail is missing, instruct the resumed agent to search/read that file before repeating work.`,
    ...(input.progressJsonlPath ? [`Durable request/progress ledger: the full current request (credential values redacted), latest steer, and bounded tool/conclusion records are at ${input.progressJsonlPath}. If the active request above is clipped, read this ledger before continuing.`] : []),
  ].join('\n\n');
  const remaining = Math.max(0, MAX_HANDOFF_CONTEXT_CHARS - fixed.length - 8);
  const currentLimit = Math.min(3_200, Math.floor(remaining * 0.5));
  const progressLimit = Math.min(2_400, Math.floor(remaining * 0.35));
  const reservedCurrent = input.currentUserRequest
    ? `Active user request and latest guidance (preserve verbatim in section 1):\n${input.currentUserRequest.slice(0, currentLimit)}`
    : '';
  const currentUsed = reservedCurrent.length;
  const focusLimit = Math.min(800, Math.max(0, remaining - currentUsed - (input.progressSnapshot ? 100 : 0)));
  const focus = input.existingInstructions
    ? `Additional caller focus (also preserve):\n${input.existingInstructions.slice(0, focusLimit)}`
    : '';
  const progressRemaining = Math.max(0, remaining - currentUsed - focus.length);
  const boundedProgress = input.progressSnapshot
    ? `Durable progress ledger (latest completed calls and conclusions):\n${input.progressSnapshot.slice(-Math.min(progressLimit, progressRemaining))}`
    : '';
  return [fixed, reservedCurrent, focus, boundedProgress].filter(Boolean).join('\n\n').slice(0, MAX_HANDOFF_CONTEXT_CHARS);
}

export interface ForcedCompactionOptions {
  log?: Logger;
  /** Session transcript path included in the handoff and recovery pointer. */
  sessionJsonlPath?: string;
  /** Persistent request/progress ledger path used for full-input recovery. */
  progressJsonlPath?: string;
  /** Current user request, resolved at compaction time to include steer updates. */
  resolveCurrentUserRequest?: () => string | undefined;
  /** Persisted progress ledger, resolved at compaction time. */
  resolveProgressSnapshot?: () => string;
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
  const {
    log,
    contextTokenBudget = 0,
    resolveContextTokenBudget,
    sessionJsonlPath,
    resolveCurrentUserRequest,
    resolveProgressSnapshot,
    progressJsonlPath,
  } = options;

  const sdk = session as unknown as {
    _checkCompaction?: (assistantMessage: unknown, skipAbortedCheck?: boolean) => Promise<boolean>;
    _runAutoCompaction?: (reason: string, willRetry: boolean) => Promise<boolean>;
    _runDefaultCompaction?: (...args: unknown[]) => Promise<unknown>;
  };
  const original = sdk._checkCompaction?.bind(session);
  const originalDefaultCompaction = sdk._runDefaultCompaction;
  if (!original || typeof sdk._runAutoCompaction !== 'function') {
    // SDK surface changed — report the lost safety integration, do not silently
    // leave users believing forced compaction and the summary contract remain active.
    log?.('[compaction-handoff] WARNING: Pi SDK auto-compaction hooks unavailable; forced compaction and universal handoff patch are not installed');
    return () => {};
  }

  if (originalDefaultCompaction && sessionJsonlPath) {
    sdk._runDefaultCompaction = async function (...args: unknown[]): Promise<unknown> {
      const existingInstructions = typeof args[4] === 'string' ? args[4] : undefined;
      const handoff = buildCompactionHandoffInstructions({
        sessionJsonlPath,
        progressJsonlPath,
        currentUserRequest: safeResolve(resolveCurrentUserRequest),
        progressSnapshot: safeResolve(resolveProgressSnapshot),
        existingInstructions,
      });
      args[4] = handoff;
      log?.(`[compaction-handoff] attached contract to ${String(args[7] ?? 'unknown')} compaction (${handoff.length} chars)`);
      return originalDefaultCompaction.apply(this, args);
    };
  } else if (sessionJsonlPath) {
    log?.('[compaction-handoff] SDK default compaction method unavailable; summary contract not installed');
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
    if (originalDefaultCompaction) sdk._runDefaultCompaction = originalDefaultCompaction;
  };
}

function safeResolve<T>(resolver: (() => T) | undefined): T | undefined {
  try { return resolver?.(); } catch { return undefined; }
}
