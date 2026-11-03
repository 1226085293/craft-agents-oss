import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { EventStore } from './event-store.ts';
import type { CraftEventEnvelope } from '@craft-agent/shared/events/types.ts';

function makeEvent(overrides: Partial<CraftEventEnvelope> = {}): CraftEventEnvelope {
  return {
    spec: 'craft-event/1',
    id: overrides.id ?? `evt_${Math.random().toString(36).slice(2)}`,
    source: 'qqmail',
    type: 'mail.received',
    receivedAt: 1_800_000_000_000,
    title: '张三 · 合同确认',
    summary: '请确认附件里的付款条款',
    tags: ['mail'],
    recipients: ['me@qq.com'],
    links: [],
    body: '请确认附件里的付款条款，谢谢。',
    delivered: false,
    ...overrides,
  };
}

let store: EventStore;

beforeEach(() => {
  store = new EventStore({ dbPath: ':memory:' });
});

afterEach(() => {
  store.close();
});

describe('EventStore.insert', () => {
  it('stores an event and reads it back with its body', () => {
    const event = makeEvent({ id: 'evt_a' });
    expect(store.insert(event)).toEqual({ id: 'evt_a', duplicate: false });

    const loaded = store.get('evt_a');
    expect(loaded?.title).toBe('张三 · 合同确认');
    expect(loaded?.body).toContain('付款条款');
    expect(loaded?.delivered).toBe(false);
    expect(loaded?.recipients).toEqual(['me@qq.com']);
  });

  it('treats a repeated dedupeKey from the same source as the same event', () => {
    const first = store.insert(makeEvent({ id: 'evt_1', dedupeKey: 'imap:8842' }));
    const second = store.insert(makeEvent({ id: 'evt_2', dedupeKey: 'imap:8842' }));

    expect(first).toEqual({ id: 'evt_1', duplicate: false });
    expect(second).toEqual({ id: 'evt_1', duplicate: true });
    expect(store.count()).toBe(1);
  });

  it('allows the same dedupeKey from a different source', () => {
    store.insert(makeEvent({ id: 'evt_1', source: 'qqmail', dedupeKey: 'x' }));
    store.insert(makeEvent({ id: 'evt_2', source: 'netease', dedupeKey: 'x' }));
    expect(store.count()).toBe(2);
  });
});

describe('EventStore.list', () => {
  it('omits bodies from the list projection', () => {
    store.insert(makeEvent({ id: 'evt_a' }));
    const [meta] = store.list();
    expect(meta).toBeDefined();
    expect(meta!).not.toHaveProperty('body');
    expect(meta!.title).toBe('张三 · 合同确认');
  });

  it('orders newest first and honours limit/offset', () => {
    store.insert(makeEvent({ id: 'old', receivedAt: 1000 }));
    store.insert(makeEvent({ id: 'new', receivedAt: 2000 }));
    store.insert(makeEvent({ id: 'mid', receivedAt: 1500 }));

    expect(store.list().map((e) => e.id)).toEqual(['new', 'mid', 'old']);
    expect(store.list({ limit: 2 }).map((e) => e.id)).toEqual(['new', 'mid']);
    expect(store.list({ limit: 2, offset: 2 }).map((e) => e.id)).toEqual(['old']);
  });

  it('filters by exact type and by namespace prefix', () => {
    store.insert(makeEvent({ id: 'a', type: 'mail.received' }));
    store.insert(makeEvent({ id: 'b', type: 'github.push' }));

    expect(store.list({ type: 'mail.received' }).map((e) => e.id)).toEqual(['a']);
    expect(store.list({ type: 'github.*' }).map((e) => e.id)).toEqual(['b']);
  });

  it('filters by source, tag and recipient presence', () => {
    store.insert(makeEvent({ id: 'a', source: 'qqmail', tags: ['mail'] }));
    store.insert(makeEvent({ id: 'b', source: 'github', tags: ['code'], recipients: [] }));

    expect(store.list({ source: 'qqmail' }).map((e) => e.id)).toEqual(['a']);
    expect(store.list({ tag: 'code' }).map((e) => e.id)).toEqual(['b']);
    expect(store.list({ hasRecipients: true }).map((e) => e.id)).toEqual(['a']);
  });

  it('matches 2-character Chinese queries through the bigram index', () => {
    store.insert(makeEvent({ id: 'cn', title: '请确认付款条款', summary: '', body: '' }));
    store.insert(makeEvent({ id: 'other', title: '无关内容', summary: '', body: '' }));

    for (const query of ['付款', '付款条', '确认付款']) {
      expect(store.list({ search: query }).map((e) => e.id)).toEqual(['cn']);
    }
  });

  it('searches latin text too', () => {
    store.insert(makeEvent({ id: 'en', title: 'Invoice #4412 from Acme' }));
    store.insert(makeEvent({ id: 'cn', title: '另一个事件' }));
    expect(store.list({ search: 'Acme' }).map((e) => e.id)).toEqual(['en']);
  });
});

describe('EventStore.markDelivered', () => {
  it('flips the delivered flag once and reports changed rows', () => {
    store.insert(makeEvent({ id: 'evt_a' }));
    expect(store.markDelivered(['evt_a'])).toBe(1);
    expect(store.markDelivered(['evt_a'])).toBe(0);
    expect(store.get('evt_a')?.delivered).toBe(true);
  });
});

describe('EventStore counts and retention', () => {
  it('counts per source for the listener cards', () => {
    store.insert(makeEvent({ id: 'a1', source: 'qqmail' }));
    store.insert(makeEvent({ id: 'a2', source: 'qqmail' }));
    store.insert(makeEvent({ id: 'b1', source: 'github' }));
    expect(store.countsBySource()).toEqual({ qqmail: 2, github: 1 });
  });

  it('prunes rows older than the age limit', () => {
    const now = 1_800_000_000_000;
    const day = 24 * 60 * 60 * 1000;
    store.insert(makeEvent({ id: 'stale', receivedAt: now - 100 * day }));
    store.insert(makeEvent({ id: 'fresh', receivedAt: now - day }));

    const removed = store.prune(now);
    expect(removed).toBe(1);
    expect(store.list().map((e) => e.id)).toEqual(['fresh']);
  });

  it('prunes down to the row cap, oldest first', () => {
    const capped = new EventStore({ dbPath: ':memory:', retentionRows: 2, retentionDays: 0 });
    try {
      for (const [i, id] of ['a', 'b', 'c', 'd'].entries()) {
        capped.insert(makeEvent({ id, receivedAt: 1000 + i }));
      }
      expect(capped.prune()).toBe(2);
      expect(capped.list().map((e) => e.id)).toEqual(['d', 'c']);
    } finally {
      capped.close();
    }
  });
});
