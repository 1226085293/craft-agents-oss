/**
 * Usage-range tests.
 *
 * The overview's global time filter resolves server-side, so the window
 * arithmetic lives here rather than in the renderer: a wrong week anchor or an
 * off-by-one boundary silently moves every number on the dashboard.
 */

import { describe, it, expect } from 'bun:test';
import { resolveUsageRange, filterUsageByRange, aggregateOverview } from '../llm-usage-aggregate.ts';

const NOW = new Date(2026, 9, 16, 15, 30, 0).getTime(); // Fri Oct 16 2026 15:30 local

function record(ts: number, provider = 'p1', status: 'success' | 'error' = 'success', sessionId = 's1') {
  return {
    ts,
    provider,
    keyId: 'k1',
    strategy: 'default',
    upstreamModel: 'm1',
    publicModel: 'm1',
    sessionId,
    status,
    statusCode: status === 'success' ? 200 : 500,
    promptTokens: 10,
    completionTokens: 5,
    attempts: 1,
  } as Parameters<typeof aggregateOverview>[0][number];
}

describe('resolveUsageRange', () => {
  it('day covers local midnight to next midnight', () => {
    const { fromTs, toTs } = resolveUsageRange('day', NOW);
    expect(new Date(fromTs).getDate()).toBe(16);
    expect(new Date(fromTs).getHours()).toBe(0);
    expect(toTs - fromTs).toBe(24 * 60 * 60 * 1000);
  });

  it('week is Monday-anchored', () => {
    const { fromTs } = resolveUsageRange('week', NOW);
    // Oct 16 2026 is a Friday; the Monday of that week is Oct 12.
    expect(new Date(fromTs).getDate()).toBe(12);
    expect(new Date(fromTs).getDay()).toBe(1);
  });

  it('month covers the calendar month', () => {
    const { fromTs, toTs } = resolveUsageRange('month', NOW);
    expect(new Date(fromTs).getMonth()).toBe(9); // October
    expect(new Date(toTs).getMonth()).toBe(10); // November
  });

  it('all is unbounded', () => {
    const { fromTs, toTs } = resolveUsageRange('all', NOW);
    expect(fromTs).toBe(Number.NEGATIVE_INFINITY);
    expect(toTs).toBe(Number.POSITIVE_INFINITY);
  });

  it('custom object normalizes reversed bounds', () => {
    const { fromTs, toTs } = resolveUsageRange({ fromTs: 200, toTs: 100 }, NOW);
    expect(fromTs).toBe(100);
    expect(toTs).toBe(200);
  });
});

describe('filterUsageByRange', () => {
  const records = [
    record(NOW - 2 * 24 * 60 * 60 * 1000), // two days ago
    record(NOW - 60 * 60 * 1000), // an hour ago
    record(NOW + 60 * 60 * 1000), // in the future (clock skew)
  ];

  it('keeps only the current day', () => {
    const kept = filterUsageByRange(records, 'day', NOW);
    expect(kept.length).toBe(2); // one hour ago + the skewed-future record
  });

  it('week keeps everything from this week', () => {
    // All three records fall inside Mon Oct 12 – Sun Oct 18, including the
    // clock-skewed future one — the week window is wider than the day's.
    const kept = filterUsageByRange(records, 'week', NOW);
    expect(kept.length).toBe(3);
  });

  it('all keeps everything', () => {
    expect(filterUsageByRange(records, 'all', NOW).length).toBe(3);
  });
});

describe('aggregateOverview provider fields', () => {
  const older = record(NOW - 3600_000, 'p1', 'error', 'sA');
  const newer = record(NOW, 'p1', 'success', 'sB');
  const other = record(NOW, 'p2', 'success', 'sB');

  it('tracks last status, last ts and distinct session count per provider', () => {
    // Deliberately out of chronological order: last must win by timestamp,
    // not by array position.
    const overview = aggregateOverview([newer, older, other], NOW);
    const p1 = overview.byProvider.find((p) => p.provider === 'p1')!;
    expect(p1.lastStatus).toBe('success');
    expect(p1.lastTs).toBe(newer.ts);
    expect(p1.sessionCount).toBe(2);

    const p2 = overview.byProvider.find((p) => p.provider === 'p2')!;
    expect(p2.sessionCount).toBe(1);
    expect(p2.lastStatus).toBe('success');
  });

  it('reports no last status for a provider with no records', () => {
    const overview = aggregateOverview([other], NOW);
    expect(overview.byProvider.some((p) => p.provider === 'p1')).toBe(false);
  });
});
