/**
 * Event dispatcher — decides which sessions hear about an event and how.
 *
 * Sits between the store and the sessions so neither has to know about the
 * other. Three guards apply (merge / quota / defer), and delivery goes through
 * `SessionManager.surfaceEventToSession`, which reuses the background-task
 * surface (process row + `event_wake` title + hidden nudge). An event is never
 * steered into a running turn: unlike a background task, the agent is not
 * waiting for it.
 */

import { createLogger } from '@craft-agent/shared/utils';
import type { EventMeta } from '@craft-agent/shared/events/event-store.ts';
import {
  DAILY_LIMIT,
  EventMerger,
  checkQuota,
  formatEventNudge,
  formatMergedNudge,
  formatQuotaSummary,
  recordDelivery,
  subscribersFor,
  matchesFilter,
  type EventSubscription,
} from '@craft-agent/shared/events/subscriptions.ts';

const log = createLogger('events');

export interface DispatchTarget {
  /** Deliver to a session. Returns false when the session is gone/archived. */
  deliver: (
    sessionId: string,
    params: {
      eventId: string;
      source: string;
      type: string;
      title: string;
      summary?: string;
      receivedAt: number;
      nudge: string;
      /**
       * Called once the event is inside the session, before its turn runs.
       *
       * Delivery is recorded here rather than after `deliver` resolves, because the resolve
       * comes at the END of the turn: recording both facts at the same moment is what made
       * 「arrived」 and 「acted on」 indistinguishable in the first place.
       */
      onSurfaced?: () => void;
    },
  ) => Promise<boolean>;
  /** Queue for later when the session is mid-turn. */
  isBusy: (sessionId: string) => boolean;
  /** Sessions with user messages waiting — events yield to those. */
  hasQueuedUserMessage: (sessionId: string) => boolean;
  /**
   * Whether a session still exists.
   *
   * Thread bindings outlive sessions. Posting an event to a deleted session
   * would make it invisible — it was routed, so nothing else will retry it.
   */
  exists?: (sessionId: string) => boolean;
}

export interface EventDispatcherOptions {
  /** Reads the current subscriptions for the workspace. */
  getSubscriptions: () => EventSubscription[];
  target: DispatchTarget;
  /**
   * Last tier of the funnel: called only when no session subscribed to the
   * event. Wired to the on-duty supervisor; absent only in headless/test hosts
   * that intentionally collect events without session routing.
   */
  onUnclaimed?: (event: EventMeta) => void;
  mergeWindowMs?: number;
  dailyLimit?: number;
  /** Called when the event is inside a session and its turn is about to run. */
  onSurfaced?: (eventId: string, sessionId: string) => void;
  /**
   * Called when the turn that received the event has finished.
   *
   * The evidence that the event was handled rather than merely delivered, and the reason the old
   * boolean could not answer 「how was it handled」.
   */
  onHandled?: (eventId: string, sessionId: string) => void;
  /**
   * Thread ownership, consulted before subscriptions.
   *
   * Subscriptions match a *class* of event ("anything from qq"); a thread is one
   * conversation. Without this lookup the second message in the same group chat
   * became a fresh triage decision for the supervisor — a model turn per message,
   * each one competing with the per-turn cap.
   *
   * Returns the session already handling that conversation, if any. Absent in
   * hosts that do not persist bindings.
   */
  resolveThreadOwner?: (event: EventMeta) => string | undefined;
}

interface DeferredBatch {
  events: EventMeta[];
  reason: 'busy' | 'queued-user-message';
}

export class EventDispatcher {
  private readonly merger: EventMerger;
  private readonly deferred = new Map<string, DeferredBatch>();
  private readonly options: EventDispatcherOptions;

  constructor(options: EventDispatcherOptions) {
    this.options = options;
    this.merger = new EventMerger(
      (sessionId, events) => {
        void this.deliverBatch(sessionId, events);
      },
      options.mergeWindowMs,
    );
  }

  /**
   * Events already delivered or handed to the supervisor.
   *
   * One event must be handled exactly once: a subscription match and the
   * unclaimed tier are mutually exclusive by construction, but a re-insert of
   * the same dedupe key (a source retrying a webhook) is not.
   */
  private readonly routed = new Set<string>();

