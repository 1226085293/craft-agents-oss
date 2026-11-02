import { describe, it, expect } from 'bun:test';
import { handleStopBackgroundTask } from './stop-background-task.ts';
import type { SessionToolContext } from '../context.ts';

function createCtx(stop?: SessionToolContext['stopBackgroundTask']): SessionToolContext {
  return {
    sessionId: 'sess-1',
    stopBackgroundTask: stop,
  } as unknown as SessionToolContext;
}

describe('handleStopBackgroundTask', () => {
  it('errors when the context lacks the capability', async () => {
    const res = await handleStopBackgroundTask(createCtx(undefined), { taskId: 't1' });
    expect(res.isError).toBe(true);
  });

  it('requires a taskId', async () => {
    const res = await handleStopBackgroundTask(createCtx(async (taskId) => ({
      taskId,
      status: 'stopped' as const,
      stoppedBy: 'model' as const,
      message: 'ok',
    })), { taskId: '' });
    expect(res.isError).toBe(true);
  });

  it('defaults stoppedBy to model and returns the backend result', async () => {
    const calls: Array<{ taskId: string; stoppedBy?: string }> = [];
    const res = await handleStopBackgroundTask(
      createCtx(async (taskId, stoppedBy) => {
        calls.push({ taskId, stoppedBy });
        return {
          taskId,
          status: 'stopped' as const,
          stoppedBy: stoppedBy ?? 'model',
          message: 'ok',
        };
      }),
      { taskId: 't1' },
    );

    expect(res.isError).toBeFalsy();
    expect(calls).toEqual([{ taskId: 't1', stoppedBy: 'model' }]);
    const text = JSON.stringify(res);
    expect(text).toContain('t1');
    expect(text).toContain('stopped');
  });

  it('surfaces backend errors', async () => {
    const res = await handleStopBackgroundTask(
      createCtx(async () => {
        throw new Error('background task not found');
      }),
      { taskId: 'missing' },
    );
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toContain('background task not found');
  });
});
