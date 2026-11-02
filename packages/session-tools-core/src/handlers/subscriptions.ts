/**
 * Session subscription tools.
 *
 * A session may follow another session in the same workspace: every finished
 * turn is delivered to the subscriber as a hidden message, which wakes it.
 * Subscriptions are persisted per workspace by SessionManager
 * (`config/session-subscriptions.json`) and survive restarts.
 */

import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';

export interface SubscribeSessionArgs {
  sessionId: string;
}

export interface UnsubscribeSessionArgs {
  sessionId: string;
}

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function fail(text: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true };
}

export async function handleSubscribeSession(
  ctx: SessionToolContext,
  args: SubscribeSessionArgs,
): Promise<ToolResult> {
  if (!ctx.subscribeSessionFn) return fail('subscribe_session is not available in this context.');
  const targetId = args.sessionId?.trim();
  if (!targetId) return fail('sessionId is required.');
  if (targetId === ctx.sessionId) return fail('A session cannot subscribe to itself.');

  try {
    const result = await ctx.subscribeSessionFn(targetId);
    const following = result.targetIds.length > 0 ? result.targetIds.join(', ') : '(none)';
    return ok(
      `Following session ${targetId}. Each finished turn will be posted here and wake you. ` +
        `Currently following: ${following}.`,
    );
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export async function handleUnsubscribeSession(
  ctx: SessionToolContext,
  args: UnsubscribeSessionArgs,
): Promise<ToolResult> {
  if (!ctx.unsubscribeSessionFn) return fail('unsubscribe_session is not available in this context.');
  const targetId = args.sessionId?.trim();
  if (!targetId) return fail('sessionId is required.');

  try {
    const result = await ctx.unsubscribeSessionFn(targetId);
    if (!result.unsubscribed) {
      return ok(`This session was not following ${targetId}; nothing to stop.`);
    }
    const following = result.targetIds.length > 0 ? result.targetIds.join(', ') : '(none)';
    return ok(`Stopped following ${targetId}. Currently following: ${following}.`);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export async function handleListSubscriptions(ctx: SessionToolContext): Promise<ToolResult> {
  if (!ctx.listSubscriptionsFn) return fail('list_subscriptions is not available in this context.');
  const ids = ctx.listSubscriptionsFn();
  if (ids.length === 0) return ok('This session is not following any sessions.');
  return ok(`Following ${ids.length} session(s): ${ids.join(', ')}.`);
}
