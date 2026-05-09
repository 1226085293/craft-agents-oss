import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

export interface DeliverFileArgs {
  path: string;
  filename?: string;
  caption?: string;
  target?: 'active_channel' | 'mobile' | 'all_bound_channels';
  platform?: 'telegram' | 'whatsapp' | 'lark';
}

/**
 * Deliver a local file to the messaging channel(s) bound to the current session.
 * The backend validates the path against workspace/session allow-lists before
 * touching disk, then routes through the messaging gateway adapters.
 */
export async function handleDeliverFile(
  ctx: SessionToolContext,
  args: DeliverFileArgs,
): Promise<ToolResult> {
  if (!ctx.deliverFileToMessaging) {
    return errorResponse('Messaging file delivery is not configured for this workspace.');
  }

  try {
    const result = await ctx.deliverFileToMessaging({
      path: args.path,
      filename: args.filename,
      caption: args.caption,
      target: args.target ?? 'active_channel',
      platform: args.platform,
    });

    if (result.sent > 0 && result.failed === 0) {
      return successResponse(`Delivered ${result.filename} to ${result.sent} messaging channel(s).`);
    }

    if (result.sent > 0) {
      const failures = result.failures.map((f) => `${f.platform}: ${f.error}`).join('; ');
      return successResponse(
        `Delivered ${result.filename} to ${result.sent} channel(s); ${result.failed} channel(s) failed. ${failures}`,
      );
    }

    const failures = result.failures.map((f) => `${f.platform}: ${f.error}`).join('; ');
    return errorResponse(
      failures
        ? `Failed to deliver ${result.filename}: ${failures}`
        : `No bound messaging channels were available for ${ctx.sessionId}.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to deliver file: ${message}`);
  }
}
