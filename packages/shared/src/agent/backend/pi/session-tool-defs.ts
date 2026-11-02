/**
 * Pi Session Tool Proxy Definitions
 *
 * Thin wrapper around the canonical tool definitions in @craft-agent/session-tools-core.
 * Adds the `mcp__session__` prefix that the Pi SDK expects.
 */

import {
  getToolDefsAsJsonSchema,
  SESSION_TOOL_NAMES,
  type JsonSchemaToolDef,
} from '@craft-agent/session-tools-core';
import { FEATURE_FLAGS } from '../../../feature-flags.ts';

export type SessionToolProxyDef = JsonSchemaToolDef;

export { SESSION_TOOL_NAMES };

/**
 * Only script/command runners get the background flag. Other session tools
 * (LLM calls, browser, memory, session mutations) are not OS-process-backed
 * and must not enter the background task lifecycle.
 */
const BACKGROUNDABLE_TOOLS = new Set([
  'script_sandbox',
  'transform_data',
]);

export function getSessionToolProxyDefs(): SessionToolProxyDef[] {
  const defs = getToolDefsAsJsonSchema({
    prefix: 'mcp__session__',
    includeDeveloperFeedback: FEATURE_FLAGS.developerFeedback,
  });

  return defs.map((def) => {
    const plainName = def.name.replace(/^mcp__session__/, '');
    if (!BACKGROUNDABLE_TOOLS.has(plainName)) return def;

    const schema = def.inputSchema as {
      properties?: Record<string, unknown>;
    } | undefined;
    if (!schema || typeof schema !== 'object') return def;

    return {
      ...def,
      inputSchema: {
        ...schema,
        properties: {
          ...(schema.properties ?? {}),
          background: {
            type: 'boolean',
            description:
              'Run this tool in the background and return a task id immediately. ' +
              'Use for operations expected to take longer than 30s; omit to let the 30s auto-handoff decide.',
          },
        },
      },
    };
  });
}
