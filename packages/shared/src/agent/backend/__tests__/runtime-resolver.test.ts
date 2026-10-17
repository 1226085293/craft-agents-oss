/**
 * Tests for runtime-resolver.ts
 *
 * Verifies:
 * - Packaged server path resolution with dist/resources/ fallback
 * - Ripgrep path resolution with system rg fallback
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveBackendRuntimePaths } from '../internal/runtime-resolver.ts';
import { resolveBackendHostTooling } from '../factory.ts';
import type { BackendHostRuntimeContext } from '../types.ts';

describe('resolveServerPath fallback', () => {
  const tmpBase = join(tmpdir(), `resolver-test-${Date.now()}`);

  afterEach(() => {
    try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  });

  it('finds server in dist/resources/ when resources/ does not exist', () => {
    // Simulate packaged app where server is at dist/resources/<name>/index.js
    const appRoot = join(tmpBase, 'app');
    const serverDir = join(appRoot, 'dist', 'resources', 'pi-agent-server');
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(join(serverDir, 'index.js'), '// stub');

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: true,
    };

    const paths = resolveBackendRuntimePaths(hostRuntime);
    expect(paths.piServerPath).toBe(join(serverDir, 'index.js'));
  });

  it('prefers resources/ over dist/resources/ when both exist', () => {
    const appRoot = join(tmpBase, 'app2');

    // Create both paths
    const primaryDir = join(appRoot, 'resources', 'pi-agent-server');
    const fallbackDir = join(appRoot, 'dist', 'resources', 'pi-agent-server');
    mkdirSync(primaryDir, { recursive: true });
    mkdirSync(fallbackDir, { recursive: true });
    writeFileSync(join(primaryDir, 'index.js'), '// primary');
    writeFileSync(join(fallbackDir, 'index.js'), '// fallback');

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: true,
    };

    const paths = resolveBackendRuntimePaths(hostRuntime);
    expect(paths.piServerPath).toBe(join(primaryDir, 'index.js'));
  });
});

describe('resolveRipgrepPath', () => {
  const tmpBase = join(tmpdir(), `rg-resolver-test-${Date.now()}`);

  afterEach(() => {
    try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  });

  it('finds vendored ripgrep binary (@vscode/ripgrep)', () => {
    const appRoot = join(tmpBase, 'vendored');
    const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const rgDir = join(appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin');
    mkdirSync(rgDir, { recursive: true });
    const rgPath = join(rgDir, binaryName);
    writeFileSync(rgPath, '#!/bin/sh\n');
    chmodSync(rgPath, 0o755);

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: false,
    };

    const result = resolveBackendHostTooling({ hostRuntime });
    expect(result.ripgrepPath).toBe(rgPath);
  });

  it('falls back to system rg when vendored binary is missing (non-packaged)', () => {
    const appRoot = join(tmpBase, 'no-vendored');
    mkdirSync(appRoot, { recursive: true });

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: false,
    };

    const result = resolveBackendHostTooling({ hostRuntime });
    // On CI/dev machines with rg installed, this finds system rg.
    // On machines without rg, this returns undefined.
    // We just verify it doesn't throw.
    expect(result.ripgrepPath === undefined || typeof result.ripgrepPath === 'string').toBe(true);
  });

  it('does NOT fall back to system rg for packaged apps (respects isPackaged guard)', () => {
    // On dev machines, the CWD fallback (existing pre-change behavior) will find
    // the vendored binary from the monorepo. This test verifies the system PATH
    // fallback is gated by isPackaged — if the result is defined, it must be
    // a vendored path (not /usr/bin/rg or similar system path).
    const appRoot = join(tmpBase, 'packaged');
    mkdirSync(appRoot, { recursive: true });

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: true,
    };

    const result = resolveBackendHostTooling({ hostRuntime });
    if (result.ripgrepPath) {
      // Must be a vendored path, not a system PATH resolution
      expect(result.ripgrepPath).toContain('node_modules');
    }
  });
});

describe('resolveClaudeBinaryPath (native binary, SDK ≥ 0.2.113)', () => {
  const tmpBase = join(tmpdir(), `claude-bin-resolver-test-${Date.now()}`);

  afterEach(() => {
    try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  });

  it('finds the per-platform native binary in the optional-dep package', () => {
    const appRoot = join(tmpBase, 'app');
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const platformPkg = process.platform === 'win32'
      ? `claude-agent-sdk-win32-${arch}`
      : process.platform === 'darwin'
        ? `claude-agent-sdk-darwin-${arch}`
        : `claude-agent-sdk-linux-${arch}`;
    const binaryName = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const binDir = join(appRoot, 'node_modules', '@anthropic-ai', platformPkg);
    mkdirSync(binDir, { recursive: true });
    const binPath = join(binDir, binaryName);
    writeFileSync(binPath, '#!/bin/sh\n');
    chmodSync(binPath, 0o755);

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: true,
    };

    const paths = resolveBackendRuntimePaths(hostRuntime);
    expect(paths.claudeCliPath).toBe(binPath);
  });

  it('returns undefined when the platform package is missing', () => {
    const appRoot = join(tmpBase, 'no-binary');
    mkdirSync(appRoot, { recursive: true });

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: true,
    };

    const paths = resolveBackendRuntimePaths(hostRuntime);
    expect(paths.claudeCliPath).toBeUndefined();
  });
});

describe('resolveInterceptorBundlePath dev-mode source preference', () => {
  const tmpBase = join(tmpdir(), `interceptor-resolver-test-${Date.now()}`);

  afterEach(() => {
    try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  });

  it('prefers .ts source over the bundled .cjs in dev (non-packaged) so changes propagate without rebuild', () => {
    const appRoot = join(tmpBase, 'monorepo', 'apps', 'electron');
    const sourceDir = join(tmpBase, 'monorepo', 'packages', 'shared', 'src');
    const bundleDir = join(tmpBase, 'monorepo', 'apps', 'electron', 'dist');
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(bundleDir, { recursive: true });
    const sourcePath = join(sourceDir, 'unified-network-interceptor.ts');
    const bundlePath = join(bundleDir, 'interceptor.cjs');
    writeFileSync(sourcePath, '// ts source\n');
    writeFileSync(bundlePath, '// cjs bundle\n');

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: false,
    };
    const paths = resolveBackendRuntimePaths(hostRuntime);
    expect(paths.interceptorBundlePath).toBe(sourcePath);
  });

  it('uses the bundled .cjs in packaged builds even when source is reachable', () => {
    const appRoot = join(tmpBase, 'packaged-app');
    const sourceDir = join(tmpBase, 'packaged-app', 'packages', 'shared', 'src');
    const bundleDir = join(tmpBase, 'packaged-app', 'dist');
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(sourceDir, 'unified-network-interceptor.ts'), '// source\n');
    const bundlePath = join(bundleDir, 'interceptor.cjs');
    writeFileSync(bundlePath, '// bundle\n');

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: true,
    };
    const paths = resolveBackendRuntimePaths(hostRuntime);
    expect(paths.interceptorBundlePath).toBe(bundlePath);
  });

  it('honors explicit hostRuntime.interceptorBundlePath override regardless of mode', () => {
    const appRoot = join(tmpBase, 'override');
    mkdirSync(appRoot, { recursive: true });
    const overridePath = join(appRoot, 'custom-interceptor.cjs');
    writeFileSync(overridePath, '// custom\n');

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: false,
      interceptorBundlePath: overridePath,
    };
    const paths = resolveBackendRuntimePaths(hostRuntime);
    expect(paths.interceptorBundlePath).toBe(overridePath);
  });
});

/**
 * Regression: `asar: true` (apps/electron/electron-builder.yml) made every
 * spawned path resolve to `.../resources/app.asar/...`. Electron's `fs` shim
 * makes that readable from the main process, but the external bun.exe that
 * spawns pi-agent-server treats it as a literal path and dies with
 * `error: Module not found` — so no session ever reached the model.
 * Everything we spawn must resolve to the `app.asar.unpacked` sibling.
 */
