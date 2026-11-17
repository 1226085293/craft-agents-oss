/**
 * Listener control client — talks to the optional loopback HTTP service a
 * listener may expose to report its own dependencies and install actions.
 *
 * Contract (`craft-deps/1`):
 *   GET  /deps               -> 200 { "deps": DepEntry[] }
 *   POST /deps/<id>/action   -> 202 {"running":true} | 409 while busy
 *
 * Contract (`craft-plugin/1`) extends the same service with actions:
 *   POST /action             -> 200 {"ok":bool,"message":string}
 *   POST /channel_labels     -> 200 {"labels": Record<channelKey, label>}
 *                               (optional endpoint — a 404 or absence means
 *                               the plugin has no display names, and Craft
 *                               falls back to the raw channel key)
 *
 * Actions are why a plugin can ship its own program: the manifest says what may
 * be called, the plugin does the work, and the host keeps no knowledge of any
 * particular platform.
 *
 * Address + token come from `<dataDir>/control.json` (mode 600, written by
 * the listener). Craft only ever connects to hard-wired 127.0.0.1 — the port
 * from the file is never interpreted as a host. Every entry is shape-checked:
 * a malformed row is dropped, a malformed payload reads as "no data".
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ListenerReportedDepDto, ListenerReportedDepsDto } from '@craft-agent/shared/protocol/dto';

interface ControlInfo {
  port: number;
  token: string;
  pid?: number;
}

const DEP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_DEPS = 32;
const MAX_STRING = 200;
const MAX_VERSION = 64;
const MAX_LABEL = 80;

/** control.json changes rarely; cache by stat so /deps polls stay cheap. */
const cache = new Map<string, { mtimeMs: number; size: number; info: ControlInfo | null }>();

export function readControlInfo(dataDir: string): ControlInfo | null {
  const path = join(dataDir, 'control.json');
  let stat;
  try {
    stat = statSync(path);
  } catch {
    cache.delete(path);
    return null;
  }
  const cached = cache.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.info;

  let info: ControlInfo | null = null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const port = typeof raw.port === 'number' ? Math.trunc(raw.port) : Number.NaN;
    const token = typeof raw.token === 'string' ? raw.token : '';
    if (port >= 1 && port <= 65535 && token) {
      info = { port, token, ...(typeof raw.pid === 'number' ? { pid: raw.pid } : {}) };
    }
  } catch {
    info = null;
  }
  cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, info });
  return info;
}

/** Shape-check /deps entries; a malformed row is dropped, not fatal. */
function validateDeps(value: unknown): ListenerReportedDepDto[] | null {
  if (!Array.isArray(value)) return null;
  const deps: ListenerReportedDepDto[] = [];
  for (const entry of value.slice(0, MAX_DEPS)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, MAX_STRING) : '';
    if (!id || !DEP_ID_PATTERN.test(id) || !name) continue;

    const dep: ListenerReportedDepDto = { id, name, installed: raw.installed === true };
    if (typeof raw.version === 'string' && raw.version.trim()) {
      dep.version = raw.version.trim().slice(0, MAX_VERSION);
    }
    if (typeof raw.detail === 'string' && raw.detail.trim()) {
      dep.detail = raw.detail.trim().slice(0, MAX_STRING);
    }
    if (typeof raw.error === 'string' && raw.error.trim()) {
      dep.error = raw.error.trim().slice(0, MAX_STRING);
    }
    if (typeof raw.action === 'object' && raw.action !== null) {
      const action = raw.action as Record<string, unknown>;
      const label = typeof action.label === 'string' ? action.label.trim().slice(0, MAX_LABEL) : '';
      if (label) dep.action = { label, running: action.running === true };
    }
    deps.push(dep);
  }
  return deps;
}

/** Ask the listener for its dependency state. Never throws. */
export async function fetchReportedDeps(dataDir: string, timeoutMs = 3000): Promise<ListenerReportedDepsDto> {
  const info = readControlInfo(dataDir);
  if (!info) return { control: false, reason: 'no control service' };
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/deps`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { control: false, reason: `control service returned ${response.status}` };
    const body = (await response.json()) as { deps?: unknown };
    const deps = validateDeps(body?.deps);
    if (!deps) return { control: false, reason: 'invalid /deps payload' };
    return { control: true, deps };
  } catch (error) {
    return { control: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Trigger one reported dependency's action (the install button). */
export async function postDepAction(
  dataDir: string,
  depId: string,
  timeoutMs = 5000,
): Promise<{ ok: boolean; conflict?: boolean; error?: string }> {
  if (!DEP_ID_PATTERN.test(depId)) return { ok: false, error: 'invalid dep id' };
  const info = readControlInfo(dataDir);
  if (!info) return { ok: false, error: 'no control service' };
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/deps/${encodeURIComponent(depId)}/action`, {
      method: 'POST',
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 409) return { ok: false, conflict: true, error: 'action already running' };
    if (!response.ok) return { ok: false, error: `action returned ${response.status}` };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Ask the plugin for display names of channel keys (`POST /channel_labels`).
 *
 * This is the whole point of the endpoint: the host knows nothing about
 * platform vocabulary. It hands the plugin the channel keys it is rendering
 * and the plugin answers with whatever the platform calls them (a chat
 * title, a contact name, a handle). Missing keys are simply absent from the
 * result — the caller renders the raw key. Returns `null` when the plugin
 * offers no service at all (no control.json, process down, old build
 * without the endpoint) so callers have one branch for "no labels".
 */
export async function fetchChannelLabels(
  dataDir: string,
  channelKeys: string[],
  timeoutMs = 3000,
): Promise<Record<string, string> | null> {
  const info = readControlInfo(dataDir)
  if (!info) return null

  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/channel_labels`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${info.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ channelKeys }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    // 404 = an older plugin without the endpoint — a legitimate "no labels".
    if (response.status === 404 || !response.ok) return null

    const body = (await response.json()) as { labels?: unknown }
    if (!body || typeof body.labels !== 'object' || body.labels === null || Array.isArray(body.labels)) {
      return null
    }
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(body.labels)) {
      if (typeof key === 'string' && typeof value === 'string' && value.trim()) {
        out[key] = value.trim().slice(0, 120)
      }
    }
    return out
  } catch {
    return null // ECONNREFUSED / timeout: the plugin is not running
  }
}

/**
 * Run one manifest-declared action inside the plugin's own process.
 *
 * This is the whole point of a plugin shipping a program: the host posts
 * `{action, args}` to the loopback service the plugin already runs, and the
 * plugin decides how to do it. No host module knows what a channel id looks
 * like, which platform needs which token, or how to format a reply.
 *
 * `repliesToOrigin` actions arrive with their destination already filled in by
 * the caller — the plugin never has to guess who it is answering.
 */
export async function callPluginAction(
  dataDir: string,
  params: { action: string; args: Record<string, unknown> },
  timeoutMs = 10_000,
): Promise<{ ok: boolean; message: string }> {
  const info = readControlInfo(dataDir)
  if (!info) {
    return { ok: false, message: '插件没有提供控制服务（control.json），无法执行动作' }
  }

  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/action`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${info.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (!response.ok) {
      return { ok: false, message: `插件动作失败：control service returned ${response.status}` }
    }

    const body = (await response.json()) as { ok?: unknown; message?: unknown }
    const ok = body?.ok === true
    const message = typeof body?.message === 'string' ? body.message : ok ? '完成' : '插件没有说明原因'
    return { ok, message }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
