/**
 * Plugin actions as tools.
 *
 * A plugin declares what it can do in its manifest (`actions`), and Craft calls
 * back into it. Two tools cover every plugin:
 *
 *   list_plugin_actions  — what is installed, what each action does, its schema
 *   plugin_call          — do one thing
 *
 * The alternative — one tool per action — was rejected because the plugin set is
 * not known ahead of time: a workspace with ten plugins would add tens of tools
 * to every request, and the tool table is already the largest fixed cost in the
 * prompt. Discovery-by-call keeps that bounded and still gives the model the
 * parameter meanings verbatim.
 */

import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: false };
}

function fail(text: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true };
}

interface ActionSummary {
  plugin: string;
  name: string;
  description: string;
  repliesToOrigin?: boolean;
  input: unknown;
}

export async function handleListPluginActions(ctx: SessionToolContext): Promise<ToolResult> {
  if (!ctx.listPluginActionsFn) return fail('list_plugin_actions is not available in this context.');

  const actions = ctx.listPluginActionsFn() as ActionSummary[];
  if (actions.length === 0) {
    return ok(
      'No plugin actions are available. Plugins can only be called when they are installed and enabled in 插件.',
    );
  }

  const lines = actions.map((action) => {
    const origin = action.repliesToOrigin
      ? '\n  replies to the message that triggered this turn — do not pass a destination'
      : '';
    return [
      `- ${action.plugin}.${action.name}: ${action.description}${origin}`,
      `  arguments: ${JSON.stringify(action.input)}`,
    ].join('\n');
  });

  return ok(
    [
      'Available plugin actions (call one with plugin_call):',
      ...lines,
      '',
      'Arguments must match the schema exactly; unknown fields are rejected.',
    ].join('\n'),
  );
}

export async function handlePluginCall(
  ctx: SessionToolContext,
  args: { plugin?: string; action?: string; args?: Record<string, unknown> },
): Promise<ToolResult> {
  if (!ctx.callPluginActionFn) return fail('plugin_call is not available in this context.');

  const plugin = args.plugin?.trim();
  const action = args.action?.trim();
  if (!plugin) return fail('plugin is required, e.g. "messaging".');
  if (!action) return fail('action is required, e.g. "send_message".');

  try {
    const result = await ctx.callPluginActionFn({
      plugin,
      action,
      args: args.args ?? {},
    });
    return result.ok ? ok(result.message) : fail(result.message);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
