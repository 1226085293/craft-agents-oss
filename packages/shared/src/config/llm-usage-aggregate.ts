/**
 * Aggregates the append-only usage log into the shapes the settings UI needs.
 *
 * Kept separate from the store so the read/parse rules live in one place and the
 * arithmetic is testable without touching the filesystem — the store is a
 * dependency injected here.
 *
 * Two conventions worth knowing before editing:
 *
 * - **A "success" is `status === 'success'`.** A 200 that still cost tokens is
 *   a success; a 5xx that burned a retry is not. `attempts > 1` marks retried
 *   requests, which is what the overview's three-colour stack bar splits on.
 * - **Percentiles are computed on firstByteMs of successful requests only.**
 *   Failed requests have no meaningful first byte and would drag P50 down.
 */

import type { LlmUsageRecord } from './llm-usage-store.ts';
import { isProbeKind } from './model-request-kind.ts';
import type { UsageDayBucket } from './llm-usage-buckets.ts';

export interface TokenTotals {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /** prompt + completion, i.e. what a provider actually bills. */
  totalTokens: number;
}

export interface OutcomeCounts {
  success: number;
  retried: number;
  failed: number;
}

export interface DailyPoint {
  /** YYYY-MM-DD in local time. */
  day: string;
  success: number;
  retried: number;
  failed: number;
  promptTokens: number;
  completionTokens: number;
  /** Cache-read prompt tokens; the 缓存复用 card's sparkline is this series. */
  cachedTokens: number;
}

export interface ProviderBreakdown {
  provider: string;
  requests: number;
  success: number;
  failed: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgFirstByteMs: number | null;
  /** Share of all requests, 0..1. */
  requestShare: number;
  /** Status of this provider's most recent record, when it has any. */
  lastStatus?: 'success' | 'error';
  /** Epoch ms of that record. */
  lastTs?: number;
  /** Distinct sessions that used this provider, excluding the empty one. */
  sessionCount: number;
}

export interface Overview {
  totals: TokenTotals;
  outcomes: OutcomeCounts;
  /** Share of requests that succeeded, 0..1. undefined when there are no requests. */
  successRate: number | null;
  firstByte: { p50: number | null; p95: number | null };
  /** Last 30 days, oldest first. Empty days are omitted rather than zero-filled. */
  daily: DailyPoint[];
  byProvider: ProviderBreakdown[];
  byStrategy: Array<{ strategy: string; requests: number; totalTokens: number }>;
  byModel: Array<{ upstreamModel: string; requests: number; totalTokens: number }>;
  /** Distinct session ids seen, excluding the empty one. */
  sessionCount: number;
}

export interface KeyRow {
  keyId: string;
  requests: number;
  success: number;
  failed: number;
  successRate: number | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgFirstByteMs: number | null;
  /** Per-key requests bucketed by local hour, for the provider health heatmap. */
  hourly: Array<{ hour: number; success: number; failed: number }>;
}

export interface ProviderDetail {
  provider: string;
  requests: number;
  outcomes: OutcomeCounts;
  successRate: number | null;
  totals: TokenTotals;
  keys: KeyRow[];
  /** Hour-of-day (0..23) x outcome matrix, for the health heatmap. */
  hourly: Array<{ hour: number; success: number; failed: number }>;
  daily: DailyPoint[];
  recent: LlmUsageRecord[];
}

// ============================================================================
// Helpers
// ============================================================================

function num(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank: the smallest value whose rank covers at least p of the data.
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index]!;
}

