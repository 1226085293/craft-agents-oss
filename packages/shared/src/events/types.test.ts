import { describe, it, expect } from 'bun:test';
import {
  EVENT_LIMITS,
  bigramText,
  normalizeEventInput,
  type CraftEventEnvelope,
} from './types.ts';

// Received after the ISO timestamp used in the occurredAt case, so that case
// exercises parsing rather than the future-clock rejection.
const identity = { id: 'evt_1', source: 'qqmail', receivedAt: Date.parse('2026-11-03T15:00:00.000Z') };

function ok(result: ReturnType<typeof normalizeEventInput>): CraftEventEnvelope {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.path} ${result.message}`);
  return result.event;
}

describe('normalizeEventInput', () => {
  it('always takes identity fields from the server, not the payload', () => {
    const event = ok(
      normalizeEventInput(
        { type: 'mail.received', title: 'hi', id: 'forged', source: 'other', receivedAt: 0 },
        identity,
      ),
    );
    expect(event.id).toBe('evt_1');
    expect(event.source).toBe('qqmail');
    expect(event.receivedAt).toBe(identity.receivedAt);
    expect(event.spec).toBe('craft-event/1');
    // Handling is a fact about the store, not about the envelope a listener submits.
    expect(event.handledAt).toBeUndefined();
  });

  it('requires a namespaced lowercase type', () => {
    for (const bad of ['mail', 'Mail.Received', 'mail.', 'mail.received.extra', '1mail.received']) {
      const result = normalizeEventInput({ type: bad, title: 't' }, identity);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.path).toBe('type');
    }
    expect(ok(normalizeEventInput({ type: 'github.pull_request', title: 't' }, identity)).type).toBe(
      'github.pull_request',
    );
  });

  it('requires a title and enforces its length', () => {
    expect(normalizeEventInput({ type: 'a.b' }, identity).ok).toBe(false);
    const long = 'x'.repeat(EVENT_LIMITS.title + 1);
    const result = normalizeEventInput({ type: 'a.b', title: long }, identity);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.path).toBe('title');
  });

  it('rejects bodies over the inline limit instead of truncating', () => {
    const big = 'y'.repeat(EVENT_LIMITS.bodyBytes + 1);
    const result = normalizeEventInput({ type: 'a.b', title: 't', body: big }, identity);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('body_too_large');
      expect(result.path).toBe('body');
    }
  });

  it('serializes object bodies and keeps string bodies as-is', () => {
    expect(ok(normalizeEventInput({ type: 'a.b', title: 't', body: { k: 1 } }, identity)).body).toBe(
      '{"k":1}',
    );
    expect(ok(normalizeEventInput({ type: 'a.b', title: 't', body: 'raw' }, identity)).body).toBe('raw');
  });

  it('caps recipients and links', () => {
    const recipients = Array.from({ length: EVENT_LIMITS.recipients + 1 }, (_, i) => `u${i}@x.com`);
    expect(normalizeEventInput({ type: 'a.b', title: 't', recipients }, identity).ok).toBe(false);

    const links = Array.from({ length: EVENT_LIMITS.links + 1 }, () => ({ url: 'https://x' }));
    const r3 = normalizeEventInput({ type: 'a.b', title: 't', links }, identity);
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.path).toBe('links');
  });

  it('drops empty recipient entries and keeps rel only when present', () => {
    const event = ok(
      normalizeEventInput(
        { type: 'a.b', title: 't', recipients: [' me@qq.com ', '', '  '], links: [{ url: 'https://x' }] },
        identity,
      ),
    );
    expect(event.recipients).toEqual(['me@qq.com']);
    expect(event.links).toEqual([{ url: 'https://x' }]);
  });

  it('parses occurredAt from ISO strings and rejects far-future timestamps', () => {
    const iso = '2026-11-03T14:20:08.000Z';
    expect(ok(normalizeEventInput({ type: 'a.b', title: 't', occurredAt: iso }, identity)).occurredAt).toBe(
      Date.parse(iso),
    );

    const future = identity.receivedAt + EVENT_LIMITS.clockSkewMs + 1000;
    const result = normalizeEventInput({ type: 'a.b', title: 't', occurredAt: future }, identity);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.path).toBe('occurredAt');

    expect(normalizeEventInput({ type: 'a.b', title: 't', occurredAt: 'not-a-date' }, identity).ok).toBe(false);
  });

  it('rejects non-object payloads', () => {
    for (const bad of [null, [], 'str', 42]) {
      expect(normalizeEventInput(bad, identity).ok).toBe(false);
    }
  });

  it('carries payloadRef through when well formed', () => {
    const event = ok(
      normalizeEventInput(
        { type: 'a.b', title: 't', payloadRef: { kind: 'eml', path: 'p/x.eml', size: 12 } },
        identity,
      ),
    );
    expect(event.payloadRef).toEqual({ kind: 'eml', path: 'p/x.eml', size: 12 });
  });
});

describe('bigramText', () => {
  it('splits CJK characters so 2-character queries can match', () => {
    expect(bigramText('请确认付款条款')).toBe('请 确 认 付 款 条 款');
  });

  it('keeps latin words intact and separates them from CJK', () => {
    expect(bigramText('Invoice 发票')).toBe('Invoice 发 票');
  });

  it('collapses whitespace and handles empty input', () => {
    expect(bigramText(undefined)).toBe('');
    expect(bigramText('')).toBe('');
    expect(bigramText('  a   b  ')).toBe('a b');
  });

  it('keeps kana in the unsegmented path', () => {
    expect(bigramText('メール')).toBe('メ ー ル');
  });
});
