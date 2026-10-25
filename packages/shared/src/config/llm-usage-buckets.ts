/**
 * Daily usage buckets — the overview's aggregation.
 *
 * Derived, never stored. These used to live in `usage-daily.json`, which made
 * the overview and the log two independent records of the same traffic: the
 * detail log is cleared at startup while the bucket file was not, so after any
 * restart the overview reported more requests than the log had rows. One source
 * is the only way they cannot disagree — the records are the source, these
 * buckets are a compact projection of them.
 *
 * The caps are deliberate: a bucket is rebuilt on every overview render, so the
 * per-day sample lists have to stay bounded no matter how much traffic there is.
 */

import type { LlmUsageRecord } from './llm-usage-store.ts';
import { isProbeKind } from './model-request-kind.ts';

/** Keep percentiles meaningful without unbounded growth. */
const MAX_FIRST_BYTE_SAMPLES = 1000;
/** Sessions per day / per provider: personal gateways stay far below this. */
const MAX_SESSIONS = 500;
const MAX_PROVIDER_SESSIONS = 200;

export interface ProviderBucket {
  requests: number;
  success: number;
  failed: number;
  prompt: number;
  completion: number;
  firstByteSum: number;
  firstByteCount: number;
  lastTs: number;
  lastStatus: 'success' | 'error';
  sessions: string[];
}

export interface UsageDayBucket {
  day: string;
  requests: number;
  success: number;
  retried: number;
  failed: number;
  prompt: number;
  completion: number;
  cached: number;
  firstByteSamples: number[];
  sessions: string[];
  providers: Record<string, ProviderBucket>;
  strategies: Record<string, { requests: number; tokens: number }>;
  models: Record<string, { requests: number; tokens: number }>;
}

/** Local calendar day, matching what the UI shows. */
export function localDay(ts: number): string {
  const d = new Date(ts);
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function emptyBucket(day: string): UsageDayBucket {
  return {
    day,
    requests: 0,
    success: 0,
    retried: 0,
    failed: 0,
    prompt: 0,
    completion: 0,
    cached: 0,
    firstByteSamples: [],
    sessions: [],
    providers: {},
    strategies: {},
    models: {},
  };
}

function pushUnique(list: string[], value: string, cap: number): void {
  if (!value || list.includes(value) || list.length >= cap) return;
  list.push(value);
}

/**
 * Fold records into per-day buckets, oldest day first.
 *
 * Pure: the same records always produce the same buckets, which is what lets a
 * test assert "the overview and the log agree" without touching disk.
 */
export function bucketsFromRecords(records: ReadonlyArray<LlmUsageRecord>): UsageDayBucket[] {
  const days: Record<string, UsageDayBucket> = {};

  for (const r of records) {
    // Probes are logged for traceability but are not traffic: a deliberately
    // wrong key would otherwise count as a provider failure and drag the
    // success rate down for a test that worked as intended. They stay in the
    // raw log; only the aggregates skip them.
    if (isProbeKind(r.kind)) continue;

    const day = localDay(r.ts);
    const b = (days[day] ??= emptyBucket(day));
    const prompt = Number(r.promptTokens ?? 0) || 0;
    const completion = Number(r.completionTokens ?? 0) || 0;
    const tokens = prompt + completion;

    b.requests += 1;
    b.prompt += prompt;
    b.completion += completion;
    b.cached += Number(r.cachedTokens ?? 0) || 0;
    if (r.status === 'success') {
      b.success += 1;
      if (r.retried || (r.attempts ?? 0) > 1) b.retried += 1;
      if (typeof r.firstByteMs === 'number' && Number.isFinite(r.firstByteMs)) {
        if (b.firstByteSamples.length < MAX_FIRST_BYTE_SAMPLES) b.firstByteSamples.push(r.firstByteMs);
      }
    } else {
      b.failed += 1;
    }
    pushUnique(b.sessions, r.sessionId ?? '', MAX_SESSIONS);

    const p = (b.providers[r.provider] ??= {
      requests: 0,
      success: 0,
      failed: 0,
      prompt: 0,
      completion: 0,
      firstByteSum: 0,
      firstByteCount: 0,
      lastTs: 0,
      lastStatus: 'error',
      sessions: [],
    });
    p.requests += 1;
    p.prompt += prompt;
    p.completion += completion;
    if (r.status === 'success') {
      p.success += 1;
      if (typeof r.firstByteMs === 'number' && Number.isFinite(r.firstByteMs)) {
        p.firstByteSum += r.firstByteMs;
        p.firstByteCount += 1;
      }
    } else {
      p.failed += 1;
    }
    if (r.ts >= p.lastTs) {
      p.lastTs = r.ts;
      p.lastStatus = r.status === 'success' ? 'success' : 'error';
    }
    pushUnique(p.sessions, r.sessionId ?? '', MAX_PROVIDER_SESSIONS);

    const s = (b.strategies[r.strategy] ??= { requests: 0, tokens: 0 });
    s.requests += 1;
    s.tokens += tokens;

    const m = (b.models[r.upstreamModel || r.publicModel] ??= { requests: 0, tokens: 0 });
    m.requests += 1;
    m.tokens += tokens;
  }

  return Object.values(days).sort((a, b) => (a.day < b.day ? -1 : 1));
}
