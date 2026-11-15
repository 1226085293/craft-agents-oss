/**
 * How 「任务督导中断，请检查」 reaches the person.
 *
 * It is a message from the system, and it has to look like one: an agent bubble, not a grey status
 * line (`role: 'info'`) and not a bespoke card type of its own. Three shapes were tried before this
 * one settled, and each of the first two was wrong in a way only a reader would notice —
 *
 *   - `sendMessage` wrote it as `type: 'user'`, so the conversation showed a sentence the person
 *     never typed (live 2026-11-15 17:11 in 261115-soft-moor, two such rows 1.3 s apart);
 *   - `role: 'info'` drew it as 13px grey chrome in the same class as 「Conversation Compacted」,
 *     which reads as something to skim past;
 *   - a dedicated `system_notice` bubble added a second visual language for a distinction nobody
 *     asked for.
 *
 * These assertions are about the shape, which is not observable from the pure functions next door:
 * `classifyTaskFaultOutcome` decides *whether* to speak, never *how it looks*.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const source = readFileSync(join(import.meta.dir, 'SessionManager.ts'), 'utf8')

/** The body of `notifyPerson`, from its signature to the closing brace before the next method. */
function notifyPersonBody(): string {
  const start = source.indexOf('private notifyPerson(')
  expect(start).toBeGreaterThan(-1)
  const next = source.indexOf('\n  private setProcessing(', start)
  expect(next).toBeGreaterThan(start)
  return source.slice(start, next)
}

describe('the stalled-supervisor notice is drawn as a message from the system', () => {
  it('writes an agent bubble, not a status line', () => {
    expect(notifyPersonBody()).toContain('asAssistantBubble: true')
  })

  it('does not use a bespoke card type for it', () => {
    const body = notifyPersonBody()
    expect(body).not.toContain('system_notice')
    expect(body).not.toContain("statusType: 'decision_request'")
  })

  /**
   * The row must not address the model. `sendMessage` is what made it look like the person's own
   * words, and it also starts a turn — the notice is a report about the system, not speech to it.
   */
  it('does not go through sendMessage', () => {
    expect(notifyPersonBody()).not.toContain('sendMessage')
  })

  /**
   * Dedupe keyed on the role was the bug this guards: as an assistant bubble the role is
   * `'assistant'`, so a `role === 'info'` lookup would never find the row it had just written and
   * the fault would have repeated on every turn.
   */
  it('dedupes on the notice key, not on a role that the row no longer has', () => {
    expect(notifyPersonBody()).toContain('message.noticeKey === key')
    expect(notifyPersonBody()).not.toContain("message.role === 'info' &&")
  })

  /**
   * The bubble is relayed, so the supervisor-answer accounting skips it — otherwise a notice would
   * count as the turn having spoken and clear the very silence counter that produced it.
   */
  it('marks the row relayed, so it is never read as this session’s reply', () => {
    expect(source).toContain('...(row.asAssistantBubble ? { isRelayed: true } : {}),')
  })
})
