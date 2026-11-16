import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadOutbox,
  saveOutbox,
  recordOutboxCall,
  outboxDue,
  nextBackoffMs,
  outboxPath,
  OUTBOX_MAX_ATTEMPTS,
  RETRYABLE_OUTBOX_ACTIONS,
  type OutboxRecord,
} from './outbox.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'craft-outbox-'));
  mkdirSync(join(root, 'config'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('recordOutboxCall', () => {
  it('records a successful send as sent and leaves it out of the due set', () => {
    const now = 1_000_000;
    const record = recordOutboxCall(root, {
      listenerId: 'telegram',
      action: 'send_message',
      args: { channelId: 'user:1', text: 'hi' },
      ok: true,
      now,
    });
    expect(record?.status).toBe('sent');
    expect(record?.nextAttemptAt).toBeUndefined();
    expect(outboxDue(loadOutbox(root), now + 10_000)).toHaveLength(0);
  });

  it('records a failed send as pending, due after the first backoff step', () => {
    const now = 1_000_000;
    const record = recordOutboxCall(root, {
      listenerId: 'telegram',
      action: 'send_message',
      args: { channelId: 'user:1', text: 'hi' },
      ok: false,
      error: 'control service returned 500',
      now,
    });
    expect(record?.status).toBe('pending');
    expect(record?.lastError).toBe('control service returned 500');
    // Not due yet…
    expect(outboxDue(loadOutbox(root), now + 999)).toHaveLength(0);
    // …but due once the first backoff step has elapsed.
    expect(outboxDue(loadOutbox(root), now + 1_000)).toHaveLength(1);
  });

  it('only records send-shaped actions; other control calls stay out', () => {
    const now = 1_000_000;
    expect(
      recordOutboxCall(root, { listenerId: 'wechat', action: 'auth_scan_qr', args: {}, ok: false, now }),
    ).toBeNull();
    expect(
      recordOutboxCall(root, { listenerId: 'wechat', action: 'probe', args: {}, ok: false, now }),
    ).toBeNull();
    const recorded = recordOutboxCall(root, {
      listenerId: 'whatsapp',
      action: 'deliver_file',
      args: { filePath: '/tmp/a.pdf' },
      ok: false,
      now,
    });
    expect(recorded?.action).toBe('deliver_file');
    expect([...RETRYABLE_OUTBOX_ACTIONS]).toEqual(['send_message', 'reply', 'deliver_file']);
  });
});

describe('outbox persistence', () => {
  it('round-trips through the config dir and tolerates a missing file', () => {
    expect(loadOutbox(root)).toEqual([]);
    const record: OutboxRecord = {
      id: 'outb_1',
      listenerId: 'telegram',
      action: 'send_message',
      args: { text: 'x' },
      status: 'pending',
      attempts: 0,
      createdAt: 1,
      updatedAt: 1,
      nextAttemptAt: 2,
    };
    saveOutbox(root, [record]);
    expect(existsSync(outboxPath(root))).toBe(true);
    expect(loadOutbox(root)).toEqual([record]);
  });

  it('reads a corrupt file as an empty outbox rather than throwing', () => {
    saveOutbox(root, []);
    const path = outboxPath(root);
    rmSync(path);
    writeFileSync(path, '{ not json', 'utf8');
    expect(loadOutbox(root)).toEqual([]);
  });
});

describe('backoff ladder', () => {
  it('clamps at the top step instead of indexing out of range', () => {
    expect(nextBackoffMs(0)).toBe(1_000);
    expect(nextBackoffMs(1)).toBe(10_000);
    expect(nextBackoffMs(OUTBOX_MAX_ATTEMPTS)).toBe(900_000);
    expect(nextBackoffMs(99)).toBe(900_000);
  });
});