function localDay(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function emptyTotals(): TokenTotals {
  return { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0 };
}

function rate(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ============================================================================
// Time range (the overview page's global filter)
// ============================================================================

/**
 * A time window the overview aggregates over.
 *
 * The named buckets are local-calendar windows ("day" = today, "week" = the
 * current Monday-anchored week), matching what the bucketed bar chart draws.
 * An explicit `{fromTs, toTs}` covers a custom range.
 */
export type UsageRange =
  | 'day'
  | 'week'
  | 'month'
  | 'all'
  | { fromTs: number; toTs: number }

/** Resolve a range to a closed-open `[fromTs, toTs)` window. */
export function resolveUsageRange(
  range: UsageRange | undefined,
  now = Date.now(),
): { fromTs: number; toTs: number } {
  if (range && typeof range === 'object') {
    const fromTs = Math.min(range.fromTs, range.toTs);
    const toTs = Math.max(range.fromTs, range.toTs);
    return { fromTs, toTs };
  }
  const d = new Date(now);
  switch (range) {
    case 'day': {
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      return { fromTs: start, toTs: start + 24 * 60 * 60 * 1000 };
    }
    case 'week': {
      // Monday-anchored: rewind to the most recent Monday 00:00 local.
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      const weekday = (new Date(start).getDay() + 6) % 7; // Mon=0 … Sun=6
      const weekStart = start - weekday * 24 * 60 * 60 * 1000;
      return { fromTs: weekStart, toTs: weekStart + 7 * 24 * 60 * 60 * 1000 };
    }
    case 'month': {
      const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
      const nextMonth = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
      return { fromTs: start, toTs: nextMonth };
    }
    case 'all':
    case undefined:
    default:
      return { fromTs: Number.NEGATIVE_INFINITY, toTs: Number.POSITIVE_INFINITY };
  }
}

/** Keep only the records whose timestamp falls inside the resolved range. */
export function filterUsageByRange(
  records: readonly LlmUsageRecord[],
  range: UsageRange | undefined,
  now = Date.now(),
): LlmUsageRecord[] {
  const { fromTs, toTs } = resolveUsageRange(range, now);
  return records.filter((r) => r.ts >= fromTs && r.ts < toTs);
}

// ============================================================================
// Aggregates
// ============================================================================

/**
 * Build the overview from the daily buckets instead of raw records.
 *
 * Same shape as `aggregateOverview`, so the UI cannot tell the difference — the
 * difference is that this path survives request-detail logging being off.
 * Percentiles come from the bounded per-day samples (see llm-usage-buckets).
 */
export function aggregateFromBuckets(
  buckets: ReadonlyArray<UsageDayBucket>,
  range: UsageRange | undefined,
  now = Date.now(),
): Overview {
  const { fromTs, toTs } = resolveUsageRange(range, now)
  const dayStart = (day: string): number => {
    const [y, m, d] = day.split('-').map(Number)
    return new Date(y!, (m ?? 1) - 1, d ?? 1).getTime()
  }
  // Buckets are day-granular: include a day when it overlaps the window at all.
  // A sub-day range therefore rounds outward to whole days — the overview's
  // ranges are day-aligned anyway, and silently dropping a partial day would be
  // worse than counting it.
  const scoped = buckets.filter((b) => {
    const start = dayStart(b.day)
    return start < toTs && start + 86_400_000 > fromTs
  })

  const totals = emptyTotals()
  const outcomes: OutcomeCounts = { success: 0, retried: 0, failed: 0 }
  const firstBytes: number[] = []
  const daily: DailyPoint[] = []
  const sessions = new Set<string>()
  const providers = new Map<string, ProviderBreakdown & { sessionIds: Set<string> }>()
  const strategies = new Map<string, { requests: number; totalTokens: number }>()
  const models = new Map<string, { requests: number; totalTokens: number }>()

  for (const b of scoped) {
    totals.promptTokens += b.prompt
    totals.completionTokens += b.completion
    totals.cachedTokens += b.cached
    totals.totalTokens += b.prompt + b.completion
    outcomes.success += b.success
    outcomes.retried += b.retried
    outcomes.failed += b.failed
    for (const v of b.firstByteSamples) firstBytes.push(v)
    for (const id of b.sessions) sessions.add(id)

    daily.push({
      day: b.day,
      success: b.success,
      retried: b.retried,
      failed: b.failed,
      promptTokens: b.prompt,
      completionTokens: b.completion,
      cachedTokens: b.cached,
    })

    for (const [id, p] of Object.entries(b.providers)) {
      const acc = providers.get(id) ?? {
        provider: id,
        requests: 0,
        success: 0,
        failed: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        avgFirstByteMs: null,
        requestShare: 0,
        sessionCount: 0,
        sessionIds: new Set<string>(),
        firstByteSamples: [] as number[],
        firstByteSum: 0,
        firstByteCount: 0,
        lastTs: 0,
        lastStatus: undefined,
      } as ProviderBreakdown & { sessionIds: Set<string>; firstByteSamples: number[]; firstByteSum: number; firstByteCount: number }
      acc.requests += p.requests
      acc.success += p.success
      acc.failed += p.failed
      acc.promptTokens += p.prompt
      acc.completionTokens += p.completion
      acc.totalTokens += p.prompt + p.completion
      const extra = acc as unknown as { firstByteSum: number; firstByteCount: number }
      extra.firstByteSum += p.firstByteSum
      extra.firstByteCount += p.firstByteCount
      if (p.lastTs >= (acc.lastTs ?? 0)) {
        acc.lastTs = p.lastTs
        acc.lastStatus = p.lastStatus
      }
      for (const sid of p.sessions) acc.sessionIds.add(sid)
      providers.set(id, acc)
    }

    for (const [id, v] of Object.entries(b.strategies)) {
      const acc = strategies.get(id) ?? { requests: 0, totalTokens: 0 }
      acc.requests += v.requests
      acc.totalTokens += v.tokens
      strategies.set(id, acc)
    }
    for (const [id, v] of Object.entries(b.models)) {
      const acc = models.get(id) ?? { requests: 0, totalTokens: 0 }
      acc.requests += v.requests
      acc.totalTokens += v.tokens
      models.set(id, acc)
    }
  }

  const totalRequests = outcomes.success + outcomes.failed
  const byProvider: ProviderBreakdown[] = [...providers.values()]
    .map((p) => {
      const extra = p as unknown as { firstByteSum: number; firstByteCount: number }
      return {
        provider: p.provider,
        requests: p.requests,
        success: p.success,
        failed: p.failed,
        promptTokens: p.promptTokens,
        completionTokens: p.completionTokens,
        totalTokens: p.totalTokens,
        avgFirstByteMs: extra.firstByteCount > 0 ? Math.round(extra.firstByteSum / extra.firstByteCount) : null,
        requestShare: totalRequests > 0 ? p.requests / totalRequests : 0,
        lastStatus: p.lastStatus,
        lastTs: p.lastTs,
        sessionCount: p.sessionIds.size,
      }
    })
    .sort((a, b) => b.requests - a.requests)

  daily.sort((a, b) => (a.day < b.day ? -1 : 1))

  return {
    totals,
    outcomes,
    successRate: rate(outcomes.success, totalRequests),
    firstByte: { p50: percentile(firstBytes, 50), p95: percentile(firstBytes, 95) },
    daily,
    byProvider,
    byStrategy: [...strategies.entries()]
      .map(([strategy, v]) => ({ strategy, ...v }))
      .sort((a, b) => b.requests - a.requests),
    byModel: [...models.entries()]
      .map(([upstreamModel, v]) => ({ upstreamModel, ...v }))
      .sort((a, b) => b.requests - a.requests),
    sessionCount: sessions.size,
  }
}

export function aggregateOverview(records: LlmUsageRecord[], now = Date.now()): Overview {
  const totals = emptyTotals();
  const outcomes: OutcomeCounts = { success: 0, retried: 0, failed: 0 };
  const firstBytes: number[] = [];
  const daily = new Map<string, DailyPoint>();
  const providers = new Map<string, ProviderBreakdown & { firstByteSamples: number[]; sessionIds: Set<string> }>();
  const strategies = new Map<string, { requests: number; totalTokens: number }>();
  const models = new Map<string, { requests: number; totalTokens: number }>();
  const sessions = new Set<string>();

  for (const r of records) {
    if (isProbeKind(r.kind)) continue;
    const prompt = num(r.promptTokens);
    const completion = num(r.completionTokens);
    totals.promptTokens += prompt;
    totals.completionTokens += completion;
    totals.cachedTokens += num(r.cachedTokens);
    totals.totalTokens += prompt + completion;
    if (r.sessionId) sessions.add(r.sessionId);

    if (r.status === 'success') {
      outcomes.success += 1;
      if (r.retried || num(r.attempts) > 1) outcomes.retried += 1;
      if (typeof r.firstByteMs === 'number' && Number.isFinite(r.firstByteMs)) {
        firstBytes.push(r.firstByteMs);
      }
    } else {
      outcomes.failed += 1;
    }

    const day = localDay(r.ts);
    let dayPoint = daily.get(day);
    if (!dayPoint) {
      dayPoint = {
        day,
        success: 0,
        retried: 0,
        failed: 0,
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
      };
      daily.set(day, dayPoint);
    }
    if (r.status === 'success') {
      dayPoint.success += 1;
      if (r.retried || num(r.attempts) > 1) dayPoint.retried += 1;
    } else {
      dayPoint.failed += 1;
    }
    dayPoint.promptTokens += prompt;
    dayPoint.completionTokens += completion;
    dayPoint.cachedTokens += num(r.cachedTokens);

    let provider = providers.get(r.provider);
    if (!provider) {
      provider = {
        provider: r.provider,
        requests: 0,
        success: 0,
        failed: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        avgFirstByteMs: null,
        requestShare: 0,
        sessionCount: 0,
        firstByteSamples: [],
        sessionIds: new Set(),
      };
      providers.set(r.provider, provider);
    }
    provider.requests += 1;
    if (r.sessionId) provider.sessionIds.add(r.sessionId);
    // Most-recent wins; ties keep the later array position, which is the
    // append order the store writes in.
    if (provider.lastTs === undefined || r.ts >= provider.lastTs) {
      provider.lastTs = r.ts;
      provider.lastStatus = r.status === 'success' ? 'success' : 'error';
    }
    if (r.status === 'success') {
      provider.success += 1;
      if (typeof r.firstByteMs === 'number' && Number.isFinite(r.firstByteMs)) {
        provider.firstByteSamples.push(r.firstByteMs);
      }
    } else {
      provider.failed += 1;
    }
    provider.promptTokens += prompt;
    provider.completionTokens += completion;
    provider.totalTokens += prompt + completion;

    const strat = strategies.get(r.strategy) ?? { requests: 0, totalTokens: 0 };
    strat.requests += 1;
    strat.totalTokens += prompt + completion;
    strategies.set(r.strategy, strat);

    const model = models.get(r.upstreamModel) ?? { requests: 0, totalTokens: 0 };
    model.requests += 1;
    model.totalTokens += prompt + completion;
    models.set(r.upstreamModel, model);
  }

  const totalRequests = records.length;
  const byProvider = [...providers.values()]
    .map(({ firstByteSamples, sessionIds, ...rest }) => ({
      ...rest,
      avgFirstByteMs: avg(firstByteSamples),
      requestShare: rate(rest.requests, totalRequests) ?? 0,
      sessionCount: sessionIds.size,
    }))
    .sort((a, b) => b.requests - a.requests);

  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  const dailySorted = [...daily.values()]
    .filter((d) => Date.parse(`${d.day}T00:00:00`) >= cutoff - 24 * 60 * 60 * 1000)
    .sort((a, b) => (a.day < b.day ? -1 : 1));

  return {
    totals,
    outcomes,
    successRate: rate(outcomes.success, totalRequests),
    firstByte: { p50: percentile(firstBytes, 50), p95: percentile(firstBytes, 95) },
    daily: dailySorted,
    byProvider,
    byStrategy: [...strategies.entries()]
      .map(([strategy, v]) => ({ strategy, ...v }))
      .sort((a, b) => b.requests - a.requests),
    byModel: [...models.entries()]
      .map(([upstreamModel, v]) => ({ upstreamModel, ...v }))
      .sort((a, b) => b.requests - a.requests),
    sessionCount: sessions.size,
  };
}

export function aggregateProvider(
  records: LlmUsageRecord[],
  providerId: string,
  recentLimit = 20,
): ProviderDetail | null {
  // Two views of the same rows:
  //
  //   `all`  — everything for this provider, including connection probes, so
  //            the detail page's recent-request list still shows "you tested
  //            this key at 22:29".
  //   `mine` — traffic only. `requests`, `successRate`, the per-key and hourly
  //            tallies all read this, because a probe that failed on purpose is
  //            not a provider failure.
  const all = records.filter((r) => r.provider === providerId);
  if (all.length === 0) return null;
  const mine = all.filter((r) => !isProbeKind(r.kind));

  const totals = emptyTotals();
  const outcomes: OutcomeCounts = { success: 0, retried: 0, failed: 0 };
  const firstBytes: number[] = [];
  const keys = new Map<string, KeyRow & { firstByteSamples: number[] }>();
  const hourly: Array<{ hour: number; success: number; failed: number }> = Array.from(
    { length: 24 },
    (_, hour) => ({ hour, success: 0, failed: 0 }),
  );
  const daily = new Map<string, DailyPoint>();

  for (const r of mine) {
    const prompt = num(r.promptTokens);
    const completion = num(r.completionTokens);
    totals.promptTokens += prompt;
    totals.completionTokens += completion;
    totals.cachedTokens += num(r.cachedTokens);
    totals.totalTokens += prompt + completion;

    const isSuccess = r.status === 'success';
    if (isSuccess) {
      outcomes.success += 1;
      if (r.retried || num(r.attempts) > 1) outcomes.retried += 1;
      if (typeof r.firstByteMs === 'number' && Number.isFinite(r.firstByteMs)) {
        firstBytes.push(r.firstByteMs);
      }
    } else {
      outcomes.failed += 1;
    }

    let key = keys.get(r.keyId);
    if (!key) {
      key = {
        keyId: r.keyId,
        requests: 0,
        success: 0,
        failed: 0,
        successRate: null,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        avgFirstByteMs: null,
        firstByteSamples: [],
        hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, success: 0, failed: 0 })),
      };
      keys.set(r.keyId, key);
    }
    key.requests += 1;
    if (isSuccess) {
      key.success += 1;
      if (typeof r.firstByteMs === 'number' && Number.isFinite(r.firstByteMs)) {
        key.firstByteSamples.push(r.firstByteMs);
      }
    } else {
      key.failed += 1;
    }
    key.promptTokens += prompt;
    key.completionTokens += completion;
    key.totalTokens += prompt + completion;

    const hour = new Date(r.ts).getHours();
    if (isSuccess) {
      hourly[hour]!.success += 1;
      key.hourly[hour]!.success += 1;
    } else {
      hourly[hour]!.failed += 1;
      key.hourly[hour]!.failed += 1;
    }

    const day = localDay(r.ts);
    let dayPoint = daily.get(day);
    if (!dayPoint) {
      dayPoint = { day, success: 0, retried: 0, failed: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
      daily.set(day, dayPoint);
    }
    if (isSuccess) {
      dayPoint.success += 1;
      if (r.retried || num(r.attempts) > 1) dayPoint.retried += 1;
    } else {
      dayPoint.failed += 1;
    }
    dayPoint.promptTokens += prompt;
    dayPoint.completionTokens += completion;
    dayPoint.cachedTokens += num(r.cachedTokens);
  }

  const keyRows = [...keys.values()]
    .map(({ firstByteSamples, ...rest }) => ({
      ...rest,
      successRate: rate(rest.success, rest.requests),
      avgFirstByteMs: avg(firstByteSamples),
    }))
    .sort((a, b) => b.requests - a.requests);

  return {
    provider: providerId,
    requests: mine.length,
    outcomes,
    successRate: rate(outcomes.success, mine.length),
    totals,
    keys: keyRows,
    hourly,
    daily: [...daily.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
    recent: all.slice(Math.max(0, all.length - recentLimit)),
  };
}

/**
 * Token totals for each of the last 24 hours, oldest first.
 *
 * The day view's chart is an hourly series, but the buckets are per-day — this
 * is why it is computed from the records rather than from them. Probes are
 * skipped for the same reason they are everywhere else: they are not traffic.
 */
export function hourlyTokens(
  records: ReadonlyArray<LlmUsageRecord>,
  now: number = Date.now(),
): Array<{ hour: number; prompt: number; completion: number; cached: number; success: number; failed: number }> {
  const slots = Array.from({ length: 24 }, (_, i) => ({
    hour: (new Date(now).getHours() - 23 + i + 48) % 24,
    prompt: 0,
    completion: 0,
    cached: 0,
    success: 0,
    failed: 0,
  }))
  const hourNow = new Date(now).getHours()
  for (const r of records) {
    if (isProbeKind(r.kind)) continue;
    const ageHours = Math.floor((now - r.ts) / 3_600_000)
    if (ageHours < 0 || ageHours > 23) continue
    // Oldest slot is 23 hours ago; index from there.
    const slot = slots[23 - ageHours]
    if (!slot) continue
    slot.prompt += num(r.promptTokens)
    slot.completion += num(r.completionTokens)
    slot.cached += num(r.cachedTokens)
    if (r.status === 'success') slot.success += 1
    else slot.failed += 1
  }
  void hourNow
  return slots
}

/**
 * Failure counts grouped by HTTP status.
 *
 * Used to distinguish "this key is rate limited" (429) from "this key is dead"
 * (401) — the two need opposite operator actions and look identical in a plain
 * success-rate number.
 */
export function statusHistogram(records: LlmUsageRecord[]): Array<{ statusCode: number; count: number }> {
  const counts = new Map<number, number>();
  for (const r of records) {
    if (isProbeKind(r.kind)) continue;
    if (r.status === 'success') continue;
    // A refusal the gateway made itself carries its own 503 but says nothing
    // about the upstream — grouping it under 503 would read as "the provider
    // is down", which is the opposite of what happened.
    if (r.status === 'no_healthy_account') continue;
    counts.set(r.statusCode, (counts.get(r.statusCode) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([statusCode, count]) => ({ statusCode, count }))
    .sort((a, b) => b.count - a.count);
}

// ============================================================================
// Provider detail (the provider view's three tabs)
// ============================================================================

/**
 * Trace stage names the gateway can emit, in pipeline order.
 *
 * Kept here rather than derived from the strings so an unknown stage written by
 * a future gateway version is still surfaced instead of silently dropped.
 */
const KNOWN_STAGES = [
  'provider_selected',
  'retry_provider',
  'cooldown_provider',
  'upstream_first_chunk',
  'stream_end',
  'usage_recorded',
] as const;

type TraceStage = (typeof KNOWN_STAGES)[number];

const isKnownStage = (value: string): value is TraceStage =>
  (KNOWN_STAGES as readonly string[]).includes(value);

/**
 * Parse a `stage@ms` trace array into ordered stages with real offsets.
 *
 * Older records predate the `@ms` suffix and older still carry no trace at all;
 * both yield whatever offsets exist rather than being discarded, so the
 * timeline degrades to fewer stages instead of going blank.
 */
function parseTrace(trace: readonly string[] | undefined): Array<{ stage: TraceStage; atMs: number | null }> {
  if (!trace?.length) return [];
  const parsed: Array<{ stage: TraceStage; atMs: number | null }> = [];
  for (const entry of trace) {
    const at = entry.lastIndexOf('@');
    const name = at > 0 ? entry.slice(0, at) : entry;
    if (!isKnownStage(name)) continue;
    const raw: number = at > 0 ? Number(entry.slice(at + 1)) : Number.NaN;
    parsed.push({ stage: name, atMs: Number.isFinite(raw) ? raw : null });
  }
  // Older successful records had no trace; provider selection is still a real
  // stage and its request-relative offset is known to be zero.
  if (!parsed.some((stage) => stage.stage === 'provider_selected')) {
    parsed.unshift({ stage: 'provider_selected', atMs: 0 });
  }
  // The gateway writes stages in pipeline order. Keep that order rather than
  // sorting by offset: legacy records without `@ms` must stay where they were
  // recorded, and a future unknown stage should not shift known entries around.
  return parsed;
}

/**
 * Everything the provider detail view needs, flattened for transport.
 *
 * Separate from `aggregateProvider` because the payload shape is the DTO the
 * renderer consumes directly: trace stages parsed out of the stored strings and
 * per-key rows carrying both usage and scheduling state. Returns null when the
 * provider has no usage at all.
 */
export function aggregateProviderDetail(
  records: LlmUsageRecord[],
  providerId: string,
  recentLimit = 20,
) {
  const detail = aggregateProvider(records, providerId, recentLimit);
  if (!detail) return null;

  const recent = [...detail.recent]
    .reverse()
    .slice(0, recentLimit)
    .map((r) => ({
      ts: r.ts,
      model: r.publicModel,
      keyId: r.keyId,
      // Carried through the projection: the log renders the group that actually
      // served the request, and the strategy cards count their own traffic by
      // it. Dropping them here made every row look unattributed.
      strategy: r.strategy,
      kind: r.kind,
      sessionId: r.sessionId,
      status: r.status === 'success' ? ('success' as const) : ('error' as const),
      statusCode: r.statusCode,
      attempts: r.attempts,
      retried: r.retried === true,
      promptTokens: r.promptTokens ?? 0,
      completionTokens: r.completionTokens ?? 0,
      totalTokens: (r.promptTokens ?? 0) + (r.completionTokens ?? 0),
      firstByteMs: r.firstByteMs,
      totalMs: r.totalMs,
      error: r.error,
      stages: parseTrace(r.trace),
    }));

  return {
    provider: detail.provider,
    requests: detail.requests,
    success: detail.outcomes.success,
    retried: detail.outcomes.retried,
    failed: detail.outcomes.failed,
    successRate: detail.successRate,
    promptTokens: detail.totals.promptTokens,
    completionTokens: detail.totals.completionTokens,
    totalTokens: detail.totals.totalTokens,
    hourly: detail.hourly,
    daily: detail.daily,
    keys: detail.keys.map((k) => ({
      keyId: k.keyId,
      requests: k.requests,
      success: k.success,
      failed: k.failed,
      successRate: k.successRate,
      promptTokens: k.promptTokens,
      completionTokens: k.completionTokens,
      totalTokens: k.totalTokens,
      avgFirstByteMs: k.avgFirstByteMs,
      hourly: k.hourly,
    })),
    recent,
  };
}
