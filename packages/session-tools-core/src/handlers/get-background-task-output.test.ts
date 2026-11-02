import { describe, it, expect } from 'bun:test';
import type { SessionToolContext } from '../context.ts';
import { handleGetBackgroundTaskOutput } from './get-background-task-output.ts';

function createCtx(
  getOutput?: (taskId: string, tailLines?: number) => Promise<string | null>
): SessionToolContext {
  return {
    sessionId: 's1',
    ...(getOutput ? { getBackgroundTaskOutput: getOutput } : {}),
  } as unknown as SessionToolContext;
}

function text(result: Awaited<ReturnType<typeof handleGetBackgroundTaskOutput>>): string {
  return result.content.map((part) => part.text).join('\n');
}

describe('handleGetBackgroundTaskOutput', () => {
  it('returns the output and defaults to 100 lines', async () => {
    let seenTail: number | undefined;
    const result = await handleGetBackgroundTaskOutput(
      createCtx(async (_taskId, tailLines) => {
        seenTail = tailLines;
        return 'line 99\nline 100';
      }),
      { taskId: 'bg_1' }
    );

    expect(result.isError).toBe(false);
    expect(seenTail).toBe(100);
    expect(text(result)).toContain('line 100');
  });

  it('honors tailLines', async () => {
    let seenTail: number | undefined;
    await handleGetBackgroundTaskOutput(
      createCtx(async (_taskId, tailLines) => {
        seenTail = tailLines;
        return 'tail';
      }),
      { taskId: 'bg_1', tailLines: 25 }
    );

    expect(seenTail).toBe(25);
  });

  it('reports a running or missing task instead of inventing output', async () => {
    const result = await handleGetBackgroundTaskOutput(
      createCtx(async () => null),
      { taskId: 'bg_running' }
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('No output is available');
    expect(text(result)).toContain('still be running');
  });

  it('rejects an empty taskId without calling the backend', async () => {
    let called = false;
    const result = await handleGetBackgroundTaskOutput(
      createCtx(async () => {
        called = true;
        return 'unexpected';
      }),
      { taskId: '' }
    );

    expect(called).toBe(false);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('taskId is required');
  });

  it('reports when the context has no output callback', async () => {
    const result = await handleGetBackgroundTaskOutput(createCtx(), { taskId: 'bg_1' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('not available');
  });
});
