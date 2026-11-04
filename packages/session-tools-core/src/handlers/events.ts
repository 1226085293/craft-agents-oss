/**
 * Session tools for the Event Center.
 *
 * A session starts with **no** subscriptions: events are opt-in, because an
 * active mailbox would otherwise flood a conversation.
 *
 * Like the rest of this package, everything comes through `SessionToolContext`
 * callbacks — no imports from `@craft-agent/shared` or `@craft-agent/server-core`,
 * which keeps this package's rootDir self-contained.
 */

import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';

export interface SubscribeEventArgs {
  sources?: string[];
  types?: string[];
}

export interface UnsubscribeEventArgs {
  subscriptionId?: string;
  source?: string;
}

export interface ListEventsArgs {
  source?: string;
  type?: string;
  search?: string;
  limit?: number;
}

export interface GetEventArgs {
  id: string;
}

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function fail(text: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true };
}

function describeFilter(filter: { sources?: string[]; types?: string[] }): string {
  const parts: string[] = [];
  if (filter.sources?.length) parts.push(`sources=${filter.sources.join('|')}`);
  if (filter.types?.length) parts.push(`types=${filter.types.join('|')}`);
  return parts.length ? parts.join(', ') : 'everything';
}

export async function handleSubscribeEvent(
  ctx: SessionToolContext,
  args: SubscribeEventArgs,
): Promise<ToolResult> {
  if (!ctx.subscribeEventFn) return fail('subscribe_event is not available in this context.');

  const filter = {
    ...(args.sources?.length ? { sources: args.sources } : {}),
    ...(args.types?.length ? { types: args.types } : {}),
  };

  try {
    const result = await ctx.subscribeEventFn(filter);
    return ok(
      `Subscribed (${result.subscriptionId}) to ${describeFilter(filter)}. ` +
        `This session now has ${result.total} subscription(s). ` +
        `Events arrive as \`[event]\` messages; use get_event("<id>") for the full text.`,
    );
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export async function handleUnsubscribeEvent(
  ctx: SessionToolContext,
  args: UnsubscribeEventArgs,
): Promise<ToolResult> {
  if (!ctx.unsubscribeEventFn) return fail('unsubscribe_event is not available in this context.');
  if (!args.subscriptionId && !args.source) {
    return fail('Provide subscriptionId or source. Use list_event_subscriptions to see them.');
  }
  try {
    const result = await ctx.unsubscribeEventFn({
      ...(args.subscriptionId ? { subscriptionId: args.subscriptionId } : {}),
      ...(args.source ? { source: args.source } : {}),
    });
    return ok(`Removed ${result.removed} subscription(s). ${result.remaining} remaining.`);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export async function handleListEventSubscriptions(ctx: SessionToolContext): Promise<ToolResult> {
  if (!ctx.listEventSubscriptionsFn) return fail('list_event_subscriptions is not available in this context.');
  const subscriptions = ctx.listEventSubscriptionsFn();
  if (subscriptions.length === 0) return ok('This session has no event subscriptions.');
  return ok(
    subscriptions
      .map((sub) => `- ${sub.subscriptionId}: ${describeFilter(sub.filter)}`)
      .join('\n'),
  );
}

export async function handleListEvents(
  ctx: SessionToolContext,
  args: ListEventsArgs,
): Promise<ToolResult> {
  if (!ctx.listEventsFn) return fail('list_events is not available in this context.');
  const rows = ctx.listEventsFn({
    ...(args.source ? { source: args.source } : {}),
    ...(args.type ? { type: args.type } : {}),
    ...(args.search ? { search: args.search } : {}),
    limit: Math.min(args.limit ?? 20, 100),
  });

  if (rows.length === 0) return ok('No events match that filter.');
  return ok(
    rows
      .map(
        (event) =>
          `- ${event.id} · ${event.type} · ${event.source} · ${new Date(event.receivedAt).toISOString()}\n  ${event.title}${event.summary ? ` — ${event.summary}` : ''}`,
      )
      .join('\n'),
  );
}

export async function handleGetEvent(ctx: SessionToolContext, args: GetEventArgs): Promise<ToolResult> {
  if (!ctx.getEventFn) return fail('get_event is not available in this context.');
  if (!args.id) return fail('id is required');

  const event = ctx.getEventFn(args.id);
  if (!event) return ok(`Event ${args.id} not found (it may have been pruned).`);

  const header = [
    `type: ${event.type}`,
    `source: ${event.source}`,
    `received: ${new Date(event.receivedAt).toISOString()}`,
    ...(event.occurredAt !== undefined ? [`occurred: ${new Date(event.occurredAt).toISOString()}`] : []),
    `title: ${event.title}`,
    ...(event.summary ? [`summary: ${event.summary}`] : []),
    ...(event.recipients.length ? [`recipients: ${event.recipients.join(', ')}`] : []),
    ...(event.payloadPath ? [`payload: ${event.payloadPath}`] : []),
  ].join('\n');

  // 64KB cap: a mail body can be huge and the payload path is right there.
  const body = event.body === undefined ? '(no body)' : event.body.slice(0, 64 * 1024);
  return ok(`${header}\n\n${body}`);
}
