import { spawnSync } from 'node:child_process';
import { resolve, posix } from 'node:path';

export interface FilesystemIsolationPlan {
  status: 'enforced' | 'unavailable';
  backend: 'sandbox-exec' | 'bwrap' | 'firejail' | 'none';
  command: string;
  args: string[];
}

export interface FilesystemIsolationOptions {
  includeNetworkDeny?: boolean;
}

function existsOnPath(binary: string): boolean {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(checker, [binary], { stdio: 'ignore' });
  return result.status === 0;
}

let sandboxExecUsableCache: boolean | null = null;

function canUseSandboxExec(): boolean {
  if (sandboxExecUsableCache !== null) return sandboxExecUsableCache;
  if (!existsOnPath('sandbox-exec')) {
    sandboxExecUsableCache = false;
    return false;
  }

  const probe = spawnSync('sandbox-exec', ['-p', '(version 1) (allow default)', '/usr/bin/true'], { stdio: 'ignore' });
  sandboxExecUsableCache = probe.status === 0;
  return sandboxExecUsableCache;
}

function escapeSandboxPath(path: string): string {
  return path.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function buildDarwinSandboxProfile(
  sessionDir: string,
  options?: FilesystemIsolationOptions,
): string {
  // The profile only ever runs under macOS sandbox-exec, so resolve the
  // session dir with POSIX semantics: on a darwin host that is the native
  // resolve(), while on a Windows dev host it keeps the Unix-style input
  // absolute (resolve('/tmp/x') on win32 would produce C:\tmp\x, which is
  // not a valid sandbox subpath and breaks the darwin tests on Windows).
  const escapedRoot = escapeSandboxPath(
    process.platform === 'win32' ? posix.resolve('/', sessionDir) : resolve(sessionDir),
  );
  const profileParts = [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow file-read*)',
    '(deny file-write*)',
    `(allow file-write* (subpath "${escapedRoot}"))`,
  ];

  if (options?.includeNetworkDeny) {
    profileParts.push('(deny network*)');
  }

  return profileParts.join(' ');
}

/**
 * Wrap command execution to deny writes outside the current session directory.
 *
 * Current support:
 * - macOS: sandbox-exec profile
 * - Linux: bubblewrap (preferred) or firejail private/whitelist profile
 * - others: unavailable (fail-safe for script_sandbox)
 */
export function applyFilesystemIsolation(
  command: string,
  args: string[],
  sessionDir: string,
  options?: FilesystemIsolationOptions,
): FilesystemIsolationPlan {
  const sessionRoot = resolve(sessionDir);

  if (process.platform === 'darwin' && canUseSandboxExec()) {
    const profile = buildDarwinSandboxProfile(sessionRoot, options);

    return {
      status: 'enforced',
      backend: 'sandbox-exec',
      command: 'sandbox-exec',
      args: ['-p', profile, command, ...args],
    };
  }

  if (process.platform === 'linux') {
    if (existsOnPath('bwrap')) {
      // Read-only root + writable bind mount for the session subtree.
      // This limits writes to sessionRoot while preserving runtime/library access.
      return {
        status: 'enforced',
        backend: 'bwrap',
        command: 'bwrap',
        args: [
          '--die-with-parent',
          '--ro-bind', '/', '/',
          '--bind', sessionRoot, sessionRoot,
          '--proc', '/proc',
          '--dev', '/dev',
          '--',
          command,
          ...args,
        ],
      };
    }

    if (existsOnPath('firejail')) {
      return {
        status: 'enforced',
        backend: 'firejail',
        command: 'firejail',
        args: ['--quiet', `--private=${sessionRoot}`, `--whitelist=${sessionRoot}`, '--', command, ...args],
      };
    }
  }

  return {
    status: 'unavailable',
    backend: 'none',
    command,
    args,
  };
}
