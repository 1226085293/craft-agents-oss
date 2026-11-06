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

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '@craft-agent/shared/utils';
import {
  parseManifest,
  satisfiesRange,
  type ListenerManifest,
  type ListenerPackageDep,
} from '@craft-agent/shared/events/manifest.ts';
import { runProbe } from './probe-runner.ts';
import { isMcpInstalled } from './mcp-registry.ts';

const log = createLogger('events');

export type DependencyState = 'ok' | 'missing' | 'mismatch' | 'unknown' | 'not_required';

export interface DependencyStatus {
  kind: 'package' | 'mcp' | 'system';
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
  /**
   * Where the code came from: the workspace (installed by the user) or the
   * bundled catalog (shipped with Craft, listed but not yet adopted).
   *
   * Keeping them distinct is what makes a catalog possible without a download
   * step: the manifest is visible, but nothing runs and no data directory is
   * created until the user turns it on.
   */
  source: 'workspace' | 'catalog'
}

interface PersistedListenerState {
  version: 1
  listeners: Record<string, { enabled?: boolean; config?: Record<string, unknown> }>
}

const statePath = (workspaceRoot: string): string => join(workspaceRoot, 'events-data', 'listeners.json');

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

function evaluateDependencies(manifest: ListenerManifest, workspaceRoot: string): DependencyStatus[] {
  const statuses: DependencyStatus[] = [];
  const deps = manifest.dependencies;

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

  for (const dep of deps?.mcp ?? []) {
    if (dep.mode === 'remote') {
      // Remote servers are configured, not installed — nothing to probe.
      statuses.push({
        kind: 'mcp',
        label: `mcp:${dep.id}`,
        requirement: `remote · ${dep.url ?? ''}`,
        state: 'not_required',
      });
      continue;
    }
    const probe = isMcpInstalled(workspaceRoot, dep);
    statuses.push({
      kind: 'mcp',
      label: `mcp:${dep.id}`,
      requirement: dep.package
        ? `${dep.source}:${dep.package}${dep.version && dep.version !== '*' ? `@${dep.version}` : ''}`
        : (dep.source ?? 'managed'),
      state: probe.installed ? 'ok' : 'missing',
      ...(probe.version ? { found: probe.version } : {}),
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
  /**
   * Bundled plugin directories, highest priority first.
   *
   * Manifests here are listed as available; a same-id directory in the
   * workspace wins, so a user can pin or patch a bundled plugin locally.
   */
  catalogDirs?: string[]
}

/** Scan `events/` and the bundled catalog, workspace winning on a duplicate id. */
export function loadListeners(options: LoadListenersOptions): LoadedListener[] {
  const { workspaceRoot } = options;
  const state = readState(workspaceRoot);

  // Workspace first: a local copy of a bundled plugin shadows the catalog one,
  // so patch or pin a plugin by putting your own directory there.
  const roots: Array<{ root: string; source: LoadedListener['source'] }> = [
    { root: join(workspaceRoot, 'events'), source: 'workspace' },
    ...(options.catalogDirs ?? []).map((root) => ({ root, source: 'catalog' as const })),
  ];

  const listeners: LoadedListener[] = [];
  const seen = new Set<string>();

  for (const { root, source } of roots) {
    if (!existsSync(root)) continue;

    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      if (seen.has(id)) continue;
      seen.add(id);

      const dir = join(root, id);
      const manifestPath = join(dir, 'manifest.json');
      const dataDir = join(workspaceRoot, 'events-data', id);
      const blank = { spec: 'craft-listener/1' as const, id, name: id, version: '0.0.0' };

      if (!existsSync(manifestPath)) {
        listeners.push({
          id, manifest: blank, dir, dataDir, enabled: false, config: {},
          dependencies: [], ready: false, errors: ['manifest.json is missing'], warnings: [], source,
        });
        continue;
      }

      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
      } catch (error) {
        listeners.push({
          id, manifest: blank, dir, dataDir, enabled: false, config: {},
          dependencies: [], ready: false,
          errors: [`manifest.json is not valid JSON: ${String(error)}`], warnings: [], source,
        });
        continue;
      }

      const parsed = parseManifest(raw, id);
      if (!parsed.ok || !parsed.manifest) {
        listeners.push({
          id, manifest: blank, dir, dataDir, enabled: false, config: {},
          dependencies: [], ready: false, errors: parsed.errors, warnings: parsed.warnings, source,
        });
        continue;
      }

      const manifest = parsed.manifest;
      const persisted = state.listeners[id] ?? {};
      const dependencies =
        options.skipProbes || source === 'catalog'
          ? []
          : evaluateDependencies(manifest, workspaceRoot);
      const blocking = dependencies.filter(
        (dep) => dep.state === 'missing' || dep.state === 'mismatch',
      );

      listeners.push({
        id,
        manifest,
        dir,
        dataDir,
        enabled: persisted.enabled === true,
        config: persisted.config ?? {},
        dependencies,
        // A catalog plugin is available, not running: no user config yet, and
        // it must never be spawned behind the user's back.
        ready:
          source === 'workspace' &&
          // A plugin runs as a program, full stop. No in-process variant.
          Boolean(manifest.runtime) &&
          blocking.length === 0,
        errors: [],
        warnings: parsed.warnings,
        source,
      });
    }
  }

  return listeners;
}

export function setListenerEnabled(workspaceRoot: string, id: string, enabled: boolean): void {
  const state = readState(workspaceRoot);
  const current = state.listeners[id] ?? {};
  state.listeners[id] = { ...current, enabled };
  writeState(workspaceRoot, state);
}

/**
 * Copy a bundled plugin into the workspace so it can be started.
 *
 * The catalog is code only — it ships with Craft and is generally read-only.
 * Adopting one copies it into `<workspace>/events/<id>`, after which it is an
 * ordinary workspace plugin: the same directory a user could have written by
 * hand. Data stays under `events-data/<id>` and is never part of the copy, so
 * reinstalling cannot destroy credentials.
 *
 * @returns the directory the plugin now lives in.
 */
export function installListenerFromCatalog(
  workspaceRoot: string,
  id: string,
  catalogDirs: string[],
): string {
  const target = join(workspaceRoot, 'events', id);
  if (existsSync(target)) return target;

  const source = catalogDirs.map((dir) => join(dir, id)).find((dir) => existsSync(dir));
  if (!source) throw new Error(`plugin "${id}" is not in the catalog`);

  const { cpSync, mkdirSync } = require('node:fs') as typeof import('node:fs');
  mkdirSync(join(workspaceRoot, 'events'), { recursive: true });
  cpSync(source, target, { recursive: true });
  return target;
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

/**
 * Read a plugin's own translations.
 *
 * Each plugin ships `i18n/<locale>.json`; the host merges them under
 * `plugin.<id>.*` so a plugin can label its own fields without a host release.
 * Missing files are not an error — a plugin is allowed to be Chinese-only, and
 * its manifest strings are already the fallback.
 */
export function loadPluginLocales(
  plugin: LoadedListener,
  locale: string,
): Record<string, string> {
  const rel = plugin.manifest.locales;
  if (!rel) return {};

  const dir = join(plugin.dir, rel);
  const candidates = [join(dir, `${locale}.json`), join(dir, `${locale.split('-')[0]}.json`), join(dir, 'en.json')];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === 'string') out[`plugin.${plugin.id}.${key}`] = value;
      }
      return out;
    } catch (error) {
      log.warn(`[plugins] ${plugin.id} locale file is unreadable: ${String(error)}`);
    }
  }
  return {};
}

