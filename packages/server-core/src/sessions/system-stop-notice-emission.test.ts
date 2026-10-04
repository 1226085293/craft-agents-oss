import { describe, expect, it } from 'bun:test'
import { SessionManager, createManagedSession } from './SessionManager.ts'

/**
 * Regression tests for the system-stop notice plumbing (guardrail abort
 * reasons must reach the UI and bound messaging channels).
 *
 * A guardrail in the pi-agent host (busy-limit tool-call cap, no-progress
 * repeat streak) can kill a turn on its own — the user never pressed Stop.
 * The subprocess reports this as an `info` event with `statusType ===
 * 'system_stop'`; SessionManager must re-emit it as a dedicated
 * `system_stop_notice` event so the renderer can show WHY the session went
 * quiet and the messaging gateway can push a notification to bound channels.
 */

function buildSessionManager() {
  const sm = new SessionManager()
  const workspace = {
    id: 'ws_test',
    name: 'Test Workspace',
    rootPath: '/tmp/craft-agent-test',
    createdAt: Date.now(),
  } as unknown as { id: string } & import('./SessionManager.ts').ManagedSession
  const managed = createManagedSession(
    { id: 'sys-stop', name: 'system stop test' } as unknown as { id: string } & Partial<import('./SessionManager.ts').ManagedSession>,
    workspace as never,
    { messagesLoaded: true },
  )
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set('sys-stop', managed)
  return { sm, managed }
}

function captureEvents(sm: SessionManager) {
  const events: unknown[] = []
  ;(sm as unknown as { sendEvent: (e: unknown, _workspaceId?: string) => void }).sendEvent = (e: unknown) => {
    events.push(e)
  }
  return events
}

async function fireInfo(sm: SessionManager, managed: import('./SessionManager.ts').ManagedSession, infoEvent: unknown) {
  await (sm as unknown as { processEvent: (m: unknown, e: unknown) => Promise<void> }).processEvent(managed, infoEvent)
}

describe('SessionManager system-stop notice', () => {
  it('re-emits an info event with statusType system_stop as a system_stop_notice', async () => {
    const { sm, managed } = buildSessionManager()
    const events = captureEvents(sm)

    await fireInfo(sm, managed, {
      type: 'info',
      message: 'Turn aborted: exceeded 500 tool calls in a single turn (busy-limit guardrail).',
      statusType: 'system_stop',
      stopReason: 'busy_limit',
    } as never)

    const notices = events.filter((e) => (e as { type?: string }).type === 'system_stop_notice')
    expect(notices).toHaveLength(1)
    const notice = notices[0] as { type: string; reason: string; message: string; sessionId: string }
    expect(notice.sessionId).toBe('sys-stop')
    expect(notice.reason).toBe('busy_limit')
    expect(notice.message).toContain('500 tool calls')
  })

  it('falls back to the system_stop key when stopReason is missing', async () => {
    const { sm, managed } = buildSessionManager()
    const events = captureEvents(sm)

    await fireInfo(sm, managed, {
      type: 'info',
      message: 'Turn aborted by the system.',
      statusType: 'system_stop',
    } as never)

    const notices = events.filter((e) => (e as { type?: string }).type === 'system_stop_notice')
    expect(notices).toHaveLength(1)
    expect((notices[0] as { reason: string }).reason).toBe('system_stop')
  })

  it('plain info events are NOT re-emitted as stop notices', async () => {
    const { sm, managed } = buildSessionManager()
    const events = captureEvents(sm)

    await fireInfo(sm, managed, {
      type: 'info',
      message: 'Verification failed — continuing',
      statusType: 'verification_failed',
    } as never)

    const notices = events.filter((e) => (e as { type?: string }).type === 'system_stop_notice')
    expect(notices).toEqual([])
  })
})
