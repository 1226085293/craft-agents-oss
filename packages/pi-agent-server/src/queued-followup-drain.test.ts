import { describe, expect, it } from 'bun:test';
import { scheduleQueuedFollowUpDrain, type DrainableSession } from './queued-followup-drain.ts';

interface FakeTimer {
  fn: (() => void) | null;
  ms: number;
}

function fakeSession(pending: number | undefined) {
  const calls: string[] = [];
  const session = {
    pendingMessageCount: pending,
    agent: {
      continue: () => {
        calls.push('continue');
        return Promise.resolve();
      },
    },
  };
  return { session, calls };
}

function runTimered(
  pending: number | undefined,
  opts: { delayMs?: number; cancelled?: boolean; reject?: boolean } = {},
) {
  const timers: FakeTimer[] = [];
  const { session, calls } = fakeSession(pending);
  const fired: number[] = [];
  const errors: string[] = [];
  const s = session as DrainableSession;
  if (opts.reject) {
    (s.agent as unknown as { continue(): Promise<void> }).continue = () => {
      calls.push('continue');
      return Promise.reject(new Error('drain boom'));
    };
  }
  const cancel = scheduleQueuedFollowUpDrain(s, {
    delayMs: opts.delayMs,
    timer: (fn, ms) => {
      timers.push({ fn: fn as () => void, ms });
      return 0;
    },
    onDrain: (pendingCount) => {
      fired.push(pendingCount);
    },
    onDrainError: (msg) => errors.push(msg),
  });
  if (opts.cancelled) cancel();
  // Fire the timer synchronously (as if the delay elapsed)
  for (const t of timers) t.fn?.();
  // let rejections settle
  return Promise.resolve().then(() => ({ fired, errors, calls, scheduledMs: timers.map((t) => t.ms) }));
}

describe('scheduleQueuedFollowUpDrain (261007-lean-bamboo)', () => {
  it('drains when messages are still pending at fire time', async () => {
    const { fired, calls } = await runTimered(1);
    expect(calls).toEqual(['continue']);
    expect(fired).toEqual([1]);
  });

  it('is a no-op when the queue is already empty (in-loop drain, 261007-active-wren shape)', async () => {
    const { fired, calls, errors } = await runTimered(0);
    expect(calls).toEqual([]);
    expect(fired).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('is a no-op when pendingMessageCount is undefined (session without the counter)', async () => {
    const { fired, calls } = await runTimered(undefined);
    expect(calls).toEqual([]);
    expect(fired).toEqual([]);
  });

  it('uses the default 100ms delay when none is given', async () => {
    const { scheduledMs } = await runTimered(1);
    expect(scheduledMs).toEqual([100]);
  });

  it('honours a custom delay', async () => {
    const { scheduledMs } = await runTimered(1, { delayMs: 5 });
    expect(scheduledMs).toEqual([5]);
  });

  it('cancel() suppresses the fire entirely', async () => {
    const { fired, calls } = await runTimered(1, { cancelled: true });
    expect(calls).toEqual([]);
    expect(fired).toEqual([]);
  });

  it('surfaces continue() rejections via onDrainError', async () => {
    const { errors, calls } = await runTimered(1, { reject: true });
    expect(calls).toEqual(['continue']);
    expect(errors).toEqual(['drain boom']);
  });

  it('reports the LIVE pending count at fire time, not at schedule time', async () => {
    // Simulate the race where an in-loop drain empties the queue after we
    // scheduled but before the timer fires.
    const timers: FakeTimer[] = [];
    const calls: string[] = [];
    const s: DrainableSession = {
      pendingMessageCount: 1,
      agent: {
        continue: () => {
          calls.push('continue');
          return Promise.resolve();
        },
      },
    };
    const cancel = scheduleQueuedFollowUpDrain(s, {
      timer: (fn, ms) => {
        timers.push({ fn: fn as () => void, ms });
        return 0;
      },
    });
    expect(typeof cancel).toBe('function');
    s.pendingMessageCount = 0; // in-loop drain consumed it
    timers.forEach((t) => t.fn?.());
    expect(calls).toEqual([]);
  });
});