/** Every enabled plugin's strings for one locale. */
export function loadAllPluginLocales(
  options: LoadListenersOptions & { locale: string },
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const plugin of loadListeners(options)) {
    Object.assign(merged, loadPluginLocales(plugin, options.locale));
  }
  return merged;
}

/**
 * Whether a plugin may be used at all.
 *
 * Two conditions, both about the user's intent rather than the plugin's state:
 *
 *   installed — a copy exists in the workspace. A catalog entry is *available*,
 *               not installed: nothing has been adopted, so nothing may be
 *               called, spawned, or asked to parse a credential.
 *   enabled   — the user switched it on. Installed but off means "keep my
 *               config, do not act".
 *
 * A plugin that fails to start is still installed+enabled; "broken" is a runtime
 * state (shown amber), not a reason to pretend it does not exist.
 */
export function isPluginUsable(plugin: LoadedListener): boolean {
  return plugin.source === 'workspace' && plugin.enabled === true
}

/**
 * Why a plugin may or may not be started right now.
 *
 * Autostart is gated on this at every entry point: Craft must not spawn a
 * program whose credentials are blank or whose interpreter is missing, and it
 * must not record that as a failure — "not configured yet" is a normal state,
 * not a broken plugin. Only a genuine crash reaches `failed` and produces a
 * notification.
 */
export interface PluginReadiness {
  ready: boolean
  /** Machine-readable cause, so the UI can word it without a switch per case. */
  reason?: 'not-installed' | 'disabled' | 'missing-config' | 'missing-deps' | 'no-program'
  /** Human sentence for the detail panel and the toast description. */
  detail?: string
}

export function pluginReadiness(plugin: LoadedListener): PluginReadiness {
  if (plugin.source !== 'workspace') {
    return { ready: false, reason: 'not-installed', detail: '插件尚未安装到工作区' }
  }
  if (plugin.enabled !== true) {
    return { ready: false, reason: 'disabled', detail: '插件已停用' }
  }

  const missing = missingConfigKeys(plugin)
  if (missing.length > 0) {
    return {
      ready: false,
      reason: 'missing-config',
      detail: `还缺配置：${missing.join('、')}`,
    }
  }

  const blocking = plugin.dependencies.filter(
    (dep) => dep.state === 'missing' || dep.state === 'mismatch',
  )
  if (blocking.length > 0) {
    return {
      ready: false,
      reason: 'missing-deps',
      detail: `依赖未满足：${blocking.map((dep) => dep.label).join('、')}`,
    }
  }

  // Every plugin is a program; there is no in-process variant to exempt.
  if (!plugin.manifest.runtime) {
    return { ready: false, reason: 'no-program', detail: '插件没有声明 runtime，无法启动' }
  }

  return { ready: true }
}
