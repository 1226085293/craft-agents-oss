/**
 * Dependency install for listeners.
 *
 * Runs exactly one command, built from the manifest's own dependency entry —
 * the renderer sends `{manager, name, range}` and never a command string, so a
 * compromised renderer cannot turn this into arbitrary execution.
 *
 * `shell:false` + argv array; output is captured and capped.
 */

import { execFile } from 'node:child_process';
import {
  isValidPackageName,
  isValidRange,
  type ListenerPackageDep,
} from '@craft-agent/shared/events/manifest.ts';

const INSTALL_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_CHARS = 16_000;

export interface InstallResult {
  ok: boolean;
  command: string;
  exitCode: number | null;
  output: string;
  error?: string;
}

/** Build the argv for an install. Exported for tests. */
export function buildInstallCommand(dep: ListenerPackageDep): { command: string; args: string[] } {
  if (dep.manager === 'pip') {
    // `pip install "name>=1.0"` — the spec is one argv entry on purpose.
    const spec = `${dep.name}${dep.range && dep.range !== '*' ? dep.range : ''}`;
    return { command: 'python', args: ['-m', 'pip', 'install', spec] };
  }
  return { command: 'npm', args: ['install', `${dep.name}@${dep.range || '*'}`] };
}

export function formatInstallCommand(dep: ListenerPackageDep): string {
  const { command, args } = buildInstallCommand(dep);
  return [command, ...args].join(' ');
}

export async function runInstallCommand(dep: ListenerPackageDep): Promise<InstallResult> {
  // Defense in depth: the renderer sends {manager, name, range}. The manifest
  // already validated the same fields, but this RPC accepts arbitrary JSON.
  if (
    (dep?.manager !== 'pip' && dep?.manager !== 'npm') ||
    !isValidPackageName(dep.manager, dep.name ?? '') ||
    !isValidRange(dep.range ?? '')
  ) {
    return { ok: false, command: '', exitCode: null, output: '', error: 'invalid dependency spec' };
  }
  const { command, args } = buildInstallCommand(dep);
  const display = [command, ...args].join(' ');

  return await new Promise<InstallResult>((resolve) => {
    execFile(
      command,
      args,
      { timeout: INSTALL_TIMEOUT_MS, shell: false, windowsHide: true, maxBuffer: MAX_OUTPUT_CHARS * 4 },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ''}${stderr ?? ''}`.trim().slice(0, MAX_OUTPUT_CHARS);
        if (error) {
          const code = typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null;
          resolve({
            ok: false,
            command: display,
            exitCode: code,
            output,
            error: error.message,
          });
          return;
        }
        resolve({ ok: true, command: display, exitCode: 0, output });
      },
    );
  });
}
