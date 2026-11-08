import { describe, expect, it } from 'bun:test'
import { attachSessionSelfManagementBindings } from '../session-self-management-bindings.ts'
import {
  registerSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
} from '../session-scoped-tool-callback-registry.ts'

/**
 * `/stop` from one agent to another arrived as ordinary chat.
 *
 * The tool handler decides whether to wrap a message in the sender envelope by asking
 * `ctx.isSessionCommand`. The callback was registered on the session-scoped registry and
 * injected by SessionManager, but nothing copied it onto the tool context — the lookup
 * returned undefined, `isCommand` was false, and the message went out as
 *
 *     [Message from session "…"] --- /stop
 *
 * The target parses that as content, so the stop was queued behind a turn instead of ending it.
 * Observed: the supervisor reported having sent `/stop`, marked the task completed, and the
 * worker kept running until it stalled on its own.
 */
describe('a session command sent between agents', () => {
  it('is recognised through the tool context', () => {
    const sessionId = 'sess_binding_test'
    registerSessionScopedToolCallbacks(sessionId, {
      isSessionCommand: (text: string) => text.trim() === '/stop',
    })
    const context: Record<string, unknown> = {}
    attachSessionSelfManagementBindings(context as never, sessionId)

    const isCommand = context.isSessionCommand as ((t: string) => boolean) | undefined
    expect(isCommand?.('/stop')).toBe(true)
    expect(isCommand?.('please stop')).toBe(false)
    unregisterSessionScopedToolCallbacks(sessionId)
  })

  it('is undefined when the session registered nothing', () => {
    const sessionId = 'sess_binding_empty'
    registerSessionScopedToolCallbacks(sessionId, {})
    const context: Record<string, unknown> = {}
    attachSessionSelfManagementBindings(context as never, sessionId)
    // The handler treats "no callback" as "not a command", which is the safe default.
    expect(context.isSessionCommand).toBeUndefined()
    unregisterSessionScopedToolCallbacks(sessionId)
  })
})
