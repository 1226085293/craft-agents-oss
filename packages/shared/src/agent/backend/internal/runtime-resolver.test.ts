import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveBackendRuntimePaths } from './runtime-resolver.ts';

describe('resolveBackendRuntimePaths packaged bun', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('returns the asarUnpack sibling instead of the in-archive Bun path', () => {
    root = mkdtempSync(join(tmpdir(), 'runtime-resolver-'));
    const appRoot = join(root, 'resources', 'app.asar');
    const bunName = process.platform === 'win32' ? 'bun.exe' : 'bun';
    const unpackedBun = join(
      root,
      'resources',
      'app.asar.unpacked',
      'vendor',
      'bun',
      bunName,
    );
    mkdirSync(dirname(unpackedBun), { recursive: true });
    writeFileSync(unpackedBun, '');

    const paths = resolveBackendRuntimePaths({
      appRootPath: appRoot,
      isPackaged: true,
    });

    expect(paths.bundledRuntimePath).toBe(unpackedBun);
    expect(paths.nodeRuntimePath).toBe(unpackedBun);
  });
});
