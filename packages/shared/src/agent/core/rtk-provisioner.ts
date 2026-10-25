/**
 * RTK binary provisioner.
 *
 * The app ships rtk as a compressed archive per platform under
 * `resources/bin/rtk-archives/` (about 31 MB total, versus 73 MB for the
 * extracted binaries). On startup the archive for the current platform is
 * verified against the SHA256SUMS.txt that ships beside it and unpacked into
 * the config dir, which is writable — an installed app's `resources/` is
 * often read-only, so unpacking next to the archive would fail.
 *
 * Unpacking is idempotent: a binary whose recorded checksum already matches
 * is left alone, so restarting the app costs a stat call rather than a full
 * re-extract. `CRAFT_RTK` is set by the caller once provisioning succeeds, and
 * the detector prefers it over PATH.
 *
 * Every failure mode here is non-fatal by design. A corrupt archive or a
 * read-only config dir must degrade to "rtk not installed" — the caller's
 * Bash commands keep working unrewritten — never to a crash on boot.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

export interface ProvisionResult {
  /** Absolute path to the provisioned rtk binary, or null if unavailable. */
  path: string | null;
  /** Why provisioning did not produce a path. Diagnostics only. */
  reason?: 'no-archive' | 'checksum-mismatch' | 'extract-failed' | 'already-present';
}

/**
 * Unpacks `archive` into `destDir`. Injectable so tests can supply a trivial
 * copy instead of shelling out to tar/Expand-Archive — Windows' bundled tar
 * parses a `-C C:\...` argument as a remote host, which makes a real tar
 * unusable in a Windows test run even though the production path never calls
 * it there.
 */
export type ArchiveExtractor = (archivePath: string, destDir: string) => void;

/**
 * Confirms an extracted binary is runnable. Injectable so tests can supply a
 * stub instead of a real platform executable — the default spawns
 * `<binary> --version`, which only works for a genuine binary on the current
 * platform.
 */
export type BinaryVerifier = (binaryPath: string) => boolean;

function defaultExtractor(platformKey: string): ArchiveExtractor {
  return (archivePath, destDir) => {
    if (platformKey === 'win32-x64') {
      execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}' -Force`,
        ],
        { timeout: 60_000 },
      );
    } else {
      execFileSync('tar', ['-xzf', archivePath, '-C', destDir], { timeout: 60_000 });
    }
  };
}

/**
 * The rtk binary name for the current platform. Windows needs the `.exe`
 * suffix; the archives themselves use `.zip` there and `.tar.gz` elsewhere,
 * which is why this is derived from `process.platform` rather than a caller.
 */
function rtkBinaryName(): string {
  return process.platform === 'win32' ? 'rtk.exe' : 'rtk';
}

/** Platform-arch key matching the bundled archive filenames, or null when unsupported. */
function archivePlatformKey(): string | null {
  // win32-arm64 has no published rtk build, so an arm64 Windows install falls
  // back to the x64 archive — Windows-on-ARM runs x64 binaries natively.
  if (process.platform === 'win32' && process.arch === 'arm64') return 'win32-x64';
  if (process.platform === 'win32') return 'win32-x64';
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64';
  if (process.platform === 'darwin') return 'darwin-x64';
  if (process.platform === 'linux' && process.arch === 'arm64') return 'linux-arm64';
  if (process.platform === 'linux') return 'linux-x64';
  return null;
}

function archiveName(platformKey: string): string {
  return platformKey === 'win32-x64' ? 'rtk-win32-x64.zip' : `rtk-${platformKey}.tar.gz`;
}

/**
 * The directory the extracted binary lives in. Uses CRAFT_CONFIG_DIR so tests
 * (and parallel dev instances) can redirect it, mirroring permissions-config.
 */
function provisionedDir(): string {
  const configDir = process.env.CRAFT_CONFIG_DIR || join(homedir(), '.craft-agent');
  return join(configDir, 'rtk', archivePlatformKey() ?? 'unknown');
}

