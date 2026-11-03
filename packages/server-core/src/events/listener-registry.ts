/**
 * Listener registry — what exists on disk and whether it can run.
 *
 * Layout:
 *   <workspace>/events/<id>/manifest.json      (code, git-friendly)
 *   <workspace>/events-data/<id>/              (logs, payloads, config)
 *   <workspace>/events-data/listeners.json     (enabled flags + user config)
 *
 * Dependency probing shells out (`python --version`, `pip show`), so results
 * are cached by executable + mtime: enabling five listeners must not spawn
 * fifteen processes on every repaint.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '@craft-agent/shared/utils';
import {
  parseManifest,
  satisfiesRange,
  type ListenerManifest,
  type ListenerPackageDep,
} from '@craft-agent/shared/events/manifest.ts';
import { runProbe } from './probe-runner.ts';

const log = createLogger('events');

export type DependencyState = 'ok' | 'missing' | 'mismatch' | 'unknown' | 'not_required';

export interface DependencyStatus {
  kind: 'runtime' | 'package' | 'system';
  /** Display label, e.g. `python` or `pip:requests`. */
  label: string;
  requirement: string;
  state: DependencyState;
  /** Detected version, when we could read one. */
  found?: string;
  /** Command that would install it, when we know one. */
  installHint?: string;
}

export interface LoadedListener {
  id: string
  manifest: ListenerManifest
  /** Absolute path to the listener code directory. */
  dir: string
  /** Absolute path to events-data/<id>. */
  dataDir: string
  enabled: boolean
  /** User-supplied config values (secrets included). */
  config: Record<string, unknown>
  dependencies: DependencyStatus[]
  /** True when every dependency is satisfied. */
  ready: boolean
  /** Manifest / IO problems that block loading. */
  errors: string[]
  warnings: string[]
}

interface PersistedListenerState {
  version: 1
  listeners: Record<string, { enabled?: boolean; config?: Record<string, unknown> }>
}

const PROBE_TTL_MS = 60_000;
const probeCache = new Map<string, { at: number; value: string | null }>();

/** Runtime command candidates, most specific first. */
const RUNTIME_COMMANDS: Record<string, string[]> = {
  python: ['python', 'python3', 'py'],
  node: ['node'],
  bun: ['bun'],
  deno: ['deno'],
  go: ['go'],
};

function statePath(workspaceRoot: string): string {
  return join(workspaceRoot, 'events-data', 'listeners.json');
}

function readState(workspaceRoot: string): PersistedListenerState {
  const path = statePath(workspaceRoot);
  if (!existsSync(path)) return { version: 1, listeners: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PersistedListenerState;
    if (!parsed || typeof parsed !== 'object' || !parsed.listeners) {
      return { version: 1, listeners: {} };
    }
    return parsed;
  } catch (error) {
    log.warn(`[events] listeners.json is unreadable, treating as empty: ${String(error)}`);
    return { version: 1, listeners: {} };
  }
}