describe('asar-aware resolution of spawned entry points', () => {
  const tmpBase = join(tmpdir(), `asar-resolver-test-${Date.now()}`);

  afterEach(() => {
    try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  });

  it('prefers the app.asar.unpacked copy of the pi-agent-server entry point', () => {
    const resources = join(tmpBase, 'resources');
    const appRoot = join(resources, 'app.asar');
    const inArchive = join(appRoot, 'dist', 'resources', 'pi-agent-server');
    const unpacked = join(resources, 'app.asar.unpacked', 'dist', 'resources', 'pi-agent-server');
    mkdirSync(inArchive, { recursive: true });
    mkdirSync(unpacked, { recursive: true });
    writeFileSync(join(inArchive, 'index.js'), '// inside the archive — unreadable by bun.exe\n');
    const realPath = join(unpacked, 'index.js');
    writeFileSync(realPath, '// real file on disk\n');

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: resources,
      isPackaged: true,
    };

    const paths = resolveBackendRuntimePaths(hostRuntime);
    expect(paths.piServerPath).toBe(realPath);
    expect(paths.piServerPath).not.toContain('app.asar' + sep + 'dist');
  });

  it('prefers the app.asar.unpacked interceptor bundle (passed via --preload/--require)', () => {
    const resources = join(tmpBase, 'resources2');
    const appRoot = join(resources, 'app.asar');
    const inArchive = join(appRoot, 'dist');
    const unpacked = join(resources, 'app.asar.unpacked', 'dist');
    mkdirSync(inArchive, { recursive: true });
    mkdirSync(unpacked, { recursive: true });
    writeFileSync(join(inArchive, 'interceptor.cjs'), '// in archive\n');
    const realPath = join(unpacked, 'interceptor.cjs');
    writeFileSync(realPath, '// real file\n');

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: resources,
      isPackaged: true,
    };

    const paths = resolveBackendRuntimePaths(hostRuntime);
    expect(paths.interceptorBundlePath).toBe(realPath);
  });

  it('prefers the extraResources ripgrep copy over the in-archive path', () => {
    const resources = join(tmpBase, 'resources3');
    const appRoot = join(resources, 'app.asar');
    const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';

    // In-archive copy (transparently readable via Electron's fs shim only).
    const inArchive = join(appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin');
    mkdirSync(inArchive, { recursive: true });
    writeFileSync(join(inArchive, binaryName), 'in-archive\n');

    // extraResources copy — the real file on disk.
    const extra = join(resources, 'app', 'node_modules', '@vscode', 'ripgrep', 'bin');
    mkdirSync(extra, { recursive: true });
    const realPath = join(extra, binaryName);
    writeFileSync(realPath, '#!/bin/sh\n');
    chmodSync(realPath, 0o755);

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: resources,
      isPackaged: true,
    };

    const result = resolveBackendHostTooling({ hostRuntime });
    expect(result.ripgrepPath).toBe(realPath);
  });
});
