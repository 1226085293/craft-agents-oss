/**
 * Listener control client — talks to the optional loopback HTTP service a
 * listener may expose to report its own dependencies and install actions.
 *
 * Contract (`craft-deps/1`):
 *   GET  /deps               -> 200 { "deps": DepEntry[] }
 *   POST /deps/<id>/action   -> 202 {"running":true} | 409 while busy
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
