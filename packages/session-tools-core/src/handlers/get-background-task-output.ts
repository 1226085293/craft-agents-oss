import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

export interface GetBackgroundTaskOutputArgs {
  taskId: string;
  tailLines?: number;
}

/**
 * get_background_task_output — read the tail of a background task's output.
 *
 * The output file is owned by the main process; this handler only formats the
 * result. The full file remains available for follow-up reads, unlike the
 * renderer's one-shot getTaskOutput RPC.
 */
export async function handleGetBackgroundTaskOutput(
  ctx: SessionToolContext,
  args: GetBackgroundTaskOutputArgs
): Promise<ToolResult> {
  if (!args.taskId) {
    return errorResponse('taskId is required.');
  }
  if (!ctx.getBackgroundTaskOutput) {
    return errorResponse('get_background_task_output is not available in this context.');
  }

  try {
    const output = await ctx.getBackgroundTaskOutput(
      args.taskId,
      args.tailLines ?? 100
    );
    if (output === null) {
      return errorResponse(
        `No output is available for background task ${args.taskId}. ` +
          `It may still be running, or it may have no output file.`
      );
    }
    return successResponse(output || '(background task produced no output)');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to read background task output: ${message}`);
  }
}
