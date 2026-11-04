/**
 * Managed MCP registry — installs MCP servers declared in a listener's
 * `dependencies.mcp` into `<workspace>/mcp/<id>/`.
 *
 * Craft owns the directory on purpose: a listener must never decide where an
 * MCP server lands on disk, or the user loses track of what was installed and
 * how to remove it. Commands are argv-only (no shell) and built exclusively
 * from manifest fields that parseManifest already validated.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ListenerMcpDep } from '@craft-agent/shared/events/manifest.ts';

const INSTALL_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_CHARS = 16_000;
/** Written after a successful install; presence + id match = installed. */
const MARKER = '.craft-mcp.json';

export interface McpInstallResult {
  ok: boolean;
  command: string;
  exitCode: number | null;
  output: string;
  error?: string;
}

/** `<workspace>/mcp/<id>/` — the only place managed MCP servers may live. */
export function mcpInstallDir(workspaceRoot: string, id: string): string {
  return join(workspaceRoot, 'mcp', id);
}

/** Build the install argv. Null = nothing Craft can run (manual/remote). */
export function buildMcpInstallCommand(
  dep: ListenerMcpDep,
  installDir: string,
): { command: string; args: string[] } | null {
  if (dep.mode !== 'managed') return null;
  if (dep.source === 'npm' && dep.package) {
    return {
      command: 'npm',
      args: ['install', `${dep.package}@${dep.version || 'latest'}`, '--prefix', installDir],
    };
  }
  if (dep.source === 'pypi' && dep.package) {
    const spec = `${dep.package}${dep.version && dep.version !== '*' ? dep.version : ''}`;
    return { command: 'python', args: ['-m', 'pip', 'install', spec, '--target', installDir] };
  }
  return null;
}

function readMarker(dir: string): { id?: unknown; version?: unknown } | null {
  if (!existsSync(join(dir, MARKER))) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(dir, MARKER), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function isMcpInstalled(
  workspaceRoot: string,
  dep: ListenerMcpDep,
): { installed: boolean; version?: string } {
  if (dep.mode !== 'managed') return { installed: true }; // remote: nothing to install
  const marker = readMarker(mcpInstallDir(workspaceRoot, dep.id));
  if (!marker || marker.id !== dep.id) return { installed: false };
  return { installed: true, ...(typeof marker.version === 'string' ? { version: marker.version } : {}) };
}

export async function installMcp(workspaceRoot: string, dep: ListenerMcpDep): Promise<McpInstallResult> {
  if (dep.mode !== 'managed') {
    return {
      ok: false,
      command: '',
      exitCode: null,
      output: '',
      error: 'remote MCP servers are configured, not installed',
    };
  }
  const installDir = mcpInstallDir(workspaceRoot, dep.id);
  const built = buildMcpInstallCommand(dep, installDir);
  if (!built) {
    return {
      ok: false,
      command: '',
      exitCode: null,
      output: '',
      error: `mcp "${dep.id}" is source:${dep.source ?? '?'} — install it manually, then re-check`,
    };
  }
  const display = [built.command, ...built.args].join(' ');
  mkdirSync(installDir, { recursive: true });

  return await new Promise<McpInstallResult>((resolve) => {
    execFile(
      built.command,
      built.args,
      {
        timeout: INSTALL_TIMEOUT_MS,
        shell: false,
        windowsHide: true,
        maxBuffer: MAX_OUTPUT_CHARS * 4,
        cwd: installDir,
      },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ''}${stderr ?? ''}`.trim().slice(0, MAX_OUTPUT_CHARS);
        if (error) {
          const code =
            typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null;
          resolve({
            ok: false,
            command: display,
            exitCode: code,
            output,
            ...(error.message ? { error: error.message } : {}),
          });
          return;
        }
        try {
          writeFileSync(
            join(installDir, MARKER),
            `${JSON.stringify(
              {
                id: dep.id,
                package: dep.package ?? null,
                version: dep.version ?? '*',
                installedAt: new Date().toISOString(),
              },
              null,
              2,
            )}\n`,
            'utf8',
          );
        } catch (markerError) {
          resolve({
            ok: false,
            command: display,
            exitCode: 0,
            output,
            error: `installed but could not write marker: ${String(markerError)}`,
          });
          return;
        }
        resolve({ ok: true, command: display, exitCode: 0, output });
      },
    );
  });
}

/** Remove a managed install (best-effort directory delete). */
export function uninstallMcp(workspaceRoot: string, id: string): void {
  const { rmSync } = require('node:fs') as typeof import('node:fs');
  try {
    rmSync(mcpInstallDir(workspaceRoot, id), { recursive: true, force: true });
  } catch {
    // Best-effort; a stale marker simply reads as not-installed.
  }
}