/** Reads the expected checksum for an archive from the bundled SHA256SUMS.txt. */
function expectedChecksum(archivesDir: string, archive: string): string | null {
  const sumsPath = join(archivesDir, 'SHA256SUMS.txt');
  if (!existsSync(sumsPath)) return null;
  try {
    const line = readFileSync(sumsPath, 'utf-8')
      .split('\n')
      .find((l) => l.trim().endsWith(archive));
    // Extract the 64-hex run rather than splitting on whitespace: some
    // sha256sum builds prefix the hash with a binary-mode marker (`\`), which
    // would otherwise be carried into the comparison and always mismatch.
    return line?.match(/[a-fA-F0-9]{64}/)?.[0] ?? null;
  } catch {
    return null;
  }
}

function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Provision the bundled rtk binary for the current platform.
 *
 * Returns the path to a runnable binary, or null with a reason. Callers should
 * treat null as "rtk is unavailable" and continue; `rtk-rewrite` already
 * treats a null path as a no-op, so nothing downstream needs to change.
 */
export function provisionBundledRtk(
  resourcesPath?: string,
  extract?: ArchiveExtractor,
  verify?: BinaryVerifier,
): ProvisionResult {
  const platformKey = archivePlatformKey();
  if (!platformKey) return { path: null, reason: 'no-archive' };

  const archivesDir = join(
    resourcesPath ?? process.env.CRAFT_RESOURCES_BASE ?? '',
    'resources',
    'bin',
    'rtk-archives',
  );
  const archive = archiveName(platformKey);
  const archivePath = join(archivesDir, archive);

  if (!existsSync(archivePath)) return { path: null, reason: 'no-archive' };

  const targetDir = provisionedDir();
  const targetPath = join(targetDir, rtkBinaryName());

  // Idempotent fast path: already unpacked and the archive has not changed.
  // The existing binary is still verified — an unchanged archive says nothing
  // about whether the previously extracted file is intact, and silently
  // reusing a truncated or half-written binary would surface much later as a
  // broken Bash rewrite.
  const runVerify = verify ?? defaultVerifier;
  if (existsSync(targetPath)) {
    const expected = expectedChecksum(archivesDir, archive);
    if (expected && sha256OfFile(archivePath) === expected && runVerify(targetPath)) {
      return { path: targetPath, reason: 'already-present' };
    }
    // Archive changed, or the extracted binary is unusable: drop it and re-unpack.
    try {
      rmSync(targetPath, { force: true });
    } catch {
      // Fall through to the extract below; a failed delete surfaces there.
    }
  }

  const expected = expectedChecksum(archivesDir, archive);
  if (expected && sha256OfFile(archivePath) !== expected) {
    return { path: null, reason: 'checksum-mismatch' };
  }

  try {
    mkdirSync(targetDir, { recursive: true });
    const runExtract = extract ?? defaultExtractor(platformKey);
    runExtract(archivePath, targetDir);
  } catch {
    return { path: null, reason: 'extract-failed' };
  }

  if (!existsSync(targetPath)) return { path: null, reason: 'extract-failed' };
  if (process.platform !== 'win32') {
    try {
      execFileSync('chmod', ['+x', targetPath], { timeout: 5000 });
    } catch {
      // A missing +x bit makes the binary unrunnable; surface it as a failure
      // rather than handing back a path that cannot execute.
      return { path: null, reason: 'extract-failed' };
    }
  }

  // Sanity-check the extracted binary actually runs. A truncated or
  // wrong-arch file would otherwise only fail later, mid-rewrite.
  if (!runVerify(targetPath)) return { path: null, reason: 'extract-failed' };

  return { path: targetPath };
}

function defaultVerifier(binaryPath: string): boolean {
  try {
    const version = execFileSync(binaryPath, ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return /\d+\.\d+\.\d+/.test(version);
  } catch {
    return false;
  }
}

/**
 * Where a provisioned binary would live, without provisioning it. Used by the
 * detector so a previously provisioned binary is found on later runs without
 * needing `CRAFT_RTK` to have been set.
 */
export function provisionedRtkPath(): string | null {
  const platformKey = archivePlatformKey();
  if (!platformKey) return null;
  const targetPath = join(provisionedDir(), rtkBinaryName());
  return existsSync(targetPath) ? targetPath : null;
}

/** Size of the extracted binary in bytes, for logging. 0 when absent. */
export function provisionedRtkSize(): number {
  const path = provisionedRtkPath();
  if (!path) return 0;
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
