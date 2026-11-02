import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

export interface StopBackgroundTaskArgs {
  taskId: string;
  stoppedBy?: 'model' | 'user';
}

/**
 * stop_background_task — stop a running background shell/agent and record who
 * stopped it. The record stays in `stopped_pending` until its stop notice has
 * actually been delivered; only then is it deleted.
 */
export async function handleStopBackgroundTask(
  ctx: SessionToolContext,
  args: StopBackgroundTaskArgs
): Promise<ToolResult> {
  if (!args.taskId) {
    return errorResponse('taskId is required.');
  }
  if (!ctx.stopBackgroundTask) {
    return errorResponse('stop_background_task is not available in this context.');
  }

  try {
    const result = await ctx.stopBackgroundTask(args.taskId, args.stoppedBy ?? 'model');
    return successResponse(JSON.stringify(result, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to stop background task: ${message}`);
  }
}
