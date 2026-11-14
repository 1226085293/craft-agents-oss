/**
 * Plugin sign-in relay.
 *
 * A plugin's sign-in flow (scan a QR, type a code shown on a phone) is platform
 * work, and platform work belongs to the plugin — Craft must not learn what a
 * WeChat bot token or a Baileys QR string looks like. So this module does not
 * implement any protocol. It:
 *
 *   1. asks the plugin's control service to start / report / submit / cancel,
 *   2. shape-checks the answer into a `PluginAuthStateDto`,
 *   3. hands the credentials over to the plugin's own config when the plugin
 *      says the sign-in finished.
 *
 * Step 3 is the part that used to be missing: the old CLI wrote the token into
 * `CredentialManager`, which nothing on the plugin side ever read, while the
 * plugin only ever reads `config.token` from `<dataDir>/config.json`. Writing
 * the credential where the plugin actually reads it is the whole point.
 *
 * Contract (`craft-auth/1`) on the plugin's loopback control service:
 *
 *   POST /auth/start           -> 200 PluginAuthStateDto
 *   GET  /auth/state           -> 200 PluginAuthStateDto
 *   POST /auth/submit  {code}  -> 200 PluginAuthStateDto
 *   POST /auth/cancel          -> 200 PluginAuthStateDto
 *
 * A 404 means "this plugin has no sign-in flow" — not an error.
 *
 * A `connected` snapshot may carry `credentials`: the plugin's own config
 * fragment (e.g. `{ token: "{...json...}" }`). Craft merges it into the saved
 * config and restarts the plugin, so the value reaches `<dataDir>/config.json`
 * the same way a typed-in field does. The credentials never travel to the
 * renderer: the snapshot is stripped of them before it is broadcast.
 */

import { readControlInfo } from './listener-control.ts';
import type {
  PluginAuthErrorCode,
  PluginAuthPhase,
  PluginAuthStateDto,
} from '@craft-agent/shared/protocol/dto';

const START_TIMEOUT_MS = 20_000;
const READ_TIMEOUT_MS = 5_000;

const PHASES: ReadonlyArray<PluginAuthPhase> = [
  'idle',
  'awaiting',
  'scanned',
  'need_code',
  'connected',
  'expired',
  'failed',
];

/** A snapshot plus the credentials the plugin wants saved, kept host-side. */
export interface PluginAuthResult {
  ok: boolean;
  state?: PluginAuthStateDto;
  code?: PluginAuthErrorCode;
  error?: string;
  /**
   * Config fragment to merge into the plugin's saved config. Present only on
   * `connected`; deliberately absent from `state` so it cannot leak to a view.
   */
  credentials?: Record<string, unknown>;
}

function fail(code: PluginAuthErrorCode, error: string): PluginAuthResult {
  return { ok: false, code, error };
}

/**
 * Read one snapshot out of whatever the plugin sent.
 *
 * The plugin is third-party code as far as the host is concerned, so every
 * field is checked: an unknown phase is a failed attempt, not a crash, and
 * over-long strings are truncated rather than trusted.
 */
function parseState(listenerId: string, value: unknown): { state?: PluginAuthStateDto; credentials?: Record<string, unknown> } {
  if (typeof value !== 'object' || value === null) return {};
  const raw = value as Record<string, unknown>;

  const phase = typeof raw.phase === 'string' ? (raw.phase as PluginAuthPhase) : undefined;
  if (!phase || !PHASES.includes(phase)) return {};

  const str = (v: unknown, max: number): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;

  const state: PluginAuthStateDto = { listenerId, phase };
  const qr = str(raw.qr, 4096);
  if (qr) state.qr = qr;
  const code = str(raw.code, 64);
  if (code) state.code = code;
  if (typeof raw.expiresAt === 'number' && Number.isFinite(raw.expiresAt)) {
    state.expiresAt = Math.trunc(raw.expiresAt);
  }
  const detail = str(raw.detail, 300);
  if (detail) state.detail = detail;
  const error = str(raw.error, 500);
  if (error) state.error = error;
  if (typeof raw.attempt === 'number' && Number.isFinite(raw.attempt)) {
    state.attempt = Math.trunc(raw.attempt);
  }

  let credentials: Record<string, unknown> | undefined;
  if (typeof raw.credentials === 'object' && raw.credentials !== null && !Array.isArray(raw.credentials)) {
    credentials = { ...(raw.credentials as Record<string, unknown>) };
  }

  return { state, credentials };
}

async function callControl(
  dataDir: string,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown; timeoutMs: number },
): Promise<{ status: number; body: unknown } | { error: PluginAuthErrorCode; message: string }> {
  const info = readControlInfo(dataDir);
  if (!info) return { error: 'not-running', message: '插件没有在运行，也没有提供控制服务' };

  try {
    const response = await fetch(`http://127.0.0.1:${info.port}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${info.token}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(init.timeoutMs),
    });

    if (response.status === 404) return { status: 404, body: null };
    if (!response.ok) {
      return { error: 'rejected', message: `插件拒绝了这次调用（HTTP ${response.status}）` };
    }
    return { status: response.status, body: await response.json().catch(() => null) };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { error: 'timeout', message: '插件没有在时限内回应' };
    }
    return { error: 'not-running', message: error instanceof Error ? error.message : String(error) };
  }
}

/** Shared body of the four relay calls: send, then shape-check. */
async function relay(
  listenerId: string,
  dataDir: string,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown; timeoutMs: number },
): Promise<PluginAuthResult> {
  const response = await callControl(dataDir, path, init);
  if ('error' in response) return fail(response.error, response.message);
  // 404 = the plugin implements no sign-in flow at all.
  if (response.status === 404) {
    return fail('unsupported', '这个插件没有提供扫码授权流程');
  }

  const parsed = parseState(listenerId, response.body);
  if (!parsed.state) return fail('bad-payload', '插件的授权服务返回了无法识别的状态');
  return {
    ok: true,
    state: parsed.state,
    ...(parsed.credentials ? { credentials: parsed.credentials } : {}),
  };
}

export function startPluginAuth(listenerId: string, dataDir: string): Promise<PluginAuthResult> {
  return relay(listenerId, dataDir, '/auth/start', { method: 'POST', timeoutMs: START_TIMEOUT_MS });
}

export function readPluginAuth(listenerId: string, dataDir: string): Promise<PluginAuthResult> {
  return relay(listenerId, dataDir, '/auth/state', { method: 'GET', timeoutMs: READ_TIMEOUT_MS });
}

export function submitPluginAuthCode(
  listenerId: string,
  dataDir: string,
  code: string,
): Promise<PluginAuthResult> {
  const trimmed = code.trim().slice(0, 64);
  if (!trimmed) return Promise.resolve(fail('rejected', '验证码不能为空'));
  return relay(listenerId, dataDir, '/auth/submit', {
    method: 'POST',
    body: { code: trimmed },
    timeoutMs: START_TIMEOUT_MS,
  });
}

export function cancelPluginAuth(listenerId: string, dataDir: string): Promise<PluginAuthResult> {
  return relay(listenerId, dataDir, '/auth/cancel', { method: 'POST', timeoutMs: READ_TIMEOUT_MS });
}
