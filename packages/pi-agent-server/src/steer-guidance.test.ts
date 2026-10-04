import { describe, expect, it } from 'bun:test';
import { wrapMidTurnGuidance } from './steer-guidance.ts';

describe('wrapMidTurnGuidance (261007-misty-plain incident)', () => {
  it('keeps the raw guidance text first, then appends the ordered-mandate note', () => {
    const wrapped = wrapMidTurnGuidance('你叫什么名字');
    expect(wrapped).toContain('你叫什么名字');
    expect(wrapped.startsWith('你叫什么名字')).toBe(true);
    // wise-boulder: ordered mandate — complete the original task FIRST,
    // then address the guidance, without re-listing already-shown content.
    expect(wrapped).toContain('(1) FIRST complete the original request');
    expect(wrapped).toContain('(2) THEN address the guidance');
    expect(wrapped).toContain('Do NOT repeat or re-list');
  });

  it('preserves the guidance verbatim (including its own newlines)', () => {
    const text = 'line one\nline two';
    const wrapped = wrapMidTurnGuidance(text);
    expect(wrapped.slice(0, text.length)).toBe(text);
  });

  it('returns the message unchanged when it is empty or whitespace-only', () => {
    expect(wrapMidTurnGuidance('')).toBe('');
    expect(wrapMidTurnGuidance('   \n  ')).toBe('   \n  ');
  });

  it('treats nullish input as a no-op', () => {
    expect(wrapMidTurnGuidance(undefined as unknown as string)).toBe(undefined);
    expect(wrapMidTurnGuidance(null as unknown as string)).toBe(null);
  });

  it('is a pure function — same input always yields same output', () => {
    expect(wrapMidTurnGuidance('hi')).toBe(wrapMidTurnGuidance('hi'));
  });

  it('note is safe wording: no-op when the original request was already answered', () => {
    const wrapped = wrapMidTurnGuidance('any text');
    // The "(1) FIRST complete ... if you collected results but have not
    // presented them ..." wording is a no-op when the main request was
    // already completed before the drain (the 261007-active-wren / slim-
    // badger shape) — nothing left to present.
    expect(wrapped).toContain('Do NOT repeat');
    expect(wrapped).toContain('have not presented');
    expect(wrapped).not.toMatch(/^complete/i);
  });

  it('wise-boulder regression: the three rules appear in MANDATE order', () => {
    // 261007-wise-boulder: two queued steers → the model answered steer 1,
    // then steer 2, and never delivered the original folder listing. The
    // rules must be ordered (1) before (2) before (3).
    const wrapped = wrapMidTurnGuidance('告诉我你的名字');
    const r1 = wrapped.indexOf('(1) FIRST complete')
    const r2 = wrapped.indexOf('(2) THEN address')
    const r3 = wrapped.indexOf('(3) Do NOT repeat')
    expect(r1).toBeGreaterThan(-1)
    expect(r2).toBeGreaterThan(r1)
    expect(r3).toBeGreaterThan(r2)
    // tool output explicitly called out (the folders case)
    expect(wrapped).toContain('tool output')
  });

  it('slim-badger regression: tells the model its earlier replies are shown to the user', () => {
    // 261007-slim-badger: the drain re-listed the desktop folders with "刚才
    // 已经列出来了" even though the main reply (re-promoted by text_promote)
    // was already visible — the old note gave no visibility information.
    const wrapped = wrapMidTurnGuidance('还有你叫什么？');
    expect(wrapped).toContain('shown to the user');
  });
});
