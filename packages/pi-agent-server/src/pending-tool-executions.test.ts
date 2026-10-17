import { describe, expect, it } from 'bun:test';
import { PendingToolExecutions } from './pending-tool-executions.ts';

/**
 * 2026-10-18 (session 261016-deft-tide): the subprocess-side proxy-tool
 * promise used to have no timeout and no abort path. A hung host tool left it
 * pending forever, the SDK's activeRun never cleared, and every later prompt
 * died with "Agent is already processing a prompt". These tests pin the two
 * terminal paths: a hard timeout and a bulk reject on stall/user abort.
 */
describe('PendingToolExecutions', () => {
  it('resolves a normal host reply and clears the timer', async () => {
    const pending = new PendingToolExecutions();
    const promise = pending.create('r1', 5_000);
    expect(pending.size).toBe(1);
    expect(pending.resolve('r1', { content: 'ok', isError: false })).toBe(true);
    await expect(promise).resolves.toEqual({ content: 'ok', isError: false });
    expect(pending.size).toBe(0);
  });

  it('times out a hung execution instead of waiting forever', async () => {
    const pending = new PendingToolExecutions();
    const promise = pending.create('r1', 20);
    await expect(promise).rejects.toThrow(/timed out after/);
    expect(pending.size).toBe(0);
  });

  it('rejectAll settles every in-flight execution (stall / user abort)', async () => {
    const pending = new PendingToolExecutions();
    const a = pending.create('a', 0);
    const b = pending.create('b', 0);
    expect(pending.rejectAll('Turn stalled — tool execution aborted')).toBe(2);
    await expect(a).rejects.toThrow('Turn stalled');
    await expect(b).rejects.toThrow('Turn stalled');
    expect(pending.size).toBe(0);
  });

  it('ignores unknown request ids (late host replies after an abort)', () => {
    const pending = new PendingToolExecutions();
    expect(pending.resolve('missing', { content: 'x', isError: false })).toBe(false);
    expect(pending.rejectAll('nothing in flight')).toBe(0);
  });

  it('a resolved execution cannot time out later', async () => {
    const pending = new PendingToolExecutions();
    const promise = pending.create('r1', 20);
    pending.resolve('r1', { content: 'ok', isError: false });
    await expect(promise).resolves.toEqual({ content: 'ok', isError: false });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(pending.size).toBe(0);
  });

  it('distinguishes a speculative prefetch from a real tool execution', () => {
    const pending = new PendingToolExecutions();
    void pending.create('prefetch-1', 0, { active: false }).catch(() => {});
    expect(pending.hasActiveTool()).toBe(false);
    void pending.create('real-1', 0).catch(() => {});
    expect(pending.hasActiveTool()).toBe(true);
  });

  it('clear drops entries without rejecting (process teardown)', () => {
    const pending = new PendingToolExecutions();
    void pending.create('a', 0).catch(() => {});
    void pending.create('b', 0).catch(() => {});
    pending.clear();
    expect(pending.size).toBe(0);
  });
});
