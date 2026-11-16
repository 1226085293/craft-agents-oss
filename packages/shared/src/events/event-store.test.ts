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
    recipients: ['me@qq.com'],
    links: [],
    attachments: [],
    body: '请确认附件里的付款条款，谢谢。',
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
    expect(loaded?.handledAt).toBeUndefined();
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

  it('filters by source and recipient presence', () => {
    store.insert(makeEvent({ id: 'a', source: 'qqmail' }));
    store.insert(makeEvent({ id: 'b', source: 'github', recipients: [] }));

    expect(store.list({ source: 'qqmail' }).map((e) => e.id)).toEqual(['a']);
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

describe('EventStore.markHandled', () => {
  /**
   * 「Handled」 is not 「delivered」.
   *
   * The boolean this replaced was set the moment a session was handed the event, so a fresh
   * inbox item and a finished one looked the same. The timestamp only exists once the run that
   * received the event has ended.
   */
  it('stamps handledAt on the delivery and on the event, once', () => {
    store.insert(makeEvent({ id: 'evt_a' }));
    store.recordDelivery('evt_a', 'sess_a', 1000)
    expect(store.get('evt_a')?.handledAt).toBeUndefined();

    store.markHandled('evt_a', 'sess_a', 2000);
    expect(store.get('evt_a')?.handledAt).toBe(2000);
    expect(store.get('evt_a')?.deliveries[0]?.handledAt).toBe(2000);

    // A second run does not move the timestamp backwards or forwards.
    store.markHandled('evt_a', 'sess_a', 3000);
    expect(store.get('evt_a')?.handledAt).toBe(2000);
  });

  it('filters handled from pending', () => {
    store.insert(makeEvent({ id: 'done' }));
    store.insert(makeEvent({ id: 'waiting' }));
    store.recordDelivery('done', 'sess_a', 1000);
    store.recordDelivery('waiting', 'sess_a', 1000);
    store.markHandled('done', 'sess_a', 2000);

    expect(store.list({ handled: true }).map((e) => e.id)).toEqual(['done']);
    expect(store.list({ handled: false }).map((e) => e.id)).toEqual(['waiting']);
  });
});

describe('EventStore.recordDelivery', () => {
  it('records per-session deliveries without claiming they were handled', () => {
    store.insert(makeEvent({ id: 'evt_d1' }));
    store.recordDelivery('evt_d1', 'sess_a', 1_800_000_100_000);
    store.recordDelivery('evt_d1', 'sess_b', 1_800_000_200_000);

    const meta = store.list({})[0]!;
    // Arrival is not completion: nothing has run yet.
    expect(meta.handledAt).toBeUndefined();
    expect(meta.deliveries).toHaveLength(2);
    expect(meta.deliveries.map((d) => d.sessionId).sort()).toEqual(['sess_a', 'sess_b']);
    expect(meta.deliveries[0]!.at).toBeTypeOf('number');
  });

  it('replaces an older entry for the same session (latest wins)', () => {
    store.insert(makeEvent({ id: 'evt_d2' }));
    store.recordDelivery('evt_d2', 'sess_a', 1);
    store.recordDelivery('evt_d2', 'sess_a', 2);

    const meta = store.list({})[0]!;
    expect(meta.deliveries).toEqual([{ sessionId: 'sess_a', at: 2 }]);
  });

  it('is a no-op for an unknown event id', () => {
    expect(() => store.recordDelivery('evt_nope', 'sess_x', 1)).not.toThrow();
  });
});

describe('EventStore legacy migration', () => {
  it('adds the deliveries column to a database created before it existed', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { openSqlite } = await import('./sqlite.ts');

    const dir = mkdtempSync(join(tmpdir(), 'craft-store-mig-'));
    const dbPath = join(dir, 'events.sqlite');
    // Create the pre-deliveries schema exactly as it shipped.
    const legacy = openSqlite(dbPath);
    legacy.exec(`
      CREATE TABLE events (
        id           TEXT PRIMARY KEY,
        source       TEXT NOT NULL,
        type         TEXT NOT NULL,
        received_at  INTEGER NOT NULL,
        occurred_at  INTEGER,
        title        TEXT NOT NULL,
        summary      TEXT,
        recipients   TEXT,
        links        TEXT,
        body         TEXT,
        search_text  TEXT,
        payload_kind TEXT,
        payload_path TEXT,
        payload_size INTEGER,
        dedupe_key   TEXT,
        delivered    INTEGER NOT NULL DEFAULT 0
      );
      CREATE VIRTUAL TABLE events_fts USING fts5(event_id UNINDEXED, search_text, tokenize='unicode61');
    `);
    legacy.exec(
      // delivered = 1: this row was handed to a session under the old build, so the upgrade
      // must not relabel it as work nobody did.
      "INSERT INTO events (id, source, type, received_at, title, recipients, delivered) VALUES ('old_1', 'qqmail', 'mail.received', 123, '旧事件', '[]', 1)",
    );
    legacy.close();

    const migrated = new EventStore({ dbPath });
    try {
      migrated.insert(makeEvent({ id: 'new_1' }));
      migrated.recordDelivery('new_1', 'sess_a', 5);
      migrated.recordDelivery('old_1', 'sess_b', 6);
      expect(migrated.get('new_1')?.deliveries).toEqual([{ sessionId: 'sess_a', at: 5 }]);
      expect(migrated.get('old_1')?.deliveries).toEqual([{ sessionId: 'sess_b', at: 6 }]);
      // Backfilled from the old flag: those rows had been through a delivery attempt,
      // so labelling the whole history 「unhandled」 after an upgrade would be a lie.
      expect(migrated.get('old_1')?.handledAt).toBeTypeOf('number');
    } finally {
      migrated.close();
      // WAL sidecar files can linger briefly on Windows; cleanup is not the
      // assertion under test.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
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

describe('EventStore.recordRouting', () => {
  it('appends each routing decision so the trail stays complete', () => {
    const store = new EventStore({ dbPath: ':memory:' });
    store.insert({
      spec: 'craft-event/1',
      id: 'evt_r1',
      source: 'qqmail',
      type: 'mail.received',
      receivedAt: 1_800_000_000_000,
      title: '合同确认',
      recipients: [],
      links: [],
      attachments: [],
    });

    store.recordRouting('evt_r1', {
      via: 'supervisor',
      outcome: '无订阅者，转规则/督导',
      at: 1,
    });
    store.recordRouting('evt_r1', {
      via: 'task',
      target: 'T-2',
      outcome: '按事件触发器起任务',
      at: 2,
    });

    const record = store.get('evt_r1')!;
    expect(record.routing.map((entry) => entry.via)).toEqual(['supervisor', 'task']);
    expect(record.routing[1]?.target).toBe('T-2');
    store.close();
  });

  it('ignores an unknown event id instead of throwing', () => {
    const store = new EventStore({ dbPath: ':memory:' });
    expect(() =>
      store.recordRouting('missing', { via: 'dropped', outcome: 'x', at: 1 }),
    ).not.toThrow();
    store.close();
  });
});
