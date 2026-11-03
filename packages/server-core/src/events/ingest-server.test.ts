import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { request as httpRequest } from 'node:http';
import { EventIngestServer, type EventSink } from './ingest-server.ts';
import type { CraftEventEnvelope } from '@craft-agent/shared/events/types.ts';

const TOKEN = 'test-token-0123456789';

interface Captured {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function call(
  port: number,
  options: {
    path?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<Captured> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: options.path ?? '/events/qqmail',
        method: options.method ?? 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const validPayload = JSON.stringify({ type: 'mail.received', title: '张三 · 合同确认', summary: '请确认' });

let inserted: CraftEventEnvelope[] = [];
let insertImpl: (event: CraftEventEnvelope) => { id: string; duplicate: boolean };
let sink: EventSink;
let server: EventIngestServer;
let port: number;

beforeEach(async () => {
  inserted = [];
  insertImpl = (event) => {
    inserted.push(event);
    return { id: event.id, duplicate: false };
  };
  sink = { insert: (event) => insertImpl(event) };

  server = new EventIngestServer({
    sink,
    token: TOKEN,
    now: () => 1_800_000_000_000,
    newId: () => 'evt_fixed',
  });
  const address = await server.start();
  port = address.port;
});

afterEach(async () => {
  await server.stop();
});

describe('EventIngestServer auth', () => {
  it('accepts a loopback Host with the right bearer token', async () => {
    const res = await call(port, { body: validPayload });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ id: 'evt_fixed', duplicate: false });
  });

  it('rejects a missing or wrong token with 401', async () => {
    expect((await call(port, { body: validPayload, headers: { authorization: '' } })).status).toBe(401);
    expect((await call(port, { body: validPayload, headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    // Same length, different content — exercises the constant-time compare.
    expect(
      (await call(port, { body: validPayload, headers: { authorization: `Bearer ${'x'.repeat(TOKEN.length)}` } }))
        .status,
    ).toBe(401);
  });

  it('rejects a non-loopback Host with 403 (DNS rebinding)', async () => {
    const res = await call(port, { body: validPayload, headers: { host: 'evil.example' } });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toBe('invalid_host');
  });

  it('accepts localhost as a loopback host', async () => {
    const res = await call(port, { body: validPayload, headers: { host: `localhost:${port}` } });
    expect(res.status).toBe(200);
  });
});

describe('EventIngestServer content handling', () => {
  it('rejects non-JSON content types with 415', async () => {
    const res = await call(port, { body: validPayload, headers: { 'content-type': 'text/plain' } });
    expect(res.status).toBe(415);
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await call(port, { body: '{not json' });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_json');
  });

  it('reports the offending field when validation fails', async () => {
    const res = await call(port, { body: JSON.stringify({ type: 'Mail', title: 'x' }) });
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('invalid_payload');
    expect(body.path).toBe('type');
  });

  it('rejects an oversized body with 413', async () => {
    const big = JSON.stringify({ type: 'mail.received', title: 'x', body: 'y'.repeat(300 * 1024) });
    const res = await call(port, { body: big });
    expect(res.status).toBe(413);
  });

  it('404s unknown paths and 405s wrong methods', async () => {
    expect((await call(port, { path: '/nope', body: validPayload })).status).toBe(404);
    expect((await call(port, { path: '/events/qqmail', method: 'DELETE' })).status).toBe(405);
    expect((await call(port, { path: '/events/qqmail/health', method: 'POST' })).status).toBe(405);
  });
});

describe('EventIngestServer normalisation', () => {
  it('takes the source from the URL and the identity fields from the server', async () => {
    const res = await call(port, {
      body: JSON.stringify({
        type: 'mail.received',
        title: 'hi',
        id: 'forged',
        source: 'forged',
        receivedAt: 1,
      }),
    });
    expect(res.status).toBe(200);

    const event = inserted[0]!;
    expect(event.source).toBe('qqmail');
    expect(event.id).toBe('evt_fixed');
    expect(event.receivedAt).toBe(1_800_000_000_000);
  });

  it('returns duplicate:true when the sink reports a duplicate', async () => {
    insertImpl = (event) => ({ id: event.id, duplicate: true });
    const res = await call(port, { body: validPayload });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).duplicate).toBe(true);
  });

  it('answers the health probe', async () => {
    const res = await call(port, { path: '/events/qqmail/health', method: 'GET' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, listenerId: 'qqmail' });
  });
});

describe('EventIngestServer failure handling', () => {
  it('returns 503 with Retry-After when the store throws', async () => {
    insertImpl = () => {
      throw new Error('database is locked');
    };
    const res = await call(port, { body: validPayload });
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('2');
    expect(JSON.parse(res.body).error).toBe('store_unavailable');
  });

  it('exposes the listener env with URL and token', async () => {
    const env = server.listenerEnv('github-watch');
    expect(env.CRAFT_EVENTS_URL).toBe(`http://127.0.0.1:${port}/events/github-watch`);
    expect(env.CRAFT_EVENTS_TOKEN).toBe(TOKEN);
    expect(env.CRAFT_LISTENER_ID).toBe('github-watch');
  });
});
