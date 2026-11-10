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

/**
 * Tool scope declared by the task a session was spawned for.
 *
 * `allow` narrows what the role already permits; `deny` removes specific tools
 * from that set. Neither can widen: the role check runs inside
 * `getToolDefsAsJsonSchema` first, so a task asking for `bash` on a supervisor
 * task still gets nothing.
 */
export interface SessionToolScope {
  allow?: readonly string[]
  deny?: readonly string[]
}

export function getSessionToolProxyDefs(
  role?: 'supervisor' | 'worker',
  scope?: SessionToolScope,
  /**
   * Which supervisor conversation this is, when the role is `supervisor`.
   *
   * Both lanes are supervisors, so the role alone handed the user-facing lane the
   * dispatcher — while its prompt says, in as many words, 「不推进任务、不派活」. A model holding
   * a tool its instructions forbid does one of two things: uses it, or spends the turn deciding
   * not to. Neither is the job.
   */
  supervisorLane?: 'user' | 'task',
): SessionToolProxyDef[] {
  const defs = getToolDefsAsJsonSchema({
    prefix: 'mcp__session__',
    includeDeveloperFeedback: FEATURE_FLAGS.developerFeedback,
    ...(role ? { role } : {}),
    ...(supervisorLane ? { supervisorLane } : {}),
    ...(scope?.allow ? { allowedTools: scope.allow } : {}),
    ...(scope?.deny ? { deniedTools: scope.deny } : {}),
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
