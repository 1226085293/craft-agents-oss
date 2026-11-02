import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import type { BackendHostRuntimeContext } from '../types.ts';

/**
 * When set, the resolver walks further up from the .app bundle to find SDK,
 * interceptor, and bun in the monorepo / on the system PATH.
 * Intended for local `electron:dist:mac` builds that skip `build-dmg.sh`.
 */
const IS_DEV_RUNTIME = !!process.env.CRAFT_DEV_RUNTIME;

export interface ResolvedBackendRuntimePaths {
  /**
   * Source/bundle path for the network interceptor preloaded into the **Pi**
   * subprocess.
   */
  interceptorBundlePath?: string;
  sessionServerPath?: string;
  bridgeServerPath?: string;
  piServerPath?: string;
  nodeRuntimePath?: string;
  bundledRuntimePath?: string;
}

export interface ResolvedBackendHostTooling {
  ripgrepPath?: string;
}

function firstExistingPath(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const APP_ASAR = 'app.asar';
const APP_ASAR_UNPACKED = 'app.asar.unpacked';

/**
 * Map a path that lives inside the ASAR archive onto its `asarUnpack` sibling.
 *
 * Why this is required: Electron patches the main process's `fs` module, so
 * `existsSync('.../resources/app.asar/dist/x.js')` happily returns true. That
 * patch does NOT extend to *external* processes. Every path we hand to
 * bun.exe / node.exe / rg.exe is a literal filesystem path, and
 * `app.asar/...` does not exist on disk — bun exits with
 * `error: Module not found "…/app.asar/dist/resources/pi-agent-server/index.js"`
 * and each session dies before any upstream request is made.
 *
 * electron-builder's `asarUnpack` (apps/electron/electron-builder.yml) extracts
 * everything we spawn into `app.asar.unpacked/`, so rewrite the path there.
 * No-op for non-packaged builds and for paths already outside the archive.
 */
function toUnpackedPath(p: string | undefined): string | undefined {
  if (!p) return undefined;
  const inArchive = `${sep}${APP_ASAR}${sep}`;
  const unpacked = `${sep}${APP_ASAR_UNPACKED}${sep}`;
  const idx = p.indexOf(inArchive);
  if (idx !== -1) {
    return `${p.slice(0, idx)}${unpacked}${p.slice(idx + inArchive.length)}`;
  }
  if (p.endsWith(`${sep}${APP_ASAR}`)) {
    return `${p.slice(0, -(APP_ASAR.length))}${APP_ASAR_UNPACKED}`;
  }
  return p;
}

/**
 * `.../resources/app.asar` → `.../resources/app.asar.unpacked`, otherwise the
 * input unchanged. Used to look for the real on-disk copy *before* falling back
 * to the in-archive path that `fs` resolves transparently.
 */
function toUnpackedRoot(p: string): string {
  return p.endsWith(`${sep}${APP_ASAR}`)
    ? `${p.slice(0, -(APP_ASAR.length))}${APP_ASAR_UNPACKED}`
    : p;
}

/**
 * Walk up from `base` checking `join(ancestor, relativePath)` at each level.
 * Stops after `maxLevels` ancestors or when hitting the filesystem root.
 */
function resolveUpwards(base: string, relativePath: string, maxLevels = 4): string | undefined {
  let dir = resolve(base);
  for (let i = 0; i <= maxLevels; i++) {
    const candidate = join(dir, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return undefined;
}

function resolveBundledRuntimePath(hostRuntime: BackendHostRuntimeContext): string | undefined {
  const bunBinary = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const bunBasePath = process.platform === 'win32'
    ? (hostRuntime.resourcesPath || hostRuntime.appRootPath)
    : hostRuntime.appRootPath;
  const bunPath = join(bunBasePath, 'vendor', 'bun', bunBinary);
  // A packaged app may expose the vendored Bun path through app.asar. Bun is
  // spawned as an external process, so an in-archive path is not executable.
  // Prefer the asarUnpack sibling and fail clearly if it was not unpacked.
  const unpackedBunPath = toUnpackedPath(bunPath);
  if (unpackedBunPath !== bunPath) {
    return unpackedBunPath && existsSync(unpackedBunPath) ? unpackedBunPath : undefined;
  }
  if (existsSync(bunPath)) return bunPath;

  // Non-packaged (headless server, dev mode): fall back to system bun via PATH.
  // Packaged apps must ship their own bundled bun — never resolve from PATH
  // to avoid picking up an incompatible system install.
  if (!hostRuntime.isPackaged) {
    try {
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      const systemBun = execFileSync(whichCmd, ['bun'], { encoding: 'utf-8' }).trim();
      if (systemBun && existsSync(systemBun)) return systemBun;
    } catch { /* system bun not found */ }
  }
  return undefined;
}

function resolveInterceptorBundlePath(hostRuntime: BackendHostRuntimeContext): string | undefined {
  if (hostRuntime.interceptorBundlePath && existsSync(hostRuntime.interceptorBundlePath)) {
    return hostRuntime.interceptorBundlePath;
  }

  // In dev / monorepo runs, prefer the TypeScript source so changes are
  // picked up without a manual `bun run build:interceptor`. The interceptor
  // is loaded via `--preload` in Bun or `--require` in Node.js (see
  // pi-agent.ts). Packaged builds always go through the pre-built
  // `dist/interceptor.cjs` bundle.
  if (!hostRuntime.isPackaged) {
    const source = resolveUpwards(
      hostRuntime.appRootPath,
      join('packages', 'shared', 'src', 'unified-network-interceptor.ts'),
      10,
    );
    if (source) return source;
  }

  // Packaged: the interceptor is passed to the spawned bun/node process as
  // `--preload` / `--require`, so it must be a real file — prefer the
  // asarUnpack sibling over the in-archive path.
  const unpackedRoot = toUnpackedRoot(hostRuntime.appRootPath);
  const bundled = resolveUpwards(unpackedRoot, join('dist', 'interceptor.cjs'))
    ?? resolveUpwards(unpackedRoot, join('apps', 'electron', 'dist', 'interceptor.cjs'));
  if (bundled) return bundled;

  return resolveUpwards(hostRuntime.appRootPath, join('dist', 'interceptor.cjs'))
    ?? resolveUpwards(hostRuntime.appRootPath, join('apps', 'electron', 'dist', 'interceptor.cjs'));
}

function resolveServerPath(hostRuntime: BackendHostRuntimeContext, serverName: string): string | undefined {
  if (hostRuntime.isPackaged) {
    // These entry points are spawned by an external bun/node process, which
    // cannot read inside app.asar — always take the asarUnpack copy first.
    const unpackedRoot = toUnpackedRoot(hostRuntime.appRootPath);
    return firstExistingPath([
      join(unpackedRoot, 'resources', serverName, 'index.js'),
      join(unpackedRoot, 'dist', 'resources', serverName, 'index.js'),
      join(hostRuntime.appRootPath, 'resources', serverName, 'index.js'),
      join(hostRuntime.appRootPath, 'dist', 'resources', serverName, 'index.js'),
    ]);
  }
  return resolveUpwards(
    hostRuntime.appRootPath,
    join('packages', serverName, 'dist', 'index.js'),
  );
}

/**
 * Locate ripgrep. Sourced from `@vscode/ripgrep`; the search service in
 * `packages/server-core/src/services/search.ts` calls it directly.
 */
function resolveRipgrepPath(hostRuntime: BackendHostRuntimeContext): string | undefined {
  const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const ripgrepRelative = join('node_modules', '@vscode', 'ripgrep', 'bin', binaryName);

  if (hostRuntime.isPackaged) {
    // rg is spawned as a subprocess → the real on-disk copy is required.
    // `extraResources` places one at <resources>/app/node_modules/@vscode/ripgrep.
    if (hostRuntime.resourcesPath) {
      const fromExtraResources = join(hostRuntime.resourcesPath, 'app', ripgrepRelative);
      if (existsSync(fromExtraResources)) return fromExtraResources;
    }
    const unpackedRoot = toUnpackedRoot(hostRuntime.appRootPath);
    const packaged = join(unpackedRoot, ripgrepRelative);
    if (existsSync(packaged)) return packaged;
  }

  const fromHostRoot = resolveUpwards(hostRuntime.appRootPath, ripgrepRelative, 10);
  if (fromHostRoot) return toUnpackedPath(fromHostRoot);

  const cwdFallback = join(process.cwd(), ripgrepRelative);
  if (existsSync(cwdFallback)) return cwdFallback;

  // Non-packaged (headless server, dev mode): fall back to system rg via PATH.
  // Packaged apps must use vendored binary only — never resolve from PATH
  // to avoid picking up an incompatible system install.
  if (!hostRuntime.isPackaged) {
    try {
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      const systemRg = execFileSync(whichCmd, ['rg'], { encoding: 'utf-8' }).trim();
      if (systemRg && existsSync(systemRg)) return systemRg;
    } catch { /* system rg not found */ }
  }

  return undefined;
}

export function resolveBackendRuntimePaths(hostRuntime: BackendHostRuntimeContext): ResolvedBackendRuntimePaths {
  const bundledRuntimePath = hostRuntime.nodeRuntimePath || resolveBundledRuntimePath(hostRuntime);

  return {
    interceptorBundlePath: resolveInterceptorBundlePath(hostRuntime),
    sessionServerPath: resolveServerPath(hostRuntime, 'session-mcp-server'),
    bridgeServerPath: resolveServerPath(hostRuntime, 'bridge-mcp-server'),
    piServerPath: resolveServerPath(hostRuntime, 'pi-agent-server'),
    // NOT `|| process.execPath`. That fallback looked harmless and was the
    // opposite: in a packaged app it spawns a *second* Electron instance as the
    // interpreter, which exits 0 immediately. The session then sits in
    // "processing" with no LLM request ever made and nothing in the gateway
    // log — 2026-10-25, after an install that silently dropped
    // resources/vendor/bun. Leaving it undefined lets the spawn site fail with
    // a message that names the missing file.
    nodeRuntimePath: hostRuntime.nodeRuntimePath || bundledRuntimePath,
    bundledRuntimePath,
  };
}

export function resolveBackendHostTooling(hostRuntime: BackendHostRuntimeContext): ResolvedBackendHostTooling {
  return {
    ripgrepPath: resolveRipgrepPath(hostRuntime),
  };
}
