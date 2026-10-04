/**
 * Regression contract: the pi-agent-server bounded heartbeat
 * (compaction-progress.ts) injects `compaction_progress` outbound events —
 * Craft-injected, not part of the Pi SDK union. The adapter must map them to
 * a live "Compacting context..." status (keyword preserved so the session
 * handler keeps statusType: 'compacting') instead of falling into the
 * unknown-Pi-event warning path.
 */
import { describe, expect, it, beforeEach } from 'bun:test';
import { PiEventAdapter } from './event-adapter.ts';

function collect<T>(gen: Generator<T>): T[] {
  return [...gen];
}

function statusOf(events: any[]): any | undefined {
  return events.find((e: any) => e.type === 'status');
}

describe('PiEventAdapter — compaction_progress heartbeat', () => {
  let adapter: PiEventAdapter;

  beforeEach(() => {
    adapter = new PiEventAdapter();
    adapter.startTurn();
  });

  it('maps a heartbeat to a Compacting status with elapsed time', () => {
    const events = collect<any>(adapter.adaptEvent({ type: 'compaction_progress', elapsedMs: 95_000 } as any));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'status' });
    expect(statusOf(events)?.message).toBe('Compacting context... (1m 35s)');
  });

  it('keeps the Compacting keyword on short and missing payloads', () => {
    const short = collect<any>(adapter.adaptEvent({ type: 'compaction_progress', elapsedMs: 45_000 } as any));
    expect(statusOf(short)?.message).toBe('Compacting context... (0m 45s)');

    const bare = collect<any>(adapter.adaptEvent({ type: 'compaction_progress' } as any));
    expect(bare).toHaveLength(1);
    expect(statusOf(bare)?.message).toBe('Compacting context... (0m 0s)');
  });

  it('does not disturb the normal compaction_start/end status flow', () => {
    const start = collect(adapter.adaptEvent({ type: 'compaction_start' } as any));
    expect(start[0]).toMatchObject({ type: 'status', message: 'Compacting context...' });

    const tick = collect<any>(adapter.adaptEvent({ type: 'compaction_progress', elapsedMs: 60_000 } as any));
    expect(statusOf(tick)?.message).toBe('Compacting context... (1m 0s)');

    const end = collect<any>(
      adapter.adaptEvent({ type: 'compaction_end', result: { estimatedTokensAfter: 5000 } } as any),
    );
    expect(end.some((e: any) => e.type === 'info' && e.message.includes('Compacted'))).toBe(true);
  });
});
