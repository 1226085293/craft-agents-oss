import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

export interface SendAgentMessageArgs {
  sessionId: string;
  message: string;
  attachments?: Array<{ path: string; name?: string }>;
}

export async function handleSendAgentMessage(
  ctx: SessionToolContext,
  args: SendAgentMessageArgs
): Promise<ToolResult> {
  if (!ctx.sendAgentMessage) {
    return errorResponse('send_agent_message is not available in this context.');
  }

  if (!args.sessionId?.trim()) {
    return errorResponse('sessionId is required.');
  }

  if (!args.message?.trim()) {
    return errorResponse('message is required.');
  }

  // Prevent self-send (would create a recursive loop)
  if (args.sessionId === ctx.sessionId) {
    return errorResponse('Cannot send a message to your own session. Use a different sessionId.');
  }

  try {
    // Session commands (`/stop`) must keep the command token at the start of
    // the message: the target parses commands before the message path, and the
    // sender envelope would bury it mid-text. Attribution is unnecessary here —
    // the command carries no content the target has to interpret.
    const isCommand = ctx.isSessionCommand?.(args.message) === true;

    // Build sender envelope so the target session knows who sent the message
    const senderName = ctx.getSessionInfo?.()?.name ?? ctx.sessionId;
    const wrappedMessage = isCommand
      ? args.message.trim()
      : [
          `[Message from session "${ctx.sessionId}" (${senderName})]`,
          `Use send_agent_message with sessionId "${ctx.sessionId}" to reply.`,
          '',
          '---',
          '',
          args.message,
        ].join('\n');

    const result = await ctx.sendAgentMessage(args.sessionId, wrappedMessage, args.attachments);

    // A command receipt must state what actually happened. An idle `/stop` is a
    // no-op and saying "stopped" would be a lie — the same failure mode that
    // made the gateway's `/stop` look broken.
    if (result.delivery === 'stopped') {
      const queued = result.queueLength ?? 0;
      return successResponse(
        `Stopped session ${args.sessionId}: its running turn was cancelled.` +
          (queued > 0
            ? ` ${queued} queued message(s) will still run after the stop — an explicit stop ends the current turn only.`
            : '')
      );
    }

    if (result.delivery === 'idle') {
      return successResponse(
        `Session ${args.sessionId} was idle — nothing was running, so nothing was stopped.`
      );
    }

    // Report the real delivery status instead of an unconditional "sent". A busy
    // target queues the message behind its current turn; an idle target starts
    // now. This is what lets the sender avoid guessing (e.g. never invent "the
    // app restarted") — for actual task status, call list_background_tasks.
    if (result.delivery === 'queued') {
      return successResponse(
        `Message queued for session ${args.sessionId} — it is currently processing another turn. ` +
          `It will handle your message after the current turn finishes. Do not assume it was read yet; ` +
          `wait for a reply or query status before concluding anything.`
      );
    }

    return successResponse(
      `Message delivered to session ${args.sessionId}; it will start processing independently now.`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to send message: ${message}`);
  }
}
