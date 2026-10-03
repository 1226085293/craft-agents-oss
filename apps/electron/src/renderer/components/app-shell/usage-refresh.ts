import type { SessionEvent } from '@craft-agent/shared/protocol'

/** Whether a session event can change the source or skill usage totals. */
export function shouldRefreshUsageStats(event: SessionEvent): boolean {
  if (event.type === 'tool_start') {
    return event.toolName === 'Skill' || event.toolName.startsWith('mcp__')
  }

  return event.type === 'tool_result' && event.toolName === 'Read' && event.isError !== true
}
