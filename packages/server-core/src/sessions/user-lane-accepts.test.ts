/**
 * Whether a supervisor's words reach the person.
 *
 * This is the guard that decides it, and it is where a new kind gets silently swallowed: `notice`
 * was added to the tool schema but not here, so every scheduled 「你好+N」 was written back into the
 * supervisor's own hidden session — the person received nothing, which is the exact failure the kind
 * was introduced to fix.
 *
 * Kept as a pure predicate so the answer can be asserted without building a session.
 */
import { describe, expect, it } from 'bun:test';
import { userLaneAccepts } from './SessionManager.ts';

describe('what a supervisor may say to the person', () => {
  it('delivers a notice', () => {
    expect(userLaneAccepts('notice')).toBe(true);
  })

  it('delivers a conclusion, a question, and a blockage', () => {
    for (const kind of ['completed', 'decision', 'blocked']) {
      expect({ kind, accepted: userLaneAccepts(kind) }).toEqual({ kind, accepted: true });
    }
  })

  it('keeps narration off the person lane', () => {
    // The reason the guard exists: a supervisor narrating 「正在派活」 into the conversation the person
    // reads. Anything unrecognised is treated as narration rather than as a message.
    for (const kind of ['progress', 'status', 'info', 'typing', '']) {
      expect({ kind, accepted: userLaneAccepts(kind) }).toEqual({ kind, accepted: false });
    }
  })
})
