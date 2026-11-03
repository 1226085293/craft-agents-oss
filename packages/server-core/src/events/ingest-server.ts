/**
 * Event Center — local ingest endpoint.
 *
 * A listener POSTs `craft-event/1` payloads to
 * `http://127.0.0.1:<port>/events/<listenerId>`.
 *
 * `127.0.0.1` alone is NOT a security boundary: any page in any browser can
 * send a "simple" cross-origin POST (text/plain needs no preflight), any local
 * process can connect, and DNS rebinding turns a hostile origin same-origin.
 * Ingested events wake agent sessions that hold Bash and every configured
 * source, so an injection here is the entry of a code-execution chain.
 *
 * Three checks, all required:
 *   1. `Authorization: Bearer <token>` — regenerated on every start.
 *   2. `Host` must be a loopback literal — defeats DNS rebinding, which would
 *      otherwise arrive with `Host: evil.example`.
 *   3. `Content-Type: application/json` — forms cannot produce it, and the
 *      preflight it triggers fails against a server that sends no CORS headers.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { randomBytes } from 'node:crypto';
import { normalizeEventInput, type CraftEventEnvelope } from '@craft-agent/shared/events/types.ts';

/** Inline body cap. Larger payloads must use `payloadRef`. */
const MAX_BODY_BYTES = 256 * 1024;

/** Everything we need from the store; keeps this module testable. */
export interface EventSink {
  insert(event: CraftEventEnvelope): { id: string; duplicate: boolean };
}

export interface EventIngestOptions {
  sink: EventSink;
  /** Called after a successful insert so the host can push to renderers. */
  onInserted?: (event: CraftEventEnvelope) => void;
  /** Bearer token. Generated when omitted (production path). */
  token?: string;
  /** Bind address. Defaults to loopback. */
  host?: string;
  /** 0 asks the OS for a free port (default). */
  port?: number;
  /** Injectable for tests. */
  now?: () => number;
  /** Injectable for tests. */
  newId?: () => string;
}

export interface EventIngestAddress {
  host: string;
  port: number;
  token: string;
}

function defaultId(): string {
  // Time-ordered-ish and collision-safe enough for a local event log.
  const time = Date.now().toString(36);
  const rand = randomBytes(6).toString('hex');
  return `evt_${time}${rand}`;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  // Strip the port; keep IPv6 brackets.
  const host = hostHeader.startsWith('[')
    ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
    : hostHeader.split(':')[0];
  return LOOPBACK_HOSTS.has(host);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

export class EventIngestServer {
  private readonly options: EventIngestOptions;
  private readonly token: string;
  private server: Server | null = null;
  private address: EventIngestAddress | null = null;

  constructor(options: EventIngestOptions) {
    this.options = options;
    this.token = options.token ?? randomBytes(32).toString('hex');
  }

  /** Base URL, or null before `start()`. */
  get baseUrl(): string | null {
    return this.address ? `http://${this.address.host}:${this.address.port}` : null;
  }

  get currentAddress(): EventIngestAddress | null {
    return this.address;
  }

  async start(): Promise<EventIngestAddress> {
    if (this.address) return this.address;

    const host = this.options.host ?? '127.0.0.1';
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = server;

    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port ?? 0, host, () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('event ingest server: unexpected address'));
          return;
        }
        resolve(addr.port);
      });
    });

    this.address = { host, port, token: this.token };
    return this.address;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.address = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /**
   * Environment a supervised listener receives. Both forms are provided:
   * argv-style tools read the flag, everything else reads the env.
   */
  listenerEnv(listenerId: string): Record<string, string> {
    if (!this.address) throw new Error('event ingest server is not running');
    return {
      CRAFT_EVENTS_URL: `${this.baseUrl}/events/${listenerId}`,
      CRAFT_EVENTS_TOKEN: this.token,
      CRAFT_LISTENER_ID: listenerId,
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const match = /^\/events\/([A-Za-z0-9._-]{1,64})(\/health)?$/.exec(url.pathname);
      if (!match) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      const listenerId = match[1]!;
      const isHealth = Boolean(match[2]);

      // (2) Host: reject rebinding before anything else reads the body.
      if (!isLoopbackHostHeader(req.headers.host)) {
        sendJson(res, 403, { error: 'invalid_host' });
        return;
      }

      // (1) Bearer token.
      const auth = req.headers.authorization ?? '';
      const expected = `Bearer ${this.token}`;
      if (auth.length !== expected.length || !timingSafeEqualStr(auth, expected)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }

      if (isHealth) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method_not_allowed' });
          return;
        }
        sendJson(res, 200, { ok: true, listenerId });
        return;
      }

      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method_not_allowed' });
        return;
      }

      // (3) Content-Type: only JSON. Forms cannot produce it.
      const contentType = (req.headers['content-type'] ?? '').toLowerCase();
      if (!contentType.startsWith('application/json')) {
        sendJson(res, 415, { error: 'unsupported_media_type', expected: 'application/json' });
        return;
      }

      const body = await readBody(req, MAX_BODY_BYTES);
      if (body === 'too_large') {
        sendJson(res, 413, { error: 'payload_too_large', limitBytes: MAX_BODY_BYTES });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        sendJson(res, 400, { error: 'invalid_json', path: '$' });
        return;
      }

      const now = this.options.now?.() ?? Date.now();
      const id = this.options.newId?.() ?? defaultId();
      const normalized = normalizeEventInput(parsed, { id, source: listenerId, receivedAt: now });

      if (!normalized.ok) {
        const status = normalized.code === 'body_too_large' ? 413 : 400;
        sendJson(res, status, {
          error: normalized.code,
          path: normalized.path,
          message: normalized.message,
        });
        return;
      }

      let result: { id: string; duplicate: boolean };
      try {
        result = this.options.sink.insert(normalized.event);
      } catch (error) {
        // Write lock contention or a full disk: the listener should retry
        // rather than lose the event.
        sendJson(
          res,
          503,
          { error: 'store_unavailable', message: error instanceof Error ? error.message : String(error) },
          { 'retry-after': '2' },
        );
        return;
      }

      if (!result.duplicate) this.options.onInserted?.(normalized.event);
      sendJson(res, 200, result);
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal_error', message: error instanceof Error ? error.message : String(error) });
      } else {
        res.end();
      }
    }
  }
}

function timingSafeEqualStr(a: string, b: string): boolean {
  // Constant-time compare without pulling in a dependency; lengths already match.
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readBody(req: IncomingMessage, limit: number): Promise<string | 'too_large'> {
  // Stop BUFFERING past the limit but keep draining, so the client can finish
  // sending and actually receive the 413. Destroying the socket here makes the
  // caller see ECONNRESET instead of a status code. Draining is capped so a
  // client cannot stream forever.
  const drainCap = limit * 10;

  return await new Promise<string | 'too_large'>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    let done = false;

    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        if (size > drainCap) {
          done = true;
          resolve('too_large');
          req.destroy();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(tooLarge ? 'too_large' : Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (done) return;
      done = true;
      reject(error);
    });
  });
}
