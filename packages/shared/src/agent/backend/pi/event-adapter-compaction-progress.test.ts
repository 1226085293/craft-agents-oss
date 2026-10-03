/**
 * Regression contract: the pi-agent-server bounded heartbeat
 * (compaction-progress.ts) injects `compaction_progress` outbound events —
 * Craft-injected, not part of the Pi SDK union. The adapter must NOT fall
 * into the unknown-Pi-event warning path for them, but also must NOT surface
 * them as UI status events: each tick used to append its own
 * "Compacting context... (Nm Ms)" line to the process block, producing a
 * growing list of near-identical rows with a stale per-tick elapsed time.
 *
 * The UI keeps the single "Compacting context..." row emitted on
 * compaction_start (the renderer dedupes repeated compacting status messages
 * in place), and the bottom ProcessingIndicator shows a live per-second
 * elapsed timer. The ticks still matter upstream: PiAgent's
 * recordSubprocessTurnProgress consumes them to keep the capped
 * compaction watchdog armed.
 */
import { describe, expect, it, beforeEach } from 'bun:test';
import { PiEventAdapter } from './event-adapter.ts';

function collect<T>(gen: Generator<T>): T[] {
  return [...gen];
}

describe('PiEventAdapter — compaction_progress heartbeat', () => {
  let adapter: PiEventAdapter;

  beforeEach(() => {
    adapter = new PiEventAdapter();
    adapter.startTurn();
  });

  it('surfaces no UI events for a heartbeat tick (watchdog-only)', () => {
    const events = collect<any>(adapter.adaptEvent({ type: 'compaction_progress', elapsedMs: 95_000 } as any));
    expect(events).toHaveLength(0);
  });

  it('surfaces no UI events for short or missing payloads', () => {
    const short = collect<any>(adapter.adaptEvent({ type: 'compaction_progress', elapsedMs: 45_000 } as any));
    expect(short).toHaveLength(0);

    const bare = collect<any>(adapter.adaptEvent({ type: 'compaction_progress' } as any));
    expect(bare).toHaveLength(0);
  });

  it('does not disturb the normal compaction_start/end status flow', () => {
    const start = collect(adapter.adaptEvent({ type: 'compaction_start' } as any));
    expect(start[0]).toMatchObject({ type: 'status', message: 'Compacting context...' });

    // Ticks stay silent — the process block keeps its single start row.
    const tick = collect<any>(adapter.adaptEvent({ type: 'compaction_progress', elapsedMs: 60_000 } as any));
    expect(tick).toHaveLength(0);

    const end = collect<any>(
      adapter.adaptEvent({ type: 'compaction_end', result: { estimatedTokensAfter: 5000 } } as any),
    );
    expect(end.some((e: any) => e.type === 'info' && e.message.includes('Compacted'))).toBe(true);
  });
});
