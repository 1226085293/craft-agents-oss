import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionManager, createManagedSession } from './SessionManager.ts'

/**
 * System text must queue behind a running turn, never steer into it.
 *
 * `sendMessage` defaults to the connection's `midStreamBehavior`, and that default is `steer`
 * for every provider. Steer exists for a person typing a follow-up: their sentence is guidance
 * for the turn already in flight. A system message is not guidance — it announces something
 * that happened elsewhere, and injecting it mid-reasoning asks the target to answer for work it
 * has not finished.
 *
 * The concrete race: a worker reports, the supervisor is woken while that worker is still
 * writing its closing lines, and the follow-up dispatch lands inside the very turn it was
 * meant to follow.
 */
describe('system messages to a session', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-system-'))
    sm = new SessionManager()
  })

  afterEach(async () => {
    await sm.flushAllSessions()
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildSession(id: string) {
    const workspace = {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession({ id, name: 'system message test' }, workspace as never, {
      messagesLoaded: true,
    })
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  /** A busy session whose backend *can* steer — so a steer would visibly happen. */
  function busySession(id: string) {
    const managed = buildSession(id)
    managed.isProcessing = true
    const redirected: string[] = []
    const aborted: string[] = []
    managed.agent = {
      redirect: (message: string) => {
        redirected.push(message)
        return true
      },
      forceAbort: (reason: string) => {
        aborted.push(reason)
      },
    } as never
    return { managed, redirected, aborted }
  }

  const sendSystem = (sessionId: string, text: string) =>
    (sm as unknown as { sendSystemMessage: (s: string, t: string) => Promise<void> }).sendSystemMessage(
      sessionId,
      text,
    )

  it('queues instead of steering into the running turn', async () => {
    const { managed, redirected, aborted } = busySession('system-queue')

    await sendSystem('system-queue', '〔任务进展〕T-1 交接通过')

    expect(redirected).toEqual([])
    expect(aborted).toEqual([])
    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.messageQueue[0]?.message).toBe('〔任务进展〕T-1 交接通过')
  })

  /**
   * The control case. Without the explicit option the same call is steered, which is what makes
   * the assertion above meaningful rather than an artifact of the harness.
   */
  it('would have steered without the option — proving the option is what decides', async () => {
    const { managed, redirected } = busySession('system-steer-control')

    await sm.sendMessage('system-steer-control', '「交接通过」')

    expect(redirected).toEqual(['「交接通过」'])
    expect(managed.messageQueue).toHaveLength(0)
  })

  /**
   * The idle case is not a mid-stream decision at all: `midStreamBehavior` is only consulted
   * inside the `isProcessing` branch, so an idle target simply receives the message as a turn.
   * Asserted on the guard rather than by driving a full turn — the option cannot reach a code
   * path that is never entered.
   */
  it('does not steer when the target is idle — the option is not even consulted', async () => {
    const managed = buildSession('system-idle')
    const redirected: string[] = []
    managed.agent = { redirect: (m: string) => { redirected.push(m); return true } } as never

    // Same call shape as sendSystemMessage, with no running turn to steer into.
    await sm.sendMessage('system-idle', '〔任务进展〕T-1 交接通过', undefined, undefined, {
      midStreamBehavior: 'queue',
    }).catch(() => {
      // A bare fake agent cannot run a turn; what matters is that nothing was steered.
    })

    expect(redirected).toEqual([])
    expect(managed.messageQueue).toHaveLength(0)
  })
})
