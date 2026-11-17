import { describe, it, expect } from 'bun:test';
import {
  EVENT_LIMITS,
  bigramText,
  eventOriginLine,
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

describe('normalizeEventInput: meta', () => {
  it('passes through string provenance records verbatim', () => {
    const event = ok(
      normalizeEventInput(
        { type: 'tg.message', title: 'hi', meta: { channel: 'Ops 群', channelKind: 'group', sender: '张三' } },
        identity,
      ),
    );
    expect(event.meta).toEqual({ channel: 'Ops 群', channelKind: 'group', sender: '张三' });
  });

  it('coerces numbers and booleans, JSON-stringifies objects', () => {
    const event = ok(
      normalizeEventInput(
        { type: 'tg.message', title: 'hi', meta: { threadId: 7, mentionsBot: true, raw: { a: 1 } } },
        identity,
      ),
    );
    expect(event.meta).toEqual({ threadId: '7', mentionsBot: 'true', raw: '{"a":1}' });
  });

  it('caps entry count and value length', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 40; i++) many[`k${i}`] = 'v';
    const event = ok(
      normalizeEventInput(
        { type: 'tg.message', title: 'hi', meta: { long: 'x'.repeat(500), ...many } },
        identity,
      ),
    );
    expect(Object.keys(event.meta!).length).toBe(EVENT_LIMITS.metaEntries);
    expect(event.meta!.long!.length).toBe(EVENT_LIMITS.metaValueLength);
  });

  it('drops malformed entries without rejecting the event', () => {
    const event = ok(
      normalizeEventInput({ type: 'tg.message', title: 'hi', meta: { 'bad key!': 'x', ok_key: 'y' } }, identity),
    );
    expect(event.meta).toEqual({ ok_key: 'y' });
  });

  it('ignores non-object meta entirely', () => {
    const event = ok(normalizeEventInput({ type: 'tg.message', title: 'hi', meta: 'nope' }, identity));
    expect(event.meta).toBeUndefined();
  });
});

describe('eventOriginLine', () => {
  it('renders channel kind, name, id and sender in one line', () => {
    expect(
      eventOriginLine({ channelKind: 'group', channel: 'Ops 群', channelId: '123', sender: '张三' }),
    ).toBe('渠道 群组 Ops 群 id 123，发信人 张三');
  });

  it('omits the sender id when it duplicates the channel id (private chats)', () => {
    expect(
      eventOriginLine({
        channelKind: 'private',
        channelId: '8362946740',
        sender: 'Mark (@mk2077)',
        senderId: '8362946740',
      }),
    ).toBe('渠道 私聊 id 8362946740，发信人 Mark (@mk2077)');
  });

  it('keeps the sender id when it differs from the channel id (groups)', () => {
    expect(
      eventOriginLine({ channelKind: 'group', channel: 'Ops 群', channelId: '123', sender: '张三', senderId: '456' }),
    ).toBe('渠道 群组 Ops 群 id 123，发信人 张三 (id 456)');
  });

  it('falls back to compact JSON for unknown keys only, undefined when empty', () => {
    expect(eventOriginLine({ threadId: '7' })).toBe('meta {"threadId":"7"}');
    expect(eventOriginLine({})).toBeUndefined();
    expect(eventOriginLine(undefined)).toBeUndefined();
  });
});
