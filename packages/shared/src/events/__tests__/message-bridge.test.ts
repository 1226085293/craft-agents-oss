import { describe, expect, it } from 'bun:test';

import { bridgeMessage, messageDedupeKey, type BridgeableMessage } from '../message-bridge.ts';

function msg(overrides: Partial<BridgeableMessage> = {}): BridgeableMessage {
  return {
    platform: 'telegram',
    channelId: 'group-1',
    messageId: 'm-1',
    senderId: 'u-1',
    senderName: '张三',
    text: '在吗',
    chatKind: 'group',
    ...overrides,
  };
}

const rules = { channels: ['group-1'], keywords: ['报错', '部署'], onMention: true };
const botNames = ['craft_bot'];
const ctx = { rules, botNames, now: 1_800_000_000_000, newId: () => 'evt_test' };

describe('message bridge', () => {
  it('treats a DM as user input, never as an event', () => {
    const verdict = bridgeMessage(msg({ chatKind: 'private' }), { ...ctx, botNames: [] });
    expect(verdict.kind).toBe('user-input');
  });

  it('ignores a group that is not whitelisted, even when it mentions the bot', () => {
    const verdict = bridgeMessage(msg({ channelId: 'other-group', text: '@craft_bot 帮我' }), ctx);
    expect(verdict.kind).toBe('ignored');
    expect(verdict.kind === 'ignored' && verdict.reason).toContain('白名单');
  });

  it('ignores everything in a group when no channel is configured', () => {
    const verdict = bridgeMessage(msg({ text: '@craft_bot 帮我' }), { ...ctx, rules: {} });
    expect(verdict.kind).toBe('ignored');
  });

  it('turns a keyword hit into an event', () => {
    const verdict = bridgeMessage(msg({ text: '刚部署的版本报错了' }), ctx);
    expect(verdict.kind).toBe('event');
    if (verdict.kind !== 'event') throw new Error('expected event');
    expect(verdict.event.source).toBe('telegram');
    expect(verdict.event.type).toBe('message.mention');
    expect(verdict.event.title).toContain('张三');
    expect(verdict.event.title).toMatch(/报错|部署/);
  });

  it('turns an @-mention into an event', () => {
    const verdict = bridgeMessage(msg({ text: '@craft_bot 看一下' }), ctx);
    expect(verdict.kind).toBe('event');
  });

  it('stays silent when neither keyword nor mention is present', () => {
    const verdict = bridgeMessage(msg({ text: '今天天气不错' }), ctx);
    expect(verdict.kind).toBe('ignored');
    expect(verdict.kind === 'ignored' && verdict.reason).toContain('关键词');
  });

  it('can be configured to ignore mentions and only fire on keywords', () => {
    const verdict = bridgeMessage(msg({ text: '@craft_bot 看一下' }), {
      ...ctx,
      rules: { ...rules, onMention: false },
    });
    expect(verdict.kind).toBe('ignored');
  });

  it('carries a link back to the message (the five-field rule)', () => {
    const verdict = bridgeMessage(msg({ text: '报错了' }), ctx);
    if (verdict.kind !== 'event') throw new Error('expected event');
    expect(verdict.event.links).toHaveLength(1);
    expect(verdict.event.links[0]?.url).toContain('group-1');
  });

  it('uses the platform message id as dedupe key so a replay is idempotent', () => {
    const a = bridgeMessage(msg({ text: '报错了' }), ctx);
    const b = bridgeMessage(msg({ text: '报错了' }), { ...ctx, newId: () => 'evt_other' });
    if (a.kind !== 'event' || b.kind !== 'event') throw new Error('expected events');
    expect(a.event.dedupeKey).toBe(b.event.dedupeKey);
    expect(a.event.id).not.toBe(b.event.id);
  });

  it('scopes the dedupe key to the thread, so two topics do not collide', () => {
    const base = messageDedupeKey(msg());
    const threaded = messageDedupeKey(msg({ threadId: 7 }));
    expect(base).not.toBe(threaded);
  });

  it('truncates a very long message into the summary but keeps the body', () => {
    const long = '报错'.repeat(400);
    const verdict = bridgeMessage(msg({ text: long }), ctx);
    if (verdict.kind !== 'event') throw new Error('expected event');
    expect((verdict.event.summary ?? '').length).toBeLessThanOrEqual(200);
    expect(verdict.event.body).toBe(long);
  });
});
