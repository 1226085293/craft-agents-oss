import { describe, it, expect, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { getEventService, resetEventServicesForTest } from './event-service.ts';
import type { EventRecord } from '@craft-agent/shared/events/event-store.ts';

const roots: string[] = [];

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'craft-events-service-'));
  mkdirSync(join(dir, 'config'), { recursive: true });
  roots.push(dir);
  return dir;
}

function postJson(url: string, token: string, payload: unknown): Promise<{ status: number; body: string }> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

afterEach(() => {
  resetEventServicesForTest();
  for (const dir of roots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows keeps the -wal handle briefly after close; leftovers are harmless.
    }
  }
});

describe('getEventService callback rebinding', () => {
  /**
   * Regression: the boot warm-up creates the service before any renderer exists
   * and passes no `onChanged`. Binding only in the constructor meant every later
   * RPC call kept that callback-less instance, so an ingested event reached the
   * database but never the events list — the row showed up only after a reload.
   */
  it('routes inserts to a callback registered after the boot warm-up', async () => {
    const root = makeRoot();

    // Boot: warm-up starts the service with no renderer callback.
    const booted = await getEventService('ws-rebind', root);

    // A renderer connects later and subscribes its broadcast.
    const seen: EventRecord[] = [];
    const withRenderer = await getEventService('ws-rebind', root, (event) => seen.push(event));
    expect(withRenderer).toBe(booted);
    expect(seen).toHaveLength(0);

    const env = withRenderer.listenerEnv('probe');
    const response = await postJson(env.CRAFT_EVENTS_URL!, env.CRAFT_EVENTS_TOKEN!, {
      type: 'mail.received',
      title: '晚绑定测试',
      summary: '订阅发生在服务启动之后',
    });

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.title).toBe('晚绑定测试');
    expect(seen[0]?.source).toBe('probe');
  });

  it('keeps the live callback when a later caller passes none', async () => {
    const root = makeRoot();
    const seen: EventRecord[] = [];

    const withRenderer = await getEventService('ws-null-call', root, (event) => seen.push(event));
    // Some callers (listener listing, status polling) have no broadcast to offer.
    await getEventService('ws-null-call', root, undefined);

    const env = withRenderer.listenerEnv('probe');
    const response = await postJson(env.CRAFT_EVENTS_URL!, env.CRAFT_EVENTS_TOKEN!, {
      type: 'mail.received',
      title: '空回调不覆盖',
    });

    expect(response.status).toBe(200);
    expect(seen.map((e) => e.title)).toEqual(['空回调不覆盖']);
  });
});
