/**
 * Synchronous, shell-free probe runner.
 *
 * Dependency checks (`python --version`, `pip show x`) happen inside a
 * render-blocking path, so they run synchronously with a hard timeout. Output
 * is small by construction; anything larger is truncated.
 *
 * Never uses a shell: the argv array goes straight to spawn, so a package name
 * from a manifest cannot turn into a command.
 */

import { execFileSync } from 'node:child_process';

const MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Run a command and return combined stdout+stderr, or null when the command is
 * missing / fails / times out.
 */
export function runProbe(command: string, args: string[], timeoutMs: number): string | null {
  try {
    const output = execFileSync(command, args, {
      timeout: timeoutMs,
      shell: false,
      windowsHide: true,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return typeof output === 'string' ? output : String(output);
  } catch (error) {
    // Non-zero exit still carries useful output (`pip show` on a missing
    // package prints a warning, `npm ls` exits 1 for unmet peers).
    const withOutput = error as { stdout?: unknown; stderr?: unknown };
    const stdout = typeof withOutput.stdout === 'string' ? withOutput.stdout : '';
    const stderr = typeof withOutput.stderr === 'string' ? withOutput.stderr : '';
    const combined = `${stdout}${stderr}`.trim();
    return combined ? combined : null;
  }
}