  /** Entry point: called for every inserted event. */
  dispatch(event: EventMeta): void {
    const key = event.dedupeKey || event.id;
    if (this.routed.has(key)) return;

    // Thread ownership outranks subscriptions: a conversation already being
    // handled continues with its owner, so a busy channel never re-enters
    // triage. This is the whole point — it costs no model call.
    const threadOwner = this.options.resolveThreadOwner?.(event);
    if (threadOwner) {
      this.routed.add(key);
      this.merger.push(threadOwner, event);
      return;
    }

    const subscriptions = this.options.getSubscriptions();
    const targets = subscriptions.length ? subscribersFor(event, subscriptions) : [];

    if (targets.length === 0) {
      // Tier 2 (rules) is resolved by whoever wired `onUnclaimed`: it can route
      // deterministically and only fall through to the supervisor itself.
      this.routed.add(key);
      this.options.onUnclaimed?.(event);
      return;
    }

    this.routed.add(key);
    for (const sessionId of targets) {
      // A session can hold several subscriptions; use the first that matches so
      // the nudge is formatted from a rule the session actually asked for.
      const subscription = subscriptions.find(
        (sub) => sub.sessionId === sessionId && matchesFilter(event, sub.filter),
      );
      if (!subscription) continue;
      this.merger.push(sessionId, event);
    }
  }

  private async deliverBatch(sessionId: string, events: EventMeta[]): Promise<void> {
    if (events.length === 0) return;

    const busy = this.options.target.isBusy(sessionId);
    const queuedUser = this.options.target.hasQueuedUserMessage(sessionId);

    // Defer rather than interrupt: pending user input always wins, and a
    // running turn keeps its context clean.
    if (busy || queuedUser) {
      const existing = this.deferred.get(sessionId);
      const reason: DeferredBatch['reason'] = queuedUser ? 'queued-user-message' : 'busy';
      if (existing) {
        existing.events.push(...events);
        existing.reason = reason;
      } else {
        this.deferred.set(sessionId, { events: [...events], reason });
      }
      log.info(`[events] deferring ${events.length} event(s) for ${sessionId} (${reason})`);
      return;
    }

    const limit = this.options.dailyLimit ?? DAILY_LIMIT;
    const quota = checkQuota(sessionId, Date.now(), limit);
    if (!quota.allowed) return;

    if (quota.sendSummary) {
      const source = events[0]?.source ?? 'listener';
      await this.deliverOne(sessionId, events[0]!, formatQuotaSummary(source, limit));
      return;
    }

    const nudge = events.length === 1 ? formatEventNudge(events[0]!) : formatMergedNudge(events);
    for (const event of events) {
      const delivered = await this.deliverOne(sessionId, event, nudge, events.length > 1);
      if (!delivered) break;
      this.options.onHandled?.(event.id, sessionId);
    }
  }

  private async deliverOne(
    sessionId: string,
    event: EventMeta,
    nudge: string,
    merged = false,
  ): Promise<boolean> {
    try {
      const surfaced = (): void => {
        recordDelivery(sessionId, Date.now());
        this.options.onSurfaced?.(event.id, sessionId);
      };
      return await this.options.target.deliver(sessionId, {
        eventId: event.id,
        source: event.source,
        type: event.type,
        title: event.title,
        ...(event.summary ? { summary: event.summary } : {}),
        receivedAt: event.receivedAt,
        onSurfaced: surfaced,
        // A merged batch shows one nudge per row; the row itself carries the
        // detail, so the extra text would only repeat.
        nudge: merged ? formatEventNudge(event) : nudge,
      });
    } catch (error) {
      log.warn(`[events] delivery to ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * Called when a session stops processing: release anything deferred for it.
   * Skips sessions that still have user messages queued (they get the floor).
   */
  flushDeferred(sessionId: string): void {
    const batch = this.deferred.get(sessionId);
    if (!batch) return;
    if (this.options.target.hasQueuedUserMessage(sessionId)) return;
    this.deferred.delete(sessionId);
    void this.deliverBatch(sessionId, batch.events);
  }

  /** Flush everything (app quit). */
  flushAll(): void {
    this.merger.flushAll();
    for (const [sessionId, batch] of this.deferred) {
      this.deferred.delete(sessionId);
      void this.deliverBatch(sessionId, batch.events);
    }
  }

  /** Pending count per session, for diagnostics. */
  pendingCounts(): Record<string, number> {
    return Object.fromEntries(Array.from(this.deferred, ([id, batch]) => [id, batch.events.length]));
  }
}
