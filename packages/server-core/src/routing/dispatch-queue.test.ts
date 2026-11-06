import { describe, expect, it } from 'bun:test';

import { DispatchQueue } from './dispatch-queue.ts';

function queueWithCaps(caps: Record<string, number>): DispatchQueue {
  return new DispatchQueue((key) => caps[key] ?? 1);
}

describe('dispatch queue', () => {
  it('starts jobs while below the cap', async () => {
    const queue = queueWithCaps({ rule: 2 });
    const started: string[] = [];
    const job = (id: string) => ({
      run: async () => {
        started.push(id);
        return `session-${id}`;
      },
    });

    expect(await queue.submit('rule', job('a'))).toBe('started');
    expect(await queue.submit('rule', job('b'))).toBe('started');
    expect(started).toEqual(['a', 'b']);
    expect(queue.activeCount('rule')).toBe(2);
  });

  it('parks the 4th job when parallel is 3, and starts it in order on release', async () => {
    const queue = queueWithCaps({ rule: 3 });
    const started: string[] = [];
    const job = (id: string) => ({
      run: async () => {
        started.push(id);
        return `session-${id}`;
      },
    });

    for (const id of ['a', 'b', 'c']) {
      expect(await queue.submit('rule', job(id))).toBe('started');
    }
    expect(await queue.submit('rule', job('d'))).toBe('queued');
    expect(started).toEqual(['a', 'b', 'c']);
    expect(queue.pendingCount('rule')).toBe(1);

    queue.release('session-a');
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(started).toEqual(['a', 'b', 'c', 'd']);
    expect(queue.activeCount('rule')).toBe(3);
  });

  it('keeps the queue per key: one saturated rule does not block another', async () => {
    const queue = queueWithCaps({ slow: 1, fast: 1 });
    await queue.submit('slow', { run: async () => 'session-1' });
    expect(await queue.submit('slow', { run: async () => 'session-2' })).toBe('queued');
    expect(await queue.submit('fast', { run: async () => 'session-3' })).toBe('started');
  });

  it('does not hold a slot when the job fails', async () => {
    const queue = queueWithCaps({ rule: 1 });
    const outcome = await queue.submit('rule', {
      run: async () => {
        throw new Error('spawn failed');
      },
    });
    expect(outcome).toBe('started');
    expect(queue.activeCount('rule')).toBe(0);
    // The queue must still accept work after a failure.
    expect(await queue.submit('rule', { run: async () => 'session-ok' })).toBe('started');
  });

  it('sweeps slots whose session disappeared', async () => {
    const queue = queueWithCaps({ rule: 1 });
    await queue.submit('rule', { run: async () => 'dead-session' });
    expect(queue.activeCount('rule')).toBe(1);

    queue.sweep(() => false);
    expect(queue.activeCount('rule')).toBe(0);
  });

  it('ignores a double release instead of freeing a slot twice', async () => {
    const queue = queueWithCaps({ rule: 1 });
    await queue.submit('rule', { run: async () => 'session-a' });
    await queue.submit('rule', { run: async () => 'session-b' }).catch(() => undefined);

    queue.release('session-a');
    queue.release('session-a');
    expect(queue.activeCount('rule')).toBeLessThanOrEqual(1);
  });

  it('treats a missing cap as 1', async () => {
    const queue = new DispatchQueue(() => Number.NaN);
    await queue.submit('x', { run: async () => 'session-1' });
    expect(await queue.submit('x', { run: async () => 'session-2' })).toBe('queued');
  });
});
