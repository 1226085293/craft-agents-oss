import type { Message } from '../../shared/types'

/**
 * Is a tool still in flight?
 *
 * A tool message with a non-terminal status (pending / executing) means the
 * agent is legitimately busy and will emit events when the tool completes.
 * Long-running tools (e.g. `sleep 240`, installers) produce no events for
 * potentially minutes, so the stale-session watchdog must NOT treat such a
 * session as stuck — refreshing it mid-tool would clobber transient UI state
 * (optimistic timestamps, live process rows).
 *
 * Terminal statuses (from ToolStatus): completed / error / backgrounded.
 */
export function hasRunningTool(messages: Message[] | undefined): boolean {
  if (!messages || messages.length === 0) return false
  return messages.some(m =>
    m.role === 'tool' && (m.toolStatus === 'executing' || m.toolStatus === 'pending')
  )
}
