/**
 * Pi SDK Event Adapter
 *
 * Maps Pi Agent Core events (AgentEvent / AgentSessionEvent) to
 * Craft Agent's AgentEvent format for UI compatibility.
 *
 * Pi emits fine-grained lifecycle events. We translate them into
 * the same event vocabulary the renderer already understands from
 * Claude / Codex / Copilot backends.
 */

import type { AgentEvent as CraftAgentEvent } from '@craft-agent/core/types';
import type {
  AgentEvent as PiAgentEvent,
} from '@earendil-works/pi-agent-core';
import type {
  AgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import { isContextOverflow, isRetryableAssistantError } from '@earendil-works/pi-ai';
import { BaseEventAdapter } from '../base-event-adapter.ts';
import { PI_TOOL_NAME_MAP } from './constants.ts';
import { toolMetadataStore } from '../../../interceptor-common.ts';
import { createAgentError, parseError } from '../../errors.ts';

/**
 * Pi SDK auto-compaction race signature — the AbortController crash described
 * in `_runAutoCompaction` (`@earendil-works/pi-coding-agent` agent-session.ts).
 * When two `_runAutoCompaction` calls overlap, one's `finally` clears the
 * shared `_autoCompactionAbortController` field while the other is still
 * suspended on an await; the next `.signal` read crashes. Matched against
 * `compaction_end.errorMessage` to surface a friendly message instead of the
 * raw stack until the upstream fix lands. See plans/fix-pi-gpt-compaction.md.
 */
const SDK_AUTOCOMPACT_RACE_SIGNATURE = /_autoCompactionAbortController\.signal/;

/** How long to wait after a held overflow `agent_end` for a `compaction_start`
 *  before giving up and surfacing the original error. The SDK fires
 *  `_checkCompaction` on the same event-queue tick, so the only delay is event
 *  serialization — 5 s is well above any plausible jitter. */
const OVERFLOW_FALLBACK_TIMEOUT_MS = 5_000;

/** How long to wait after an `agent_end { willRetry: true }` for the SDK's
 *  `auto_retry_start`. `_prepareRetry` emits it synchronously right after the
 *  agent loop returns, so — as with overflow — only event serialization can
 *  delay it. */
const RETRY_START_FALLBACK_TIMEOUT_MS = 5_000;

/** Grace added on top of the backoff the SDK announced in
 *  `auto_retry_start.delayMs` before we stop waiting for the retried run's
 *  `agent_start` and surface the parked error instead. */
const RETRY_RUN_GRACE_MS = 15_000;

/** Retryable provider errors that the shared `parseError` cannot classify are
 *  split into provider-side incidents (surfaced as `service_error`) and
 *  transport failures (surfaced as `network_error`). Patterns mirror the
 *  provider-side group of pi-ai's `RETRYABLE_PROVIDER_ERROR_PATTERN`. */
const RETRYABLE_PROVIDER_SIDE_PATTERN =
  /overloaded|provider.?returned.?error|retry your request|request again|resource.?exhausted|retry delay|server.?error|internal.?error|service.?unavailable|exceeded request buffer limit/i;

/**
 * Combined event type the adapter can handle.
 * AgentSessionEvent is a superset of PiAgentEvent (adds compaction_*, auto_retry_*, queue_update).
 */
type PiEvent = PiAgentEvent | AgentSessionEvent;

/**
 * Maps Pi SDK events to Craft AgentEvents for UI compatibility.
 *
 * Event mapping:
 * - message_update (text_delta in assistantMessageEvent) → text_delta
 * - message_end → text_complete
 * - tool_execution_start → tool_start
 * - tool_execution_end → tool_result
 * - agent_end → complete (deferred while overflow recovery or an auto-retry is in flight)
 * - compaction_start → status (with "Compacting" keyword)
 * - compaction_end → info/error
 * - failed message_end → text_discard (only its unfinished text)
 * - auto_retry_start / retried agent_start → retry (backoff / active)
 * - auto_retry_end → retry (end) + info on success; releases errors on cancellation
 * - queue_update / agent_settled / entry_appended / summarization_retry_* → ignored
 */
export class PiEventAdapter extends BaseEventAdapter {
  // Track tool names from execution_start for proper tool_result correlation
  private toolNames: Map<string, string> = new Map();

  // Track whether streaming deltas have been received for the current message
  private hasStreamedDeltas: boolean = false;

  // Track whether a final (non-intermediate) text_complete has been emitted this turn
  private hasEmittedFinalText: boolean = false;

  // Turn id of the LAST final (non-intermediate) reply emitted this turn —
  // targeted by `text_demote` when verification is triggered (2026-10-02).
  private lastFinalTextTurnId: string | null = null;
  /**
   * Queued-follow-up re-promotion capture (2026-10-07, 261007-wise-horizon).
   * When a mid-turn user steer is drained, the MAIN reply that was demoted
   * for the queuedFollowUpHeld hold is recorded here; on the drained
   * reply's terminal stop (hold released, nothing pending) the adapter
   * emits `text_promote` so the demoted reply returns to a result bubble
   * instead of staying buried in the process card. Captured ONLY for the
   * pure queued-follow-up hold — defense/verification holds keep the
   * fleet-mist process-step behavior (no re-promotion).
   */
  private queuedHoldDemotedReply: { turnId: string; text: string } | null = null;
  /** Most recent FINAL reply text — re-promotion source when an agent_end
   *  hold demotes a reply that was already final (active-wren window). */
  private lastEmittedFinalText: { turnId: string; text: string } | null = null;

  // Sub-turnId isolation for tool calls within a single Pi turn
  private subTurnCounter: number = 0;
  private messageSubTurnId: string | null = null;

  // When the current assistant message started (its message_start event).
  // Thinking-only blocks never stream text deltas — their thinking text is
  // synthesized as an intermediate text_complete at message_end, so the
  // SessionManager's delta-based startedAt hook can't see them. Stamping
  // this time onto that synthetic event keeps process-card ordering
  // honest: the block's row sorts from the moment the model started it,
  // not from when the block became visible at completion.
  private messageStartAt: number | null = null;

  // Model context window for usage_update events
  private contextWindow: number | undefined;

  // Mini model ID for call_llm display default (#596).
  // Used when the caller didn't specify an explicit model — we fill args.model
  // on the tool_start event so the UI shows the effective default instead of
  // leaving the badge blank.
  private miniModel: string | undefined;

  // Track last usage for emitting with complete event
  private lastUsage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: { total: number } } | undefined;

  // Last usage reading that actually carried a context size (> 0). Failed
  // (stopReason 'error') and interrupted (stopReason 'aborted') assistant
  // messages still carry a `usage` object — the API clients initialize it to
  // all zeros and only fill it once a response has been parsed — so they must
  // not overwrite the last real reading. See the `message_end` / `complete`
  // handling: emitting a 0 here wipes the context badge (and the persisted
  // tokenUsage) to 0% after an error or an app restart.
  private lastContextTokens = 0;

  // ============================================================
  // Overflow-recovery state machine
  // ============================================================
  //
  // When a Pi-routed assistant message returns a context_length_exceeded
  // error, the Pi SDK's `_checkCompaction` fires `_runAutoCompaction("overflow",
  // true)` and, on success, calls `agent.continue()` to retry. That recovered
  // turn arrives AFTER the original `agent_end`. If we yield `complete` and
  // call `eventQueue.complete()` on the original `agent_end` (the historic
  // behavior), the recovered turn lands in a closed iterator. The state
  // machine below holds the queue open across the SDK's recovery flow so the
  // recovered response reaches the UI.
  private overflowState: 'none' | 'held' | 'awaiting' | 'compacting' | 'recovering' = 'none';
  private heldOverflowError: string | null = null;
  private fallbackTimerId: ReturnType<typeof setTimeout> | null = null;

  // ============================================================
  // Auto-retry state machine
  // ============================================================
  //
  // The Pi SDK retries transient provider/transport errors on its own
  // (`isRetryableAssistantError`: 429/5xx/overloaded, "fetch failed",
  // "terminated", "socket hang up", …) with exponential backoff. The event
  // sequence is: message_end(error) → agent_end { willRetry: true } →
  // auto_retry_start → [backoff] → agent_start … agent_end. Exactly like
  // overflow recovery, the retried run arrives AFTER an agent_end, so the
  // adapter must not complete the queue on that agent_end. It also parks the
  // classified error instead of surfacing it: the user sees a "retrying"
  // status and either the recovered answer or, if every attempt fails, one
  // error at the end.
  //
  //   none ──message_end(retryable)──► held
  //   held ──agent_end{willRetry:false}──► none        (release error, complete)
  //   held ──agent_end{willRetry:true}───► awaitingRetry (5 s fallback)
  //   awaitingRetry ──auto_retry_start──► backoff      (delayMs + grace fallback)
  //   backoff ──agent_start────────────► recovering
  //   recovering ──agent_end───────────► none          (normal complete)
  //   awaitingRetry|backoff ──auto_retry_end{success:false}──► none (release, complete)
  private retryState: 'none' | 'held' | 'awaitingRetry' | 'backoff' | 'recovering' = 'none';
  private heldRetryError: CraftAgentEvent | null = null;
  private retryFallbackTimerId: ReturnType<typeof setTimeout> | null = null;

  /** Set when the adapter wants the caller to call `eventQueue.complete()`
   *  on a non-`agent_end` event (e.g. `compaction_end` failure, cancelled
   *  auto-retry). Consumed by `shouldCompleteQueue()`. */
  private pendingQueueComplete: boolean = false;
  /** Caller-supplied callbacks for the asynchronous fallback timer paths —
   *  the timers fire outside `adaptEvent()` so we can't yield through the
   *  generator. */
  private onFallbackEvent: ((event: CraftAgentEvent) => void) | null = null;
  private onFallbackComplete: (() => void) | null = null;
  /** Set while a defense resume is in flight: the subprocess annotated an
   *  `agent_end` with `defenseResumePending: true` (it queued a followUp that
   *  continues the same turn after this agent_end). The queue stays open until
   *  the FINAL `agent_end` (no flag) arrives — the defense analog of
   *  overflowState. See the subprocess defense layer in pi-agent-server. */
  private defenseResumeHeld: boolean = false;
  /** Set when the subprocess annotated an `agent_end` with
   *  `queuedFollowUpPending: true` — the SDK's _handlePostAgentRun will
   *  `agent.continue()` with queued steering/followUp messages after this
   *  agent_end. The queue stays open for that continuation turn (same shape
   *  as defenseResumeHeld). The FINAL `agent_end` (no flag) clears it. */
  private queuedFollowUpHeld: boolean = false;
  /** True while the SDK's most recent `queue_update` reported non-empty
   *  steering (or followUp) queues. Backup signal for the subprocess's
   *  `assistantFollowUpPending` stamp: while set, an assistant stop text is a
   *  process step, never a result bubble (2026-10-05 smooth-gorge).
   *  Cleared on an empty `queue_update`, by {@link onTurnStart} and
   *  {@link resetRecoveryState}. */
  private queuePendingNonEmpty: boolean = false;
  /** Set when the subprocess annotated an `agent_end` with
   *  `defenseVerificationPending: true` — a program-side verification turn is
   *  in flight (subprocess LLM judge; 2026-10-02 redesign). Unlike a defense
   *  resume there is NO resumed agent_end ahead: the queue stays open until
   *  the subprocess reports `verification_result` (passed → replay the final
   *  text, complete; failed → a followUp continues the turn, its FINAL
   *  agent_end completes). */
  private verificationHeld: boolean = false;
  /** Correlation id of the final candidate awaiting a successful verification replay. */
  private verificationReplayTurnId: string | null = null;

  // ============================================================
  // Retryable-error deferral (auto-retry terminal-state reporting)
  // ============================================================
  //
  // The Pi SDK's auto-retry sequence for a retryable assistant error
  // (per `isRetryableAssistantError` — overloaded / 429 / 5xx / network /
  // "terminated" …) is:
  //   message_end(stopReason:'error')
  //   → agent_end with willRetry:true  (SDK annotates every agent_end —
  //     `_willRetryAfterAgentEnd`)
  //   → auto_retry_start
  //   → retried turn events … final agent_end (willRetry:false)
  // When retries are exhausted the LAST agent_end carries willRetry:false and
  // auto_retry_end(success:false) follows it. If the user aborts during the
  // backoff sleep, auto_retry_end(success:false) is the terminal event and no
  // second agent_end follows.
  //
  // Historic bug: the adapter surfaced the error immediately on message_end,
  // so the UI (Telegram ❌) reported final failure while the SDK was still
  // retrying — and the retried answer then arrived anyway. The state below
  // defers retryable errors until an explicit failure terminal and reports
  // them exactly once.
  /** Buffered retryable error, deferred until the turn's failure terminal. */
  private deferredRetryError: { message: string; parsed: ReturnType<typeof parseError> | null } | null = null;
  /** True while an auto-retry is in flight after a held agent_end — keeps the
   *  event queue open for the retried turn. */
  private retryHoldActive: boolean = false;
  /** Set once a terminal error has been reported this turn-cycle so late
   *  auto_retry_end(success:false) events don't report a second failure. */
  private hasEmittedTerminalError: boolean = false;

  constructor() {
    super('pi-event');
  }

  /**
   * Set the model's context window size for usage reporting.
   * Pass undefined to clear (e.g. after switching to a custom model whose
   * window is unknown) so events stop reporting a stale window.
   */
  setContextWindow(cw?: number): void {
    this.contextWindow = cw;
  }

  /**
   * Register handlers invoked when a recovery fallback timer fires — the SDK
   * didn't emit a `compaction_start` after a held overflow `agent_end`, or no
   * `auto_retry_start` / retried `agent_start` followed an
   * `agent_end { willRetry: true }`. The adapter calls `onEvent` to enqueue the
   * parked error, then `onComplete` to terminate the iterator.
   */
  setRecoveryFallbackHandlers(
    onEvent: (event: CraftAgentEvent) => void,
    onComplete: () => void,
  ): void {
    this.onFallbackEvent = onEvent;
    this.onFallbackComplete = onComplete;
  }

  /**
   * Decide whether the caller should call `eventQueue.complete()` after
   * processing this SDK event. The historical rule was "always on
   * `agent_end`"; with overflow recovery AND defense resumes we defer
   * completion until the recovered/resumed turn finishes (or recovery
   * fails / times out).
   *
   * `defenseResumePending` is the subprocess-annotated flag on the raw
   * `agent_end` event — true when a defense resume (followUp) is queued, so
   * the queue must stay open for the resumed turn. The FINAL `agent_end`
   * (no flag / false) clears the hold and completes normally.
   *
   * `queuedFollowUpPending` is the subprocess-annotated flag set when the
   * SDK still holds queued steering/followUp messages at agent_end
   * (pendingMessageCount > 0). The SDK's `_handlePostAgentRun` will then
   * call `agent.continue()` AFTER this agent_end — a continuation turn with
   * no flag of its own. Hold the queue open for it (2026-09-06 golden-swamp
   * incident: steer arrived near turn end; the continuation's events landed
   * in a closed iterator and were silently lost).
   */
  shouldCompleteQueue(
    isAgentEnd: boolean,
    defenseResumePending?: boolean,
    queuedFollowUpPending?: boolean,
    verificationPending?: boolean,
  ): boolean {
    if (this.pendingQueueComplete) {
      this.pendingQueueComplete = false;
      return true;
    }
    if (isAgentEnd) {
      if (defenseResumePending) {
        // A defense resume is in flight — hold the queue open for the
        // resumed turn's events (they arrive after this agent_end).
        this.defenseResumeHeld = true;
        return false;
      }
      this.defenseResumeHeld = false;
      if (verificationPending) {
        // Program-side verification in flight (subprocess LLM judge). No
        // resumed turn is scheduled — hold the queue until verification_result.
        this.verificationHeld = true;
        return false;
      }
      this.verificationHeld = false;
      if (queuedFollowUpPending) {
        // The SDK will continue the turn with queued steering/followUp
        // messages after this agent_end — hold the queue open.
        this.queuedFollowUpHeld = true;
        return false;
      }
      this.queuedFollowUpHeld = false;
      if (this.retryHoldActive) {
        // The retry hold was already resolved in adaptEvent above (terminal
        // agent_end surfaced the deferred error). A hold means this agent_end
        // was the willRetry:true one — keep the queue open for the retried turn.
        return false;
      }
      // The upstream SDK retry lane holds the turn open while a retry is
      // announced, backing off or still awaiting its start.
      if (this.retryState !== 'none') return false;
      return this.overflowState === 'none';
    }
    return false;
  }

  /**
   * Finalize a held defense resume when the subprocess reports the followUp
   * failed (no resumed turn will arrive). Sets pendingQueueComplete so the
   * next event terminates the iterator; the caller then enqueues a terminal
   * error + calls `eventQueue.complete()` directly.
   */
  finalizeDefenseResumeHeld(): void {
    this.defenseResumeHeld = false;
    this.pendingQueueComplete = true;
  }

  /**
   * Finalize a held verification turn when the subprocess reports the
   * `verification_result`. passed=true → the final reply was verified and is
   * replayed verbatim — terminate the queue now (pendingQueueComplete).
   * passed=false → a followUp will continue the turn (LLM repairs the
   * reply); just release the verification hold — the resumed turn's FINAL
   * `agent_end` (no flags) completes the queue normally.
   */
  finalizeVerificationHeld(passed: boolean): void {
    // No-op when no verification hold is active: a late/duplicate
    // verification_result (e.g. the judge finished after the user
    // interrupted the turn and resetRecoveryState() released the hold)
    // must NOT touch pendingQueueComplete or the live next turn's queue.
    if (!this.verificationHeld) return;
    this.verificationHeld = false;
    if (passed) {
      // Replay path: the verified final reply is replayed verbatim — the
      // next shouldCompleteQueue check terminates the queue so the main
      // process can deliver it (mirrors finalizeDefenseResumeHeld).
      this.pendingQueueComplete = true;
    }
    if (!passed) this.verificationReplayTurnId = null;
  }

  /** Build the one visible final reply after the verifier has passed. */
  createVerifiedReplyEvent(finalText: string): CraftAgentEvent {
    const turnId = this.verificationReplayTurnId ?? this.nextSubTurnId('m');
    this.verificationReplayTurnId = null;
    this.hasEmittedFinalText = true;
    this.lastFinalTextTurnId = turnId;
    return { type: 'text_complete', text: finalText, isIntermediate: false, turnId };
  }

  /**
   * Read-only: whether a program-side verification hold is currently active
   * (an agent_end annotated defenseVerificationPending arrived and the
   * subprocess judge result has not been processed yet). Callers of
   * `finalizeVerificationHeld` guard on this so that a result that lands
   * after the hold was released (interrupt/teardown) is dropped instead of
   * injecting a stale "Verification passed" replay into the next turn.
   */
  isVerificationHeld(): boolean {
    return this.verificationHeld;
  }

  /**
   * Fold the already-emitted draft final reply into the process block (via a
   * `text_demote` event) BEFORE the event queue is held open, so the UI never
   * shows a "final" reply bubble while the turn is still running (a later
   * continuation / recovered run / retried run produces the real final bubble).
   * No-op when no non-intermediate reply was emitted this turn.
   *
   * Hold-open points: overflow-compaction recovery, defense-resume follow-up,
   * queued steering/follow-up continuation, and the SDK auto-retry lane.
   */
  private *demoteDraftReplyForHold(): Generator<CraftAgentEvent, void, void> {
    if (this.lastFinalTextTurnId) {
      const t = this.lastFinalTextTurnId;
      this.lastFinalTextTurnId = null;
      yield { type: 'text_demote', turnId: t };
    }
    // The draft has been folded into the process block — it is no longer
    // "the" final reply of this turn. Without this reset the one-final gate
    // (`!hasEmittedFinalText`) would block the drained continuation's reply
    // from becoming the new result bubble (2026-10-07 active-wren variant:
    // steer queued in the message_end→agent_end window, main reply demoted
    // here, drained reply then suppressed → zero bubbles).
    this.hasEmittedFinalText = false;
  }

  /**
   * Reset overflow-recovery + defense-resume state. Call from session
   * disposal so a stale fallback timer doesn't fire on a torn-down adapter.
   */
  resetRecoveryState(): void {
    this.cancelOverflowFallbackTimer();
    this.overflowState = 'none';
    this.heldOverflowError = null;
    this.cancelRetryFallbackTimer();
    this.retryState = 'none';
    this.heldRetryError = null;
    this.pendingQueueComplete = false;
    this.defenseResumeHeld = false;
    this.queuedFollowUpHeld = false;
    this.queuePendingNonEmpty = false;
    this.verificationHeld = false;
    this.verificationReplayTurnId = null;
    this.queuedHoldDemotedReply = null;
    this.lastEmittedFinalText = null;
    this.lastFinalTextTurnId = null;
    this.deferredRetryError = null;
    this.retryHoldActive = false;
    this.hasEmittedTerminalError = false;
  }

  /**
   * Local alias for `resetRecoveryState` — the pre-upstream name, still used
   * by `PiAgent` teardown and the adapter's own tests.
   */
  resetOverflowState(): void {
    this.resetRecoveryState();
  }

  /** Whether an overflow recovery or auto-retry currently holds the turn open. */
  get isHoldingTurn(): boolean {
    return this.overflowState !== 'none' || this.retryState !== 'none';
  }

  /**
   * Yield the parked retryable error (if any) and leave the retry state
   * machine. Used when the SDK will not retry (disabled/exhausted) or when a
   * retry was cancelled.
   */
  private *releaseHeldRetryError(): Generator<CraftAgentEvent> {
    const held = this.heldRetryError;
    this.heldRetryError = null;
    this.retryState = 'none';
    this.cancelRetryFallbackTimer();
    yield { type: 'retry', phase: 'end' };
    if (held) yield held;
  }

  /**
   * Arm the auto-retry fallback timer. Fires only if the state is unchanged
   * when the timeout elapses (a late event may already have moved us on).
   */
  private armRetryFallbackTimer(timeoutMs: number, reason: string): void {
    this.cancelRetryFallbackTimer();
    const armedState = this.retryState;
    this.retryFallbackTimerId = setTimeout(() => {
      this.retryFallbackTimerId = null;
      if (this.retryState !== armedState) return;
      this.log.warn(`Auto-retry fallback fired — ${reason}`, { timeoutMs, state: armedState });
      const held: CraftAgentEvent = this.heldRetryError ?? {
        type: 'error',
        message: 'The model request failed and the automatic retry did not start. Please try again.',
      };
      this.heldRetryError = null;
      this.retryState = 'none';
      this.onFallbackEvent?.({ type: 'retry', phase: 'end' });
      this.onFallbackEvent?.(held);
      this.onFallbackComplete?.();
    }, timeoutMs);
  }

  private cancelRetryFallbackTimer(): void {
    if (this.retryFallbackTimerId !== null) {
      clearTimeout(this.retryFallbackTimerId);
      this.retryFallbackTimerId = null;
    }
  }

  /**
   * Classify a failed assistant message for the UI.
   *
   * Auth/billing/rate-limit/5xx errors go through the shared `parseError` so
   * SessionManager can run its auth-retry pipeline (refresh token + resend).
   * Transient errors that parser doesn't know but the SDK retries ("terminated",
   * "socket hang up", "stream ended before message_stop", …) become typed
   * connection/service errors so the UI offers Retry instead of a raw string.
   */
  private classifyAssistantError(message: AssistantMessage, errorMessage: string): CraftAgentEvent {
    const parsed = parseError(new Error(errorMessage));
    if (parsed.code !== 'unknown_error') {
      return { type: 'typed_error', error: parsed };
    }
    if (isRetryableAssistantError(message)) {
      const code = RETRYABLE_PROVIDER_SIDE_PATTERN.test(errorMessage) ? 'service_error' : 'network_error';
      return { type: 'typed_error', error: createAgentError(code, errorMessage) };
    }
    return { type: 'error', message: errorMessage };
  }

  /** Short human-readable label for the retry status line. */
  private retryReasonLabel(sdkErrorMessage: string | undefined): string {
    const held = this.heldRetryError;
    if (held?.type === 'typed_error') return held.error.title;
    const raw = (held?.type === 'error' ? held.message : sdkErrorMessage) ?? '';
    const oneLine = raw.replace(/\s+/g, ' ').trim();
    if (!oneLine) return 'Temporary model error';
    return oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine;
  }

  private armOverflowFallbackTimer(): void {
    this.cancelOverflowFallbackTimer();
    this.fallbackTimerId = setTimeout(() => {
      this.fallbackTimerId = null;
      // Re-check state at fire time — a late `compaction_start` may have
      // already transitioned us to `compacting`.
      if (this.overflowState !== 'awaiting') return;
      const errorMessage = this.heldOverflowError ?? 'Context overflow';
      this.heldOverflowError = null;
      this.overflowState = 'none';
      this.log.warn('Overflow recovery fallback fired — SDK emitted no compaction events', {
        timeoutMs: OVERFLOW_FALLBACK_TIMEOUT_MS,
      });
      this.onFallbackEvent?.({ type: 'error', message: errorMessage });
      this.onFallbackComplete?.();
    }, OVERFLOW_FALLBACK_TIMEOUT_MS);
  }

  private cancelOverflowFallbackTimer(): void {
    if (this.fallbackTimerId !== null) {
      clearTimeout(this.fallbackTimerId);
      this.fallbackTimerId = null;
    }
  }

  /**
   * Set the mini model ID for call_llm badge default.
   * When the agent's call_llm invocation omits `args.model`, we fill it with
   * this so the UI badge shows the effective default instead of nothing.
   * Explicit `args.model` values from the agent are always preserved.
   */
  setMiniModel(model: string | undefined): void {
    this.miniModel = model;
  }

  /**
   * Generate a unique sub-turnId for a text block within the current turn.
   */
  private nextSubTurnId(prefix: string): string {
    const base = this.currentTurnId || 'unknown';
    return `${base}__${prefix}${this.subTurnCounter++}`;
  }

  protected onTurnStart(): void {
    this.toolNames.clear();
    this.hasStreamedDeltas = false;
    this.hasEmittedFinalText = false;
    this.lastFinalTextTurnId = null;
    this.verificationReplayTurnId = null;
    this.subTurnCounter = 0;
    this.messageSubTurnId = null;
    this.messageStartAt = null;
    // A new Craft turn can only start once the previous queue completed (or
    // was force-aborted), so any recovery state left over here is stale.
    //
    // The local subprocess retry buffer is deliberately preserved: that lane
    // re-drives the turn from the subprocess on a long backoff, and the
    // buffered error must still surface if the retried run fails terminally.
    const deferredRetryError = this.deferredRetryError;
    this.resetRecoveryState();
    this.deferredRetryError = deferredRetryError;
    this.log.debug('Turn started', { turnIndex: this.turnIndex });
  }

  /**
   * Adapt a Pi SDK event to zero or more Craft AgentEvents.
   */
  *adaptEvent(event: PiEvent): Generator<CraftAgentEvent> {
    // Craft-injected event from pi-agent-server (not part of the Pi SDK).
    // The subprocess emits this immediately after each `message_end` to deliver
    // the correct `sdkTurnAnchor` (the leaf id AFTER the SDK has appended the
    // assistant entry). We forward it through as-is — SessionManager correlates
    // it to a Craft assistant message via `sdkMessageId`. See craft-agents-oss#782.
    if ((event as { type?: string }).type === 'pi_turn_anchor') {
      const e = event as unknown as { sdkMessageId?: string; sdkTurnAnchor?: string };
      if (e.sdkMessageId && e.sdkTurnAnchor) {
        yield {
          type: 'pi_turn_anchor',
          sdkMessageId: e.sdkMessageId,
          sdkTurnAnchor: e.sdkTurnAnchor,
        };
      }
      return;
    }

    // Craft-injected compaction heartbeat from pi-agent-server (not part of
    // the Pi SDK). While the SDK compacts, the main stream is silent, so the
    // server emits periodic ticks. The ticks are consumed upstream by
    // PiAgent.recordSubprocessTurnProgress → refreshTurnIdleWatchdog (they
    // keep the capped compaction watchdog armed without ever extending the
    // deadline). They are NOT surfaced to the UI as status events: each tick
    // used to append its own "Compacting context... (Nm Ms)" line to the
    // process block, producing a growing list of near-identical rows with a
    // stale per-tick elapsed time. The UI instead keeps the single
    // "Compacting context..." row emitted on compaction_start (the renderer
    // dedupes repeated compacting status messages in place) and the bottom
    // ProcessingIndicator already shows a live per-second elapsed timer.
    if ((event as { type?: string }).type === 'compaction_progress') {
      return;
    }

    switch (event.type) {
      // ============================================================
      // Agent lifecycle events
      // ============================================================

      case 'agent_start':
        // After an auto-retry backoff the SDK re-runs the turn via
        // agent.continue(); this agent_start is the retried run. Stop waiting
        // for it and let the run flow through normally.
        if (this.retryState === 'backoff') {
          this.cancelRetryFallbackTimer();
          this.retryState = 'recovering';
          this.heldRetryError = null;
          yield { type: 'retry', phase: 'active' };
        }
        break;

      case 'agent_end': {
        // Overflow recovery: hold the queue open while the SDK runs
        // _runAutoCompaction("overflow") + agent.continue(). The recovered
        // turn will arrive as a fresh agent_start … agent_end pair.
        if (this.overflowState === 'held') {
          this.overflowState = 'awaiting';
          this.armOverflowFallbackTimer();
          // The draft final reply (if any) must not linger as a "done" bubble
          // while the SDK's overflow-compaction + continuation turn is still
          // running — fold it into the process block.
          yield* this.demoteDraftReplyForHold();
          break;
        }
        if (this.overflowState === 'awaiting' || this.overflowState === 'compacting') {
          // Defensive: an agent_end while still mid-recovery shouldn't happen
          // in the SDK's normal flow. Keep the queue open and wait for
          // compaction_end (success → recovering, error → drain).
          break;
        }
        if (this.overflowState === 'recovering') {
          // Recovered turn just finished — fall through to normal completion.
          this.overflowState = 'none';
        }
        // Read once — both retry lanes below key off the same SDK annotation.
        const willRetry = (event as { willRetry?: boolean }).willRetry === true;

        // --- Subprocess auto-retry lane (local) ----------------------------
        // willRetry:true with a buffered subprocess error — hold the queue open
        // for the retried turn and surface nothing yet; the deferred error only
        // reports if the retry NEVER succeeds (terminal agent_end, or
        // auto_retry_end failure on abort).
        if (willRetry && this.deferredRetryError) {
          this.retryHoldActive = true;
          break;
        }
        this.retryHoldActive = false;
        // Terminal agent_end (willRetry false/absent): surface a buffered
        // deferred error exactly once, right before the complete event —
        // this is the ONLY point a deferred retryable error reaches the UI.
        if (this.deferredRetryError) {
          const buffered = this.deferredRetryError;
          this.deferredRetryError = null;
          this.hasEmittedTerminalError = true;
          yield buffered.parsed
            ? { type: 'typed_error', error: buffered.parsed }
            : { type: 'error', message: buffered.message };
        }
        // Defense resume (pi-agent-server defense layer): the subprocess
        // annotates the FIRST agent_end with defenseResumePending=true when it
        // queued a followUp() that continues the SAME turn after this event.
        // Hold the queue open — mirroring overflow recovery — and DO NOT emit
        // `complete` here, or the UI would mark the turn done and then receive
        // the resumed turn's events out of order. The FINAL agent_end (no flag)
        // falls through to normal completion below.
        if ((event as { defenseResumePending?: boolean }).defenseResumePending) {
          this.defenseResumeHeld = true;
          // The resume continues this SAME turn — fold the draft into the
          // process block; the resumed continuation's reply is the only final.
          yield* this.demoteDraftReplyForHold();
          break;
        }
        this.defenseResumeHeld = false;
        // Program-side verification (pi-agent-server, 2026-10-02 redesign):
        // the subprocess annotated this agent_end with
        // defenseVerificationPending=true when it captured the final reply and
        // dispatched an async LLM verification (doVerificationCheck). There is
        // NO resumed turn ahead — the queue stays open until the subprocess
        // reports verification_result; the main process then finalizes the
        // hold (passed → replay + complete, failed → followUp continues).
        if ((event as { defenseVerificationPending?: boolean }).defenseVerificationPending) {
          this.verificationHeld = true;
          this.verificationReplayTurnId = this.lastFinalTextTurnId;
          // The draft reply already shown at the main turn's end must not coexist
          // with the verified replay (or the follow-up continuation) — demote it
          // into the process block so the turn ends with a SINGLE final bubble.
          if (this.lastFinalTextTurnId) {
            yield { type: 'text_demote', turnId: this.lastFinalTextTurnId };
            this.lastFinalTextTurnId = null;
          }
          break;
        }
        this.verificationHeld = false;
        // Queued steering/followUp continuation (pi-agent-server): the
        // subprocess annotated this agent_end with queuedFollowUpPending=true
        // because pendingMessageCount > 0 — the SDK's _handlePostAgentRun
        // will agent.continue() AFTER this event. Hold the queue open for the
        // continuation turn; its FINAL agent_end (no flag) completes below.
        if ((event as { queuedFollowUpPending?: boolean }).queuedFollowUpPending) {
          this.queuedFollowUpHeld = true;
          if (this.defenseResumeHeld || this.verificationHeld) {
            // fleet-mist: a defense/verification stop text is a process step
            // — demote it and remember it for re-promotion once the hold
            // releases.
            yield* this.demoteDraftReplyForHold();
            if (this.lastEmittedFinalText && !this.defenseResumeHeld && !this.verificationHeld) {
              this.queuedHoldDemotedReply = this.lastEmittedFinalText;
            }
          } else {
            // 2026-10-07 plain-jade: pure queued steer — the main reply
            // STAYS a result bubble (it was emitted as final before the steer
            // was queued, or with the hold opening). No demotion, no
            // re-promotion; just release the one-final gate so the drain
            // round's reply can claim it.
            this.hasEmittedFinalText = false;
            this.lastFinalTextTurnId = null;
            this.lastEmittedFinalText = null;
          }
          break;
        }
        this.queuedFollowUpHeld = false;
        // --- SDK retry lane (upstream) -------------------------------------
        // Runs LAST so the local subprocess lane above wins when it owns the
        // retry (a buffered deferred error). AgentSession stamps `willRetry` on
        // agent_end (`_willRetryAfterAgentEnd`); when true `_prepareRetry`
        // follows with auto_retry_start, sleeps the backoff and re-runs the
        // turn, so this agent_end is NOT the end of the Craft turn.
        if (willRetry && this.retryState !== 'awaitingRetry' && this.retryState !== 'backoff') {
          this.retryState = 'awaitingRetry';
          this.armRetryFallbackTimer(
            RETRY_START_FALLBACK_TIMEOUT_MS,
            'no auto_retry_start followed agent_end { willRetry: true }',
          );
          // The SDK re-runs the turn — the draft is not final; demote it.
          yield* this.demoteDraftReplyForHold();
          break;
        }
        if (this.retryState === 'awaitingRetry' || this.retryState === 'backoff') {
          // Defensive: no agent run is active in these states, so an agent_end
          // is unexpected. Keep the queue open; the fallback timer drains it.
          break;
        }
        if (this.retryState === 'held') {
          // Retries disabled or exhausted: surface the parked error, then
          // complete the turn normally below.
          yield* this.releaseHeldRetryError();
        } else if (this.retryState === 'recovering') {
          // The retried run finished cleanly.
          this.retryState = 'none';
        }
        if (this.lastUsage && this.lastContextTokens > 0) {
          // Report the last REAL context size. Using `lastUsage.input` here would
          // report 0 for a turn whose final message failed/aborted, persisting a
          // 0 that the UI renders as 0% until a later turn succeeds.
          const inputTokens = this.lastContextTokens;
          yield {
            type: 'complete',
            usage: {
              inputTokens,
              outputTokens: this.lastUsage.output,
              cacheReadTokens: this.lastUsage.cacheRead,
              cacheCreationTokens: this.lastUsage.cacheWrite,
              costUsd: this.lastUsage.cost.total,
              contextWindow: this.contextWindow,
            },
          };
        } else {
          yield { type: 'complete' };
        }
        break;
      }

      // ============================================================
      // Turn events
      // ============================================================

      case 'turn_start':
        // Pi SDK turn_start has no ID, so generate one for event correlation
        this.currentTurnId = `pi-turn-${this.turnIndex}`;
        break;

      case 'turn_end':
        // Don't emit 'complete' here — agent_end handles it.
        // Emitting from both causes duplicate messages in session persistence.
        this.currentTurnId = null;
        this.hasStreamedDeltas = false;
        this.hasEmittedFinalText = false;
        // Keep sub-turn IDs unique across SDK turns/retries within this Craft
        // turn. startTurn() is the only place the counter resets.
        this.messageSubTurnId = null;
        break;

      // ============================================================
      // Message events (text streaming)
      // ============================================================

      case 'message_start': {
        // Pi SDK emits message_start for user messages too.
        const startMsg = event.message as { role?: string; id?: string } | undefined
        if (startMsg?.role === 'assistant') {
          this.messageStartAt = Date.now()
        } else if (startMsg?.role === 'user') {
          // 2026-10-07 plain-jade: this is the moment a spliced
          // steer/follow-up message actually enters the agent's context
          // (drain time). The main process re-stamps the pending guidance
          // row to this moment.
          yield { type: 'steer_injected', messageId: startMsg.id }
        }
        break
      };

      case 'message_update': {
        // Pi SDK emits message_update only for assistant messages (streaming deltas)
        const amEvent: AssistantMessageEvent = event.assistantMessageEvent;
        if (amEvent.type === 'text_delta' && amEvent.delta) {
          this.hasStreamedDeltas = true;
          if (!this.messageSubTurnId) {
            this.messageSubTurnId = this.nextSubTurnId('m');
          }
          yield {
            type: 'text_delta',
            text: amEvent.delta,
            turnId: this.messageSubTurnId,
          };
        }
        break;
      }

      case 'message_end': {
        // Pi SDK emits message_end for ALL messages (user, assistant, toolResult).
        // Only process assistant messages — skip user prompts and tool results.
        const msg = event.message as { role?: string; stopReason?: string; errorMessage?: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: { total: number } }; id?: string } | undefined;
        // SDK message id, set by pi-agent-server when forwarding the event.
        // SessionManager uses this to correlate the follow-up `pi_turn_anchor`
        // event to the Craft assistant message created here (#782).
        const sdkMessageId = (event as { sdkMessageId?: string }).sdkMessageId ?? msg?.id;
        if (msg?.role !== 'assistant') break;

        // A NON-error assistant message_end means the SDK's auto-retry has
        // recovered (the retried turn is producing real content). The buffered
        // deferred error is obsolete now — drop it so it can never surface at
        // a later terminal (mirrors the SDK resetting _retryAttempt on success).
        if (msg.stopReason !== 'error' && this.deferredRetryError) {
          this.deferredRetryError = null;
          this.retryHoldActive = false;
        }

        // Surface API errors — Pi SDK sets stopReason: 'error' and errorMessage on failures
        if (msg.stopReason === 'error' && msg.errorMessage) {
          // Failed streams never become text_complete. Explicitly discard the
          // partial before the SDK can retry (or terminate), including any
          // pending server-side delta batch. Completed messages are untouched.
          if (this.messageSubTurnId) {
            yield { type: 'text_discard', turnId: this.messageSubTurnId };
            this.messageSubTurnId = null;
            this.hasStreamedDeltas = false;
          }
          // Context overflow: hand recovery to the SDK's _runAutoCompaction
          // and keep the UI quiet until we know the outcome (recovered turn
          // arrives, or compaction fails). Suppress the raw provider error.
          if (
            this.overflowState === 'none' &&
            isContextOverflow(event.message as AssistantMessage, this.contextWindow)
          ) {
            this.overflowState = 'held';
            this.heldOverflowError = msg.errorMessage;
            break;
          }

          // --- Retry lane (upstream Pi SDK) --------------------------------
          // The SDK's retry loop uses this same `isRetryableAssistantError`
          // classifier, so it will retry unless retries are disabled or
          // exhausted — and the following agent_end { willRetry } says which.
          // Park the error instead of surfacing it now; agent_end either
          // releases it or holds the queue open for the retried run.
          const errorEvent = this.classifyAssistantError(event.message as AssistantMessage, msg.errorMessage);
          if (
            (this.retryState === 'none' || this.retryState === 'recovering') &&
            isRetryableAssistantError(event.message as AssistantMessage)
          ) {
            this.retryState = 'held';
            this.heldRetryError = errorEvent;
            break;
          }

          // Classify the error — auth/billing errors should be typed so SessionManager
          // can trigger its auth-retry pipeline (refresh token + resend).
          const parsed = parseError(new Error(msg.errorMessage));
          const isClassified = parsed.code !== 'unknown_error';
          this.hasEmittedTerminalError = true;
          if (isClassified) {
            yield { type: 'typed_error', error: parsed };
          } else {
            yield { type: 'error', message: msg.errorMessage };
          }
          break;
        }

        // An aborted assistant message is only the truncated tail of a cancelled
        // run, not a delivered final reply. Discard any streamed partial and keep
        // the turn result-free so terminal UI state cannot surface it as an answer.
        if (msg.stopReason === 'aborted') {
          if (this.messageSubTurnId) {
            yield { type: 'text_discard', turnId: this.messageSubTurnId };
            this.messageSubTurnId = null;
            this.hasStreamedDeltas = false;
          }
          break;
        }

        // Extract text content from the final assistant message
        const textContent = this.extractTextFromMessage(event.message);

        // Surface the model's reasoning/thinking as a process step. Reasoning
        // channels (deepseek-v4-flash via discovery-api.intern-ai.org.cn) put
        // nearly all their narrative into the 'thinking' content block and emit
        // little visible text between tool calls, so the UI would otherwise show
        // nothing while the model works (2026-10-04 d4f "invisible process").
        const thinking = this.extractThinkingFromMessage(event.message);
        if (thinking) {
          yield {
            type: 'text_complete',
            text: thinking,
            isIntermediate: true,
            turnId: this.nextSubTurnId('m'),
            // Thinking blocks don't stream deltas — start from message_start so
            // the UI's startedAt ordering matches what the user saw live.
            ...(this.messageStartAt ? { startedAt: this.messageStartAt } : {}),
          };
        }
        // Pi SDK stopReason: 'toolUse' means the model will call tools next (intermediate commentary),
        // 'stop'/'end_turn' means final response. Same logic as Claude's stop_reason === 'tool_use'.
        // Hold-open override (2026-10-04 fleet-mist user rule: a reply bubble
        // represents the turn's RESULT — the LAST message. While any hold is
        // open (defense resume / queued follow-up / verification in flight) the
        // turn keeps running, so this cycle's 'stop' text is a process step,
        // NEVER a result bubble — even when the resumed cycle did new tool
        // work (the 2026-10-01 two-reply discriminator was the inverse: it
        // kept tool-work continuations as visible cards, which the user
        // experienced as result bubbles appearing mid-process).
        // The drained continuation's OWN terminal stop (no pending left,
        // released below) is the single result bubble; the FINAL agent_end
        // (no flag) completes the queue.
        // Persisted isIntermediate keeps reload consistent with the live view.
        // (toolUse replies are intermediate unconditionally.)
        // Mid-turn follow-up continuation (2026-10-05 smooth-gorge): the
        // subprocess stamps `assistantFollowUpPending` when the SDK's
        // steering/followUp queues still hold messages at message_end — the
        // SDK injects them via agent.continue() AFTER this message (same
        // turn, no new turn_start) and the agent_end-side pendingMessageCount
        // check can never fire (queues drained by then). `queue_update`
        // non-empty is the backup signal. While either is true the stop text
        // is a PROCESS STEP, never a result bubble (same fleet-mist rule as
        // the holds below); the queue stays open until the FINAL `agent_end`
        // (no flag) completes the turn.
        //
        // Hold RELEASE (2026-10-07 active-wren incident: guidance “你叫什么
        // 名字” queued as a user steer mid-turn; the SDK drained it and its
        // answer — the turn's ACTUAL result — was still demoted to a process
        // line, so no reply bubble was ever shown (“没有回复，然后中断了”)).
        // The holds are SET only; a sticky queuedFollowUpHeld from an
        // annotated stop (or a non-empty queue_update) survived through the
        // drained continuation's own final reply, demoting it. The design's
        // “FINAL agent_end emits the result bubble” was never implementable
        // (the bubble is emitted at message_end; the final agent_end only
        // completes the queue). So RELEASE queuedFollowUpHeld the moment a
        // terminal stop with NO pending signal arrives: the SDK stamps
        // assistantFollowUpPending while drains remain and its queue_update
        // goes empty when the last queued message is consumed, so “terminal
        // stop + nothing pending” is the turn's LAST reply → the result
        // bubble.
        // ONLY queuedFollowUpHeld is released: a defense follow-up sets
        // defenseResumePending/verificationPending too, so defenseResumeHeld /
        // verificationHeld stay set and keep the fleet-mist demotion (a
        // program-side re-delivery is a process step, never a duplicate
        // bubble). A pure user-steer drain sets queuedFollowUpHeld alone, so
        // releasing it promotes the steer's answer to the result bubble.
        const pendingFollowUpNow =
          (event as { assistantFollowUpPending?: boolean }).assistantFollowUpPending === true ||
          this.queuePendingNonEmpty;
        if (pendingFollowUpNow) {
          this.queuedFollowUpHeld = true;
        } else if (msg.stopReason !== 'toolUse') {
          // Terminal stop, nothing pending: the queued steer/follow-up drain is
          // complete — this message is the turn's result. Release the queued-
          // follow-up hold so it is NOT demoted below. (Defense/verification
          // holds are untouched — see the rule above.)
          this.queuedFollowUpHeld = false;
          // Re-promotion (2026-10-07 wise-horizon): if a MAIN reply was
          // demoted to the process card for this hold, bring it back as a
          // result bubble now that the drain is complete — otherwise only the
          // steer's answer would be visible and the user's original answer
          // would be buried. Defense/verification holds keep fleet-mist
          // behavior: no re-promotion.
          if (
            this.queuedHoldDemotedReply &&
            !this.defenseResumeHeld &&
            !this.verificationHeld
          ) {
            const promoted = this.queuedHoldDemotedReply;
            this.queuedHoldDemotedReply = null;
            yield { type: 'text_promote', turnId: promoted.turnId, text: promoted.text };
          }
        }
        // A hold that opens JUST NOW (pendingFollowUpNow) must not demote the
        // reply that finished — it stays a result bubble, shown the moment it
        // appears; the drain round's own reply becomes the second bubble
        // (2026-10-07 plain-jade request). An already-open hold (drain in
        // flight) or a defense/verification hold still demotes as before.
        const isIntermediate =
          msg.stopReason === 'toolUse' ||
          this.defenseResumeHeld ||
          (this.queuedFollowUpHeld && !pendingFollowUpNow) ||
          this.verificationHeld;
        // Whitespace-only "final" text (\n\n after a thinking-only stop, 2026-10-03
        // blank-message incident: 585 blank messages persisted into session.jsonl)
        // is NOT a reply — skip it entirely. A truly empty stop is still caught by
        // the post-stop defense (endsWithEmptyResponse) — it keys off the SDK
        // message itself, not this event.
        const hasVisibleText = (textContent ?? '').trim().length > 0;
        if (hasVisibleText && (isIntermediate || !this.hasEmittedFinalText)) {
          const mTurnId = this.messageSubTurnId || this.nextSubTurnId('m');
          this.messageSubTurnId = null;
          if (!isIntermediate) {
            if (pendingFollowUpNow) {
              // This reply stays a result bubble, but the drain round's reply
              // must ALSO be allowed to claim the final slot — release the
              // one-final gate instead of claiming it (the active-wren
              // zero-bubble lesson). No demote/promote bookkeeping needed:
              // nothing was demoted, so nothing gets re-promoted.
              this.hasEmittedFinalText = false;
              this.lastFinalTextTurnId = null;
              this.lastEmittedFinalText = null;
            } else {
              this.hasEmittedFinalText = true;
              this.lastFinalTextTurnId = mTurnId;
              this.lastEmittedFinalText = { turnId: mTurnId, text: String(textContent ?? '') };
            }
          } else if (
            this.queuedFollowUpHeld &&
            !this.defenseResumeHeld &&
            !this.verificationHeld &&
            msg.stopReason !== 'toolUse'
          ) {
            // Demoted main reply under a pure queued-follow-up hold (the steer
            // was queued mid-stream and this stop is a process step, not the
            // turn's result). Remember it — the drain's terminal stop will
            // re-promote it via `text_promote`.
            this.queuedHoldDemotedReply = { turnId: mTurnId, text: String(textContent ?? '') };
          }

          yield {
            type: 'text_complete',
            text: String(textContent ?? ''),
            isIntermediate,
            turnId: mTurnId,
            sdkMessageId,
          };
          this.hasStreamedDeltas = false;
        }

        // Emit usage_update if the assistant message includes REAL token usage.
        // A degenerate reading (all-zero usage on an error/aborted message) is
        // kept out of the UI and of `lastContextTokens`; the previous real
        // reading stands. Mirrors the SDK's own guard in pi-coding-agent
        // (`assistantMessage.stopReason === "error" || directContextTokens === 0`).
        if (msg.usage && typeof msg.usage.input === 'number') {
          this.lastUsage = msg.usage;
          // pi-ai defines `input` as the NON-cached portion of the prompt
          // (Anthropic: input_tokens; OpenAI: prompt - cacheRead - cacheWrite),
          // so the true context size is input + cacheRead + cacheWrite.
          // Omitting cacheWrite understates the context whenever a large share
          // of the prompt is being written to the cache (first call, model
          // switch, post-compaction), shrinking the context-usage ring.
          const inputTokens = msg.usage.input + (msg.usage.cacheRead || 0) + (msg.usage.cacheWrite || 0);
          if (inputTokens > 0) {
            this.lastContextTokens = inputTokens;
            yield {
              type: 'usage_update',
              usage: {
                inputTokens,
                contextWindow: this.contextWindow,
              },
            };
          }
        }
        break;
      }

      // ============================================================
      // Tool events
      // ============================================================

      case 'tool_execution_start': {
        const toolCallId = event.toolCallId;
        const toolName = this.resolveToolName(event.toolName);
        this.toolNames.set(toolCallId, toolName);

        // Normalize Pi field names to Claude Code format for UI compatibility
        // (diff stats, diff overlay, document routing all expect Claude Code format)
        const args = this.normalizeToolInput(toolName, (event.args ?? {}) as Record<string, unknown>);

        // For call_llm, fill in the default display model when the caller didn't
        // specify one — Pi's call_llm defaults to miniModel. We only fill the gap;
        // we never overwrite an explicit agent-provided model (that was the #596 bug).
        if (toolName.includes('call_llm') && this.miniModel && !args.model) {
          args.model = this.miniModel;
        }

        // Canonical metadata from subprocess event payload (interceptor/bridge-authoritative path).
        const eventMeta = this.extractToolMetadataFromEvent(event);

        // Backward-compatibility fallback: shared store (legacy side-channel),
        // with id canonicalization fallback for mixed call-id formats.
        const { meta: storedMeta, keyTried } = this.resolveStoredMetadata(toolCallId);

        // Last-resort fallback: args metadata if present.
        const argsIntent = typeof args._intent === 'string' ? args._intent : undefined;
        const argsDisplayName = typeof args._displayName === 'string' ? args._displayName : undefined;

        const intent = eventMeta?.intent
          || storedMeta?.intent
          || argsIntent
          || (typeof args.description === 'string' ? args.description : undefined);

        const displayName = eventMeta?.displayName
          || storedMeta?.displayName
          || argsDisplayName
          || this.getToolDisplayName(toolName);

        const metadataSource = eventMeta
          ? 'event'
          : storedMeta
            ? `store(${keyTried})`
            : (argsIntent || argsDisplayName)
              ? 'args'
              : (typeof args.description === 'string')
                ? 'description'
                : 'fallback';

        this.log.debug('Tool metadata resolution', {
          toolName,
          toolCallId,
          metadataSource,
          hasIntent: !!intent,
          hasDisplayName: !!displayName,
        });

        // Classify bash commands that are actually file reads
        if (toolName === 'Bash' && typeof args.command === 'string') {
          const readInfo = this.classifyReadCommand(toolCallId, args.command);
          if (readInfo) {
            yield this.createReadToolStart(
              toolCallId,
              readInfo,
              intent,
              'Read File',
            );
            break;
          }
        }

        yield this.createToolStart(
          toolCallId,
          toolName,
          args,
          intent,
          displayName,
        );
        break;
      }

      case 'tool_execution_update': {
        // Accumulate partial output for streaming tool results
        const partialResult = event.partialResult;
        if (partialResult && typeof partialResult === 'object') {
          const content = (partialResult as { content?: Array<{ type: string; text?: string }> }).content;
          if (Array.isArray(content)) {
            for (const part of content) {
              if (part.type === 'text' && part.text) {
                this.accumulateOutput(event.toolCallId, part.text);
              }
            }
          }
        }
        break;
      }

      case 'tool_execution_end': {
        const toolCallId = event.toolCallId;
        const resolvedToolName = this.toolNames.get(toolCallId) || 'tool';
        this.toolNames.delete(toolCallId);

        // Check for block reason
        const blockReason = this.consumeBlockReason(toolCallId, resolvedToolName);

        // Use accumulated output from partial results if available
        const accumulatedOutput = this.consumeOutput(toolCallId);

        const isError = event.isError;
        let result: string;

        if (accumulatedOutput) {
          result = accumulatedOutput;
        } else if (blockReason) {
          result = blockReason;
        } else {
          result = this.extractToolResult(event.result, isError);
        }

        // After tool completion, the assistant may generate new text
        this.hasEmittedFinalText = false;
        this.messageSubTurnId = null;

        // Check if this was classified as a file read
        const readInfo = this.consumeReadCommand(toolCallId);
        if (readInfo) {
          yield this.createToolResult(toolCallId, 'Read', result, isError);
          break;
        }

        yield this.createToolResult(toolCallId, resolvedToolName, result, isError);
        break;
      }

      // ============================================================
      // Session-level events (AgentSessionEvent extensions)
      // ============================================================

      case 'compaction_start':
        // Cancel the overflow fallback timer — the SDK is now actively
        // recovering, so we no longer need the "no compaction event arrived"
        // safety net. State transitions: held|awaiting → compacting.
        if (this.overflowState === 'held' || this.overflowState === 'awaiting') {
          this.cancelOverflowFallbackTimer();
          this.overflowState = 'compacting';
        }
        // Use "Compacting" keyword so session handler detects statusType: 'compacting'
        yield { type: 'status', message: 'Compacting context...' };
        break;

      case 'compaction_end': {
        const compactionEvent = event as Extract<AgentSessionEvent, { type: 'compaction_end' }>;
        if (compactionEvent.result && !compactionEvent.aborted) {
          // Success: stay open and wait for the recovered agent_end. State
          // transitions: compacting → recovering. Threshold-only compactions
          // (state was 'none') just emit the info and continue normally.
          if (this.overflowState === 'compacting') {
            this.overflowState = 'recovering';
            this.heldOverflowError = null;
          }
          // Use "Compacted" keyword so session handler detects statusType: 'compaction_complete'
          yield { type: 'info', message: 'Compacted context to fit within limits' };
          // Refresh the context-usage ring immediately: the pre-compaction
          // reading is now stale, and the SDK reports the post-compaction
          // size (estimate) in the CompactionResult.
          const postTokens = compactionEvent.result.estimatedTokensAfter;
          if (typeof postTokens === 'number' && postTokens > 0) {
            this.lastContextTokens = postTokens;
            yield {
              type: 'usage_update',
              usage: {
                inputTokens: postTokens,
                contextWindow: this.contextWindow,
              },
            };
          }
        } else if (compactionEvent.errorMessage) {
          // Defensive handler for the Pi SDK auto-compaction race (cause A
          // in plans/fix-pi-gpt-compaction.md). The raw stack
          // `undefined is not an object (evaluating 'this._autoCompactionAbortController.signal')`
          // is unhelpful to the user; convert it to a friendly retry hint and
          // log for diagnostics. Remove once the upstream fix ships.
          if (SDK_AUTOCOMPACT_RACE_SIGNATURE.test(compactionEvent.errorMessage)) {
            this.log.warn('Pi SDK auto-compaction race; recommend manual /compact', {
              errorMessage: compactionEvent.errorMessage,
            });
            yield {
              type: 'error',
              message: 'Auto-compaction hit a transient error. Try /compact manually.',
            };
          } else {
            yield {
              type: 'error',
              message: `Context compaction failed: ${compactionEvent.errorMessage}`,
            };
          }
          // If we were holding the queue open for overflow recovery, finalize
          // the turn now — no recovered agent_end will arrive on the failure
          // path. pendingQueueComplete signals the caller to terminate the
          // iterator since this is a non-agent_end event.
          if (
            this.overflowState === 'compacting' ||
            this.overflowState === 'awaiting' ||
            this.overflowState === 'held'
          ) {
            yield { type: 'complete' };
            this.pendingQueueComplete = true;
            this.overflowState = 'none';
            this.heldOverflowError = null;
            this.cancelOverflowFallbackTimer();
          }
        }
        break;
      }

      case 'auto_retry_start': {
        const retryEvent = event as Extract<AgentSessionEvent, { type: 'auto_retry_start' }>;
        // The SDK is about to sleep `delayMs` and re-run the turn. Keep the
        // queue open until the retried run's agent_start arrives (plus grace).
        const delayMs = typeof retryEvent.delayMs === 'number' ? retryEvent.delayMs : 0;
        this.cancelRetryFallbackTimer();
        this.retryState = 'backoff';
        this.armRetryFallbackTimer(delayMs + RETRY_RUN_GRACE_MS, 'retried run did not start after the announced backoff');
        const attempt = `attempt ${retryEvent.attempt}/${retryEvent.maxAttempts}`;
        const wait = delayMs > 0 ? ` in ${Math.max(1, Math.round(delayMs / 1000))}s` : '';
        yield {
          type: 'retry',
          phase: 'backoff',
          message: `${this.retryReasonLabel(retryEvent.errorMessage)}. Retrying${wait} (${attempt})...`,
          attempt: retryEvent.attempt ?? 0,
          nextRetryInMs: delayMs,
        };
        break;
      }

      case 'auto_retry_end': {
        const retryEndEvent = event as Extract<AgentSessionEvent, { type: 'auto_retry_end' }>;
        // A retry run that produced an answer: close the retry indicator and,
        // when it took more than one attempt, say so. Nothing is held here —
        // the run's own agent_end still follows.
        if (retryEndEvent.success) {
          yield { type: 'retry', phase: 'end', recovered: true, attempt: retryEndEvent.attempt ?? 0 };
          const recoveredAfter = retryEndEvent.attempt;
          if (recoveredAfter > 0) {
            yield {
              type: 'info',
              message: `Recovered after ${recoveredAfter} ${recoveredAfter === 1 ? 'retry' : 'retries'}`,
            };
          }
          break;
        }
        if (
          this.retryState === 'held' ||
          this.retryState === 'awaitingRetry' ||
          this.retryState === 'backoff'
        ) {
          // The retry was cancelled (abort during backoff) or never ran while
          // we were still holding the turn open. No agent_end follows on this
          // path, so surface the parked error and finalize the turn here.
          this.cancelRetryFallbackTimer();
          if (this.heldRetryError) {
            yield* this.releaseHeldRetryError();
          } else {
            this.retryState = 'none';
            yield { type: 'retry', phase: 'end', recovered: false, attempt: retryEndEvent.attempt ?? 0 };
            if (retryEndEvent.finalError) {
              yield { type: 'error', message: `Retry failed: ${retryEndEvent.finalError}` };
            }
          }
          yield { type: 'complete' };
          this.pendingQueueComplete = true;
          break;
        }
        // Exhaustion ordering: the final agent_end { willRetry: false } already
        // released the parked error and completed the turn; this trailing
        // event describes the same failure. Stay quiet so the user gets one
        // error, not two.
        break;
      }

      case 'queue_update': {
        // Queue contents signal (2026-10-05): while the SDK's steering or
        // followUp queues are non-empty, any stop text still in flight is a
        // process step (a queued message will be injected via
        // agent.continue() after agent_end). Previously ignored — the queues
        // were "reflected by session/message state", but that gave the
        // adapter no advance warning before it rendered a fake final bubble.
        const qe = event as unknown as { steering?: unknown[]; followUp?: unknown[] };
        const steering = Array.isArray(qe.steering) ? qe.steering : [];
        const followUp = Array.isArray(qe.followUp) ? qe.followUp : [];
        this.queuePendingNonEmpty = steering.length > 0 || followUp.length > 0;
        if (this.queuePendingNonEmpty) {
          this.queuedFollowUpHeld = true;
        }
        break;
      }

      case 'agent_settled':
      case 'entry_appended':
      case 'session_info_changed':
      case 'thinking_level_changed':
      case 'bash_execution_update':
      case 'summarization_retry_scheduled':
      case 'summarization_retry_attempt_start':
      case 'summarization_retry_finished':
        // Session bookkeeping and compaction/branch-summary retry telemetry
        // (Pi SDK 0.84+/0.85). Compaction progress already surfaces through
        // compaction_start/compaction_end; nothing to show for these.
        break;

      default:
        this.log.warn(`Unknown Pi event type: ${(event as { type: string }).type}`);
        break;
    }
  }

  // ============================================================
  // Helpers
  // ============================================================

  /**
   * Extract canonical tool metadata from enriched tool_execution_start events.
   * This is the interceptor-authoritative path emitted by pi-agent-server.
   */
  private extractToolMetadataFromEvent(event: PiEvent): { intent?: string; displayName?: string } | undefined {
    const metadata = (event as {
      toolMetadata?: { intent?: unknown; displayName?: unknown };
    }).toolMetadata;

    if (!metadata) return undefined;

    const intent = typeof metadata.intent === 'string' ? metadata.intent : undefined;
    const displayName = typeof metadata.displayName === 'string' ? metadata.displayName : undefined;

    if (!intent && !displayName) return undefined;
    return { intent, displayName };
  }

  /**
   * Resolve stored metadata by tool call id with fallback variants.
   * Handles mixed id forms like `call_xxx|fc_yyy` by trying the base id.
   */
  private resolveStoredMetadata(toolCallId: string): { meta?: { intent?: string; displayName?: string }; keyTried?: string } {
    const candidates = new Set<string>([toolCallId]);
    if (toolCallId.includes('|')) {
      const [base] = toolCallId.split('|');
      if (base) candidates.add(base);
    }

    for (const candidate of candidates) {
      const meta = toolMetadataStore.get(candidate, this.sessionDir);
      if (meta) return { meta, keyTried: candidate };
    }

    return { meta: undefined, keyTried: Array.from(candidates).join(' -> ') };
  }

  /**
   * Normalize Pi SDK tool input field names to Claude Code format.
   * Pi uses camelCase (oldText, newText, path) while Claude Code uses
   * snake_case (old_string, new_string, file_path). The UI pipeline expects
   * Claude Code format for diff computation, overlay rendering, and
   * document type detection.
   */
  private normalizeToolInput(
    toolName: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    if (toolName === 'Edit') {
      const normalized = { ...args };
      if ('path' in normalized && !('file_path' in normalized)) {
        normalized.file_path = normalized.path;
        delete normalized.path;
      }

      // Pi SDK >= 0.63.2 uses edits[] array instead of top-level oldText/newText.
      // Preserve the full edits[] payload so the renderer can expand and display
      // every replacement block. Also derive the first edit into flat old/new
      // fields as a compatibility bridge for UI paths that still expect them.
      const edits = normalized.edits as Array<{ oldText?: string; newText?: string }> | undefined;
      if (Array.isArray(edits) && edits.length > 0 && edits[0]) {
        const first = edits[0];
        if (first.oldText != null && !('old_string' in normalized)) {
          normalized.old_string = first.oldText;
        }
        if (first.newText != null && !('new_string' in normalized)) {
          normalized.new_string = first.newText;
        }
      }

      // Legacy path: top-level oldText/newText (Pi SDK < 0.63.2 or resumed sessions)
      if ('oldText' in normalized && !('old_string' in normalized)) {
        normalized.old_string = normalized.oldText;
        delete normalized.oldText;
      }
      if ('newText' in normalized && !('new_string' in normalized)) {
        normalized.new_string = normalized.newText;
        delete normalized.newText;
      }
      return normalized;
    }

    if (toolName === 'Write') {
      const normalized = { ...args };
      if ('path' in normalized && !('file_path' in normalized)) {
        normalized.file_path = normalized.path;
        delete normalized.path;
      }
      return normalized;
    }

    if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') {
      const normalized = { ...args };
      if ('path' in normalized && !('file_path' in normalized)) {
        normalized.file_path = normalized.path;
        delete normalized.path;
      }
      return normalized;
    }

    return args;
  }

  /**
   * Resolve Pi tool name to PascalCase for UI consistency.
   * Pi tools use lowercase names (read, write, edit, bash, grep, find, ls).
   */
  private resolveToolName(rawName: string): string {
    return PI_TOOL_NAME_MAP[rawName] || rawName;
  }

  /**
   * Extract text content from a Pi AgentMessage.
   * Pi messages use the pi-ai Message format with content arrays.
   */
  private extractTextFromMessage(message: unknown): string | null {
    if (!message || typeof message !== 'object') return null;

    const msg = message as {
      role?: string;
      content?: string | Array<{ type: string; text?: string }>;
    };

    if (typeof msg.content === 'string') {
      return msg.content || null;
    }

    if (Array.isArray(msg.content)) {
      const textParts = msg.content
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text!);
      return textParts.length > 0 ? textParts.join('') : null;
    }

    return null;
  }

  /**
   * Extract the model's reasoning/thinking content from a Pi AgentMessage.
   * Reasoning channels carry their analysis in a `thinking` content block
   * (pi-ai Message format); it is surfaced as a process step so reasoning
   * models don't appear frozen while they work. Truncated to keep session
   * persistence bounded (thinking blocks can be tens of thousands of chars).
   */
  private extractThinkingFromMessage(message: unknown): string | null {
    if (!message || typeof message !== 'object') return null;

    const msg = message as {
      content?: string | Array<{ type: string; thinking?: string }>;
    };

    if (typeof msg.content === 'string' || !Array.isArray(msg.content)) return null;

    const parts = msg.content
      .filter((c) => c.type === 'thinking' && c.thinking)
      .map((c) => c.thinking!);
    if (parts.length === 0) return null;

    const joined = parts.join('');
    const MAX_THINKING_CHARS = 2000;
    return joined.length <= MAX_THINKING_CHARS
      ? joined
      : `${joined.slice(0, MAX_THINKING_CHARS)}…`;
  }

  /**
   * Extract a string result from Pi tool execution result.
   */
  private extractToolResult(result: unknown, isError: boolean): string {
    if (!result) {
      return isError ? 'Tool execution failed' : 'Success';
    }

    if (typeof result === 'string') return result;

    // Pi tool results follow the AgentToolResult shape: { content: [...], details: ... }
    const typed = result as {
      content?: Array<{ type: string; text?: string }>;
      details?: unknown;
    };

    if (Array.isArray(typed.content)) {
      const texts = typed.content
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text!);
      if (texts.length > 0) return texts.join('\n');
    }

    // Fall back to JSON
    try {
      return JSON.stringify(result);
    } catch {
      return String(result);
    }
  }

  /**
   * Get a human-readable display name for a tool.
   */
  private getToolDisplayName(toolName: string): string | undefined {
    switch (toolName) {
      case 'Bash':
        return 'Run Command';
      case 'Read':
        return 'Read File';
      case 'Write':
        return 'Write File';
      case 'Edit':
        return 'Edit File';
      case 'Glob':
      case 'Find':
        return 'Search Files';
      case 'Grep':
        return 'Search Content';
      case 'Ls':
        return 'List Directory';
      default:
        return undefined;
    }
  }
}
