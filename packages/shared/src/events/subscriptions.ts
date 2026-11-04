/**
 * Event subscriptions — who wants which events, and the rate guard between a
 * busy mailbox and an agent session.
 *
 * Three protections, all of them load-bearing:
 *   1. merge    — several events from one source within 5s become one message
 *   2. quota    — 50 deliveries per session per day, then one summary
 *   3. defer    — while a session is mid-turn the event waits; it never steers
 *
 * Storage: `<workspace>/config/event-subscriptions.json`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EventMeta } from './event-store.ts';

export interface SubscriptionFilter {
  sources?: string[];
  /** Supports a `mail.*` prefix form. */
  types?: string[];
}

export interface EventSubscription {
  subscriptionId: string;
  sessionId: string;
  filter: SubscriptionFilter;
  createdAt: number;
}

interface PersistedSubscriptions {
  version: 1;
  subscriptions: EventSubscription[];
}

export const MERGE_WINDOW_MS = 5000;
export const DAILY_LIMIT = 50;

function subscriptionsPath(workspaceRoot: string): string {
  return join(workspaceRoot, 'config', 'event-subscriptions.json');
}

export function loadSubscriptions(workspaceRoot: string): EventSubscription[] {
  const path = subscriptionsPath(workspaceRoot);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PersistedSubscriptions;
    return Array.isArray(parsed?.subscriptions) ? parsed.subscriptions : [];
  } catch {
    return [];
  }
}

export function saveSubscriptions(workspaceRoot: string, subscriptions: EventSubscription[]): void {
  const path = subscriptionsPath(workspaceRoot);
  mkdirSync(dirname(path), { recursive: true });
  const payload: PersistedSubscriptions = { version: 1, subscriptions };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function matchesType(type: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith('.*')) return type.startsWith(pattern.slice(0, -1));
    return type === pattern;
  });
}

/** A filter whose fields are empty matches everything. */
export function matchesFilter(event: EventMeta, filter: SubscriptionFilter): boolean {
  if (filter.sources?.length && !filter.sources.includes(event.source)) return false;
  if (filter.types?.length && !matchesType(event.type, filter.types)) return false;
  return true;
}

/** Which session ids should receive this event. */
export function subscribersFor(event: EventMeta, subscriptions: EventSubscription[]): string[] {
  const ids = new Set<string>();
  for (const subscription of subscriptions) {
    if (matchesFilter(event, subscription.filter)) ids.add(subscription.sessionId);
  }
  return Array.from(ids);
}

/** The text a session receives. Kept short: it is injected into a live turn. */
export function formatEventNudge(event: EventMeta): string {
  const lines = [
    `[event] ${event.type} · ${event.source}`,
    event.title,
    `${new Date(event.occurredAt ?? event.receivedAt).toLocaleString()}${event.summary ? ` · ${event.summary}` : ''}`,
    `全文: get_event("${event.id}")`,
  ];
  return lines.join('\n');
}

/** Merge several events from one source into a single nudge. */
export function formatMergedNudge(events: EventMeta[]): string {
  if (events.length === 1) return formatEventNudge(events[0]!);
  const source = events[0]!.source;
  const shown = events.slice(0, 5);
  const rest = events.length - shown.length;
  const lines = [
    `[event] ${events.length} 条新事件 · ${source}`,
    ...shown.map((event) => `· ${event.title}（${event.type}）`),
    ...(rest > 0 ? [`…还有 ${rest} 条`] : []),
    `用 list_events({ source: "${source}" }) 查看`,
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

interface QuotaBucket {
  day: string;
  delivered: number;
  summarySent: boolean;
}

const quotas = new Map<string, QuotaBucket>();

function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export interface QuotaDecision {
  allowed: boolean;
  /** True when this call should send the one-off "quota reached" summary. */
  sendSummary: boolean;
}

export function checkQuota(sessionId: string, now = Date.now(), limit = DAILY_LIMIT): QuotaDecision {
  const bucket = quotas.get(sessionId);
  const today = dayKey(now);
  if (!bucket || bucket.day !== today) {
    quotas.set(sessionId, { day: today, delivered: 0, summarySent: false });
    return { allowed: true, sendSummary: false };
  }
  if (bucket.delivered < limit) return { allowed: true, sendSummary: false };
  if (!bucket.summarySent) {
    bucket.summarySent = true;
    return { allowed: true, sendSummary: true };
  }
  return { allowed: false, sendSummary: false };
}

export function recordDelivery(sessionId: string, now = Date.now()): void {
  const today = dayKey(now);
  const bucket = quotas.get(sessionId);
  if (!bucket || bucket.day !== today) {
    quotas.set(sessionId, { day: today, delivered: 1, summarySent: false });
    return;
  }
  bucket.delivered += 1;
}

export function formatQuotaSummary(source: string, limit = DAILY_LIMIT): string {
  return `[event] 今日事件投递已达上限（${limit} 条）。${source} 的后续事件仍在接收，可用 list_events 主动查看。`;
}

/** Test seam. */
export function resetQuotas(): void {
  quotas.clear();
}

// ---------------------------------------------------------------------------
// Merge window
// ---------------------------------------------------------------------------

/**
 * Coalesces events per (session, source) inside a 5s window. The caller feeds
 * events as they arrive and flushes on a timer.
 */
export class EventMerger {
  private readonly windows = new Map<string, { events: EventMeta[]; timer: NodeJS.Timeout }>();

  constructor(
    private readonly flush: (sessionId: string, events: EventMeta[]) => void,
    private readonly windowMs = MERGE_WINDOW_MS,
  ) {}

  push(sessionId: string, event: EventMeta): void {
    const key = `${sessionId}\u0000${event.source}`;
    const existing = this.windows.get(key);
    if (existing) {
      existing.events.push(event);
      return;
    }
    const timer = setTimeout(() => this.flushKey(key), this.windowMs);
    timer.unref?.();
    this.windows.set(key, { events: [event], timer });
  }

  private flushKey(key: string): void {
    const entry = this.windows.get(key);
    if (!entry) return;
    this.windows.delete(key);
    const [sessionId] = key.split('\u0000');
    this.flush(sessionId!, entry.events);
  }

  /** Flush everything now (app quit, tests). */
  flushAll(): void {
    for (const key of Array.from(this.windows.keys())) {
      clearTimeout(this.windows.get(key)?.timer);
      this.flushKey(key);
    }
  }
}
