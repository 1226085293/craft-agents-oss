/**
 * Listener supervisor — owns the child processes.
 *
 * Contract with a listener:
 *   - receives CRAFT_EVENTS_URL / CRAFT_EVENTS_TOKEN / CRAFT_LISTENER_ID /
 *     CRAFT_LISTENER_DATA in its environment,
 *   - POSTs `craft-event/1` payloads to CRAFT_EVENTS_URL,
 *   - may GET `${CRAFT_EVENTS_URL}/health` to prove it is alive.
 *
 * Guarantees Craft keeps:
 *   - `shell:false` + argv array: a manifest cannot inject a command line,
 *   - stdout/stderr land in `<data>/proc.log` (5MB tail budget),
 *   - kill is a process TREE kill on Windows, otherwise python/node children
 *     survive and hold the port,
 *   - crashes restart with 1/2/4/8/16s backoff, then stop and stay `failed`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '@craft-agent/shared/utils';
import type { ListenerManifest } from '@craft-agent/shared/events/manifest.ts';
import type { LoadedListener } from './listener-registry.ts';

const log = createLogger('events');

const DEFAULT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];
const DEFAULT_MAX_ATTEMPTS = 5;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const STOP_GRACE_MS = 3000;

export type ListenerProcessState = 'stopped' | 'starting' | 'running' | 'degraded' | 'failed';

export interface ListenerRuntimeStatus {
  id: string
  state: ListenerProcessState
  pid: number | null
  startedAt: number | null
  /** Consecutive failed starts. */
  attempts: number
  /** Last exit code, when known. */
  lastExitCode: number | null
  lastError: string | null
  /** Tail of proc.log when the process gave up with a non-zero exit. */
  startupErrorTail?: string
}

interface RunningListener {
  child: ChildProcess
  status: ListenerRuntimeStatus
  restartTimer: NodeJS.Timeout | null
  healthTimer: NodeJS.Timeout | null
  stopping: boolean
}

export interface SupervisorOptions {
  /** Resolves the env a listener receives. */
  envFor: (listenerId: string) => Record<string, string>
  /** Called whenever a status changes, for the renderer. */
  onStatus?: (status: ListenerRuntimeStatus) => void
}

function rotateIfNeeded(logPath: string): void {
  try {
    if (existsSync(logPath) && statSync(logPath).size > LOG_MAX_BYTES) {
      renameSync(logPath, `${logPath}.1`);
    }
  } catch {
    // Rotation is best-effort; a read-only data dir must not break startup.
  }
}

function substitute(value: string, listener: LoadedListener): string {
  return value.replace(/\$\{dir\}/g, listener.dir).replace(/\$\{data\}/g, listener.dataDir);
}

/** Keep the last N lines — startup errors live at the end of the log. */
function lastLogLines(text: string, max = 30): string {
  const trimmed = text.replace(/\s+$/, '');
  if (!trimmed) return '';
  const lines = trimmed.split('\n');
  return (lines.length > max ? lines.slice(-max).join('\n') : trimmed).slice(0, 8000);
}

export class ListenerSupervisor {
  private readonly options: SupervisorOptions;
  private readonly running = new Map<string, RunningListener>();
  private readonly statuses = new Map<string, ListenerRuntimeStatus>();

  constructor(options: SupervisorOptions) {
    this.options = options;
  }

  getStatus(id: string): ListenerRuntimeStatus {
    return this.statuses.get(id) ?? {
      id,
      state: 'stopped',
      pid: null,
      startedAt: null,
      attempts: 0,
      lastExitCode: null,
      lastError: null,
    };
  }

  listStatuses(): ListenerRuntimeStatus[] {
    return Array.from(this.statuses.values());
  }

  private setStatus(status: ListenerRuntimeStatus): void {
    this.statuses.set(status.id, status);
    this.options.onStatus?.(status);
  }

