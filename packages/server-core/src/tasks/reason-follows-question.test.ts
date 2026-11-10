import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskService } from './task-service.ts'

/**
 * The pause reason is a function of the decision record, not a second record of it.
 *
 * Reported live: the board listed the task as 「awaiting_release · 需要你决定」 and the conversation
 * showed a card headed 「需要你决定」 while the task page said 「已按你的指示停在这里」. All three were
 * reading the same task. The supervisor had parked the delivered slice as `awaiting_release` and
 * then asked a question; writing the question updated the decision but not the reason, so one state
 * had two descriptions and neither surface was wrong on its own terms.
 */
describe('the reason follows the question', () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'reason-'))
    const svc = new TaskService({
      workspaceRoot: root,
      onChanged: () => {},
      sessionExists: () => true,
      wakeSupervisor: () => {},
    })
    const task = svc.create({
      name: 'x',
      instruction: 'x',
      supervisorSessionId: 'sess_sup',
      toolCallId: `call_${Math.random().toString(36).slice(2)}`,
      spec: { cwd: root, scope: '只做 1.1' } as never,
    })
    return { svc, task, root }
  }

  it('turns 「按指示停了」 into 「等你决定」 when a question is asked', () => {
    const { svc, task, root } = setup()
    svc.setStatus(task.id, 'running')
    svc.setStatus(task.id, 'paused', { pauseReason: 'awaiting_release' })
    expect(svc.get(task.id)?.pauseReason).toBe('awaiting_release')

    svc.setDecisionWording(task.id, { label: '需要你决定', question: '要继续吗？' })

    // A card is on screen; the board must not still say the task is only stopped on instruction.
    expect(svc.get(task.id)?.pauseReason).toBe('needs_decision')
    rmSync(root, { recursive: true, force: true })
  })

  it('keeps 「按指示停了」 when nothing is asked', () => {
    const { svc, task, root } = setup()
    svc.setStatus(task.id, 'running')
    svc.setStatus(task.id, 'paused', { pauseReason: 'awaiting_release' })

    // A closed decision from an earlier round must not resurrect a decision pause.
    expect(svc.get(task.id)?.pauseReason).toBe('awaiting_release')
    rmSync(root, { recursive: true, force: true })
  })

  it('does not describe a failure as a decision', () => {
    const { svc, task, root } = setup()
    svc.setStatus(task.id, 'running')
    // Three failed runs: the fuse is what makes `failures` true, and the reason is derived from
    // the record now. Claiming it without the failures would be cleared to nothing.
    for (let i = 0; i < 3; i += 1) svc.endRun(task.id, { ok: false, error: `尝试 ${i + 1} 失败` })
    svc.setStatus(task.id, 'paused', { pauseReason: 'failures' })
    expect(svc.get(task.id)?.pauseReason).toBe('failures')
    svc.setDecisionWording(task.id, { question: '还试吗？' })

    // Both are true, and the failure is what went wrong. Rewriting it hid the diagnosis.
    expect(svc.get(task.id)?.pauseReason).toBe('failures')
    rmSync(root, { recursive: true, force: true })
  })

  it('reports 「等问句」 when a pause has no record yet', () => {
    const { svc, task, root } = setup()
    svc.setStatus(task.id, 'running')
    svc.setStatus(task.id, 'paused', { pauseReason: 'needs_decision' })

    // Paused to ask, nothing written: a question is still owed, so this is not 「已暂停」.
    expect(svc.get(task.id)?.pauseReason).toBe('asking')
    rmSync(root, { recursive: true, force: true })
  })
})