function writeState(workspaceRoot: string, state: PersistedListenerState): void {
  const path = statePath(workspaceRoot);
  const { mkdirSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
  mkdirSync(join(workspaceRoot, 'events-data'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** Read a runtime's version, e.g. `3.11.4`. Cached per binary mtime. */
function probeVersion(command: string, args: string[]): string | null {
  const cacheKey = `${command} ${args.join(' ')}`;
  const cached = probeCache.get(cacheKey);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.value;

  const output = runProbe(command, args, 4000);
  let value: string | null = null;
  if (output !== null) {
    const match = /(\d+\.\d+(?:\.\d+)?)/.exec(output);
    if (match) value = match[1]!;
  }
  probeCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

function resolveRuntime(name: string): { command: string; version: string } | null {
  const candidates = RUNTIME_COMMANDS[name] ?? [name];
  for (const candidate of candidates) {
    const version = probeVersion(candidate, candidate === 'py' ? ['-3', '--version'] : ['--version']);
    if (version) return { command: candidate, version };
  }
  return null;
}

function probePackage(dep: ListenerPackageDep): { found?: string; installHint: string } {
  if (dep.manager === 'pip') {
    const output = runProbe('python', ['-m', 'pip', 'show', dep.name], 6000);
    const version = output ? /^Version:\s*(\S+)$/m.exec(output)?.[1] : undefined;
    return {
      ...(version ? { found: version } : {}),
      installHint: `python -m pip install "${dep.name}${dep.range !== '*' ? `${dep.range}` : ''}"`,
    };
  }
  const output = runProbe('npm', ['ls', '--json', '--depth=0', dep.name], 6000);
  const version = output ? /"version":\s*"([^"]+)"/.exec(output)?.[1] : undefined;
  return {
    ...(version ? { found: version } : {}),
    installHint: `npm install "${dep.name}@${dep.range}"`,
  };
}

function evaluateDependencies(manifest: ListenerManifest): DependencyStatus[] {
  const statuses: DependencyStatus[] = [];
  const deps = manifest.dependencies;

  for (const [runtimeName, range] of Object.entries(deps?.runtime ?? {})) {
    const resolved = resolveRuntime(runtimeName);
    if (!resolved) {
      statuses.push({
        kind: 'runtime',
        label: runtimeName,
        requirement: range,
        state: 'missing',
        installHint: undefined,
      });
      continue;
    }
    statuses.push({
      kind: 'runtime',
      label: runtimeName,
      requirement: range,
      state: satisfiesRange(resolved.version, range) ? 'ok' : 'mismatch',
      found: resolved.version,
    });
  }

  for (const dep of deps?.packages ?? []) {
    const { found, installHint } = probePackage(dep);
    if (!found) {
      statuses.push({
        kind: 'package',
        label: `${dep.manager}:${dep.name}`,
        requirement: dep.range,
        state: 'missing',
        installHint,
      });
      continue;
    }
    statuses.push({
      kind: 'package',
      label: `${dep.manager}:${dep.name}`,
      requirement: dep.range,
      state: satisfiesRange(found, dep.range) ? 'ok' : 'mismatch',
      found,
      installHint,
    });
  }

  for (const note of deps?.system ?? []) {
    statuses.push({
      kind: 'system',
      label: note,
      requirement: '—',
      state: 'not_required',
    });
  }

  return statuses;
}

export interface LoadListenersOptions {
  workspaceRoot: string
  /** Skip the subprocess probes (tests, fast UI pass). */
  skipProbes?: boolean
}

/** Scan `events/` and return every listener with its readiness. */
export function loadListeners(options: LoadListenersOptions): LoadedListener[] {
  const { workspaceRoot } = options;
  const eventsDir = join(workspaceRoot, 'events');
  if (!existsSync(eventsDir)) return [];

  const state = readState(workspaceRoot);
  const listeners: LoadedListener[] = [];

  for (const entry of readdirSync(eventsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const dir = join(eventsDir, id);
    const manifestPath = join(dir, 'manifest.json');

    if (!existsSync(manifestPath)) {
      listeners.push({
        id,
        manifest: {
          spec: 'craft-listener/1',
          id,
          name: id,
          version: '0.0.0',
          eventTypes: [],
        },
        dir,
        dataDir: join(workspaceRoot, 'events-data', id),
        enabled: false,
        config: {},
        dependencies: [],
        ready: false,
        errors: ['manifest.json is missing'],
        warnings: [],
      });
      continue;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      listeners.push({
        id,
        manifest: { spec: 'craft-listener/1', id, name: id, version: '0.0.0', eventTypes: [] },
        dir,
        dataDir: join(workspaceRoot, 'events-data', id),
        enabled: false,
        config: {},
        dependencies: [],
        ready: false,
        errors: [`manifest.json is not valid JSON: ${String(error)}`],
        warnings: [],
      });
      continue;
    }

    const parsed = parseManifest(raw, id);
    if (!parsed.ok || !parsed.manifest) {
      listeners.push({
        id,
        manifest: { spec: 'craft-listener/1', id, name: id, version: '0.0.0', eventTypes: [] },
        dir,
        dataDir: join(workspaceRoot, 'events-data', id),
        enabled: false,
        config: {},
        dependencies: [],
        ready: false,
        errors: parsed.errors,
        warnings: parsed.warnings,
      });
      continue;
    }

    const manifest = parsed.manifest;
    const persisted = state.listeners[id] ?? {};
    const dependencies = options.skipProbes ? [] : evaluateDependencies(manifest);
    const blocking = dependencies.filter((dep) => dep.state === 'missing' || dep.state === 'mismatch');

    listeners.push({
      id,
      manifest,
      dir,
      dataDir: join(workspaceRoot, 'events-data', id),
      enabled: persisted.enabled === true,
      config: persisted.config ?? {},
      dependencies,
      ready: Boolean(manifest.runtime) && blocking.length === 0,
      errors: [],
      warnings: parsed.warnings,
    });
  }

  listeners.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  return listeners;
}

export function setListenerEnabled(workspaceRoot: string, id: string, enabled: boolean): void {
  const state = readState(workspaceRoot);
  const current = state.listeners[id] ?? {};
  state.listeners[id] = { ...current, enabled };
  writeState(workspaceRoot, state);
}

export function setListenerConfig(
  workspaceRoot: string,
  id: string,
  config: Record<string, unknown>,
): void {
  const state = readState(workspaceRoot);
  const current = state.listeners[id] ?? {};
  state.listeners[id] = { ...current, config };
  writeState(workspaceRoot, state);
}

/** Missing required config keys, so the UI can gate the enable switch. */
export function missingConfigKeys(listener: LoadedListener): string[] {
  const required = listener.manifest.config?.required ?? [];
  return required.filter((key) => {
    const value = listener.config[key];
    return value === undefined || value === null || value === '';
  });
}

/** Test seam. */
export function clearProbeCache(): void {
  probeCache.clear();
}