  /** Start a listener. A no-op when it is already running. */
  start(listener: LoadedListener): ListenerRuntimeStatus {
    if (this.running.has(listener.id)) return this.getStatus(listener.id);

    const manifest: ListenerManifest = listener.manifest;
    const program = manifest.runtime?.program;
    if (!program || program.length === 0) {
      const status: ListenerRuntimeStatus = {
        ...this.getStatus(listener.id),
        state: 'failed',
        lastError: 'manifest has no runtime.program',
      };
      this.setStatus(status);
      return status;
    }

    mkdirSync(listener.dataDir, { recursive: true });
    const logPath = join(listener.dataDir, 'proc.log');
    rotateIfNeeded(logPath);

    // Surface the user's saved config (email, authCode…) to the child as a
    // file it can read — secrets stay out of the environment block. Written
    // on every start so a config edit applies on the next enable.
    let configPath: string | null = null;
    if (listener.config && Object.keys(listener.config).length > 0) {
      configPath = join(listener.dataDir, 'config.json');
      try {
        writeFileSync(configPath, `${JSON.stringify(listener.config, null, 2)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        });
      } catch {
        configPath = null;
      }
    }

    const argv = program.map((part) => substitute(part, listener));
    const cwd = manifest.runtime?.cwd ? substitute(manifest.runtime.cwd, listener) : listener.dir;

    let env: Record<string, string>;
    try {
      env = {
        ...process.env as Record<string, string>,
        ...this.options.envFor(listener.id),
        CRAFT_LISTENER_DATA: listener.dataDir,
        ...(configPath ? { CRAFT_LISTENER_CONFIG: configPath } : {}),
      };
    } catch (error) {
      const status: ListenerRuntimeStatus = {
        ...this.getStatus(listener.id),
        state: 'failed',
        lastError: `event ingest server is not running: ${String(error)}`,
      };
      this.setStatus(status);
      return status;
    }

    const command = argv[0]!;
    const args = argv.slice(1);

    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const status: ListenerRuntimeStatus = {
        ...this.getStatus(listener.id),
        state: 'failed',
        lastError: `cannot spawn ${command}: ${String(error)}`,
      };
      this.setStatus(status);
      return status;
    }

    const startedAt = Date.now();
    const status: ListenerRuntimeStatus = {
      id: listener.id,
      state: 'starting',
      pid: child.pid ?? null,
      startedAt,
      attempts: this.getStatus(listener.id).attempts,
      lastExitCode: null,
      lastError: null,
    };
    this.setStatus(status);

    const entry: RunningListener = {
      child,
      status,
      restartTimer: null,
      healthTimer: null,
      stopping: false,
    };
    this.running.set(listener.id, entry);

    const writeLog = (chunk: Buffer) => {
      try {
        appendFileSync(logPath, chunk);
      } catch {
        // A full disk must not take the app down with it.
      }
    };
    child.stdout?.on('data', writeLog);
    child.stderr?.on('data', writeLog);

    // Handshake: a listener that never answers /health is still alive but not
    // proven working. Mark degraded instead of restarting — slow starters
    // (python imports) would otherwise be killed in a loop.
    const readyTimeoutMs = manifest.runtime?.readyTimeoutMs ?? 20000;
    entry.healthTimer = setTimeout(() => {
      if (!this.running.has(listener.id) || entry.stopping) return;
      if (entry.status.state === 'running') return;
      entry.status = { ...entry.status, state: 'degraded' };
      this.setStatus(entry.status);
      log.warn(`[events] listener ${listener.id} started but did not report healthy`);
    }, readyTimeoutMs);
    entry.healthTimer.unref?.();

    child.on('error', (error) => {
      entry.status = {
        ...entry.status,
        state: 'failed',
        lastError: `spawn error: ${error.message}`,
      };
      this.setStatus(entry.status);
    });

    child.on('exit', (code, signal) => {
      if (entry.healthTimer) clearTimeout(entry.healthTimer);
      this.running.delete(listener.id);
      if (entry.stopping) {
        this.setStatus({ ...entry.status, state: 'stopped', pid: null, lastExitCode: code, attempts: 0 });
        return;
      }
      this.scheduleRestart(listener, entry, code, signal);
    });

    return status;
  }

  /**
   * Restart with a last-known-good fallback.
   *
   * A plugin change used to be "stop, start, hope". If the new configuration
   * cannot come up, the user was left with nothing running and an error they
   * had to read to understand. This starts the candidate, waits for it to prove
   * itself, and puts the previous config back if it does not — so a bad edit
   * costs a blip instead of an outage.
   *
   * The candidate is judged by reaching `running` (health reported), not by the
   * process merely staying alive: a plugin that spawns and then idles without a
   * connection is the exact failure this is meant to catch.
   */
  async restartWithFallback(listener: LoadedListener, previousConfig?: Record<string, unknown>): Promise<ListenerRuntimeStatus> {
    await this.stop(listener.id);
    const candidate = this.start(listener);
    if (candidate.state === 'failed') return candidate;

    const ready = await this.waitForHealthy(listener.id, listener.manifest.runtime?.readyTimeoutMs ?? 20000);
    if (ready || previousConfig === undefined) return this.getStatus(listener.id);

    const failure = this.getStatus(listener.id).lastError ?? 'did not become ready';
    log.warn(`[events] ${listener.id} failed to start with the new config, restoring the previous one`);
    await this.stop(listener.id);
    const restored = this.start({ ...listener, config: previousConfig });
    if (restored.state === 'failed') return restored;
    await this.waitForHealthy(listener.id, listener.manifest.runtime?.readyTimeoutMs ?? 20000);
    return {
      ...this.getStatus(listener.id),
      lastError: `new configuration failed (${failure}); running the previous configuration`,
    };
  }

  waitForHealthyForTest(id: string, timeoutMs: number): Promise<boolean> {
    return this.waitForHealthy(id, timeoutMs)
  }

  /** Resolve true once the listener is running, false when the wait expires. */
  private waitForHealthy(id: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const poll = () => {
        const state = this.getStatus(id).state;
        if (state === 'running') return resolve(true);
        if (state === 'failed' || state === 'stopped') return resolve(false);
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(poll, 200);
      };
      poll();
    });
  }

  /** Mark healthy — called when the listener answers its health probe. */
  markHealthy(id: string): void {
    const entry = this.running.get(id);
    if (!entry) return;
    if (entry.healthTimer) clearTimeout(entry.healthTimer);
    entry.status = { ...entry.status, state: 'running', attempts: 0, lastError: null };
    this.setStatus(entry.status);
  }

  private scheduleRestart(
    listener: LoadedListener,
    entry: RunningListener,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const policy = listener.manifest.runtime?.restart?.policy ?? 'on-failure';
    const attempts = entry.status.attempts + 1;
    const maxAttempts = listener.manifest.runtime?.restart?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const backoff = listener.manifest.runtime?.restart?.backoffMs ?? DEFAULT_BACKOFF_MS;

    const failed: ListenerRuntimeStatus = {
      ...entry.status,
      pid: null,
      lastExitCode: code,
      attempts,
      lastError:
        code === 0
          ? null
          : `exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
    };

    const cleanExit = code === 0 && !signal;
    if (policy === 'never' || (policy === 'on-failure' && cleanExit) || attempts >= maxAttempts) {
      const finalState = policy === 'never' || cleanExit ? 'stopped' : 'failed';
      this.setStatus({
        ...failed,
        state: finalState,
        // Only a real failure gets a log snapshot; the field is absent (not
        // empty) otherwise, so a fresh start clears it naturally.
        ...(finalState === 'failed'
          ? { startupErrorTail: lastLogLines(this.tailLog(listener.id, listener.dataDir, 4096)) }
          : {}),
      });
      if (attempts >= maxAttempts) {
        log.warn(`[events] listener ${listener.id} failed ${attempts} times, giving up`);
      }
      return;
    }

    const delay = backoff[Math.min(attempts - 1, backoff.length - 1)] ?? 1000;
    this.setStatus({ ...failed, state: 'starting', lastError: `restarting in ${delay}ms` });
    const timer = setTimeout(() => {
      this.running.delete(listener.id);
      this.start(listener);
    }, delay);
    timer.unref?.();
  }

  /** Stop and kill the tree. */
  async stop(id: string): Promise<void> {
    const entry = this.running.get(id);
    if (!entry) {
      const current = this.getStatus(id);
      if (current.state !== 'stopped') this.setStatus({ ...current, state: 'stopped', pid: null });
      return;
    }
    entry.stopping = true;
    if (entry.healthTimer) clearTimeout(entry.healthTimer);
    if (entry.restartTimer) clearTimeout(entry.restartTimer);

    const child = entry.child;
    const pid = child.pid;
    if (!pid) {
      this.running.delete(id);
      this.setStatus({ ...entry.status, state: 'stopped', pid: null });
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once('exit', finish);

      try {
        if (process.platform === 'win32') {
          // child.kill() leaves grandchildren (python -> node, etc.) orphaned.
          spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
            shell: false,
            windowsHide: true,
            stdio: 'ignore',
          }).on('exit', finish);
        } else {
          try {
            process.kill(-pid, 'SIGTERM');
          } catch {
            child.kill('SIGTERM');
          }
        }
      } catch {
        finish();
      }

      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
        finish();
      }, STOP_GRACE_MS);
      timer.unref?.();
    });

    this.running.delete(id);
    this.setStatus({ ...entry.status, state: 'stopped', pid: null });
  }

  /** Stop everything — app quit, workspace switch. */
  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.running.keys()).map((id) => this.stop(id)));
  }

  /** Last N lines of the listener log, for the detail page. */
  tailLog(id: string, dataDir: string, maxBytes = 8192): string {
    const logPath = join(dataDir, 'proc.log');
    if (!existsSync(logPath)) return '';
    try {
      const size = statSync(logPath).size;
      const { readFileSync, openSync, readSync, closeSync } = require('node:fs') as typeof import('node:fs');
      if (size <= maxBytes) return readFileSync(logPath, 'utf8');
      const fd = openSync(logPath, 'r');
      try {
        const buffer = Buffer.alloc(maxBytes);
        readSync(fd, buffer, 0, maxBytes, size - maxBytes);
        return buffer.toString('utf8');
      } finally {
        closeSync(fd);
      }
    } catch {
      return '';
    }
  }

  /** Test seam: write a trivial line, proving the log path is writable. */
  ensureDataDir(dataDir: string): void {
    mkdirSync(dataDir, { recursive: true });
    const keep = join(dataDir, '.keep');
    if (!existsSync(keep)) writeFileSync(keep, '', 'utf8');
  }
}
