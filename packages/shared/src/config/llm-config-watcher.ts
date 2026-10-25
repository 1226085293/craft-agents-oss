/**
 * llm-config.json hot-reload watcher.
 *
 * Behaviour copied from uni-api's `hot_reload.py` and Craft's own session
 * metadata watcher, because both solve the same three problems:
 *
 * 1. **Never break a running service.** A change applies only after it parses
 *    AND validates. Anything invalid is discarded and the previous config keeps
 *    serving traffic untouched.
 * 2. **Don't read a half-written file.** A settle period absorbs the editor's
 *    write-temp-then-rename dance and the duplicate `unlink` + `rename` bursts
 *    Windows `fs.watch` emits.
 * 3. **Don't react to our own write.** `markSelfWrite()` suppresses the echo of
 *    a save this process just performed, which otherwise causes a feedback loop
 *    and can revert in-memory state by reading stale data.
 */

import { watch, existsSync, type FSWatcher } from 'node:fs';
import { LLM_CONFIG_PATH } from './llm-config-loader.ts';
import { loadLlmConfig } from './llm-config-loader.ts';
import type { LlmConfig } from './llm-config.ts';

/** Quiet period before reading, in ms. uni-api uses 0.4s. */
const SETTLE_MS = 400;
/** How often to re-check for the config file when it does not exist yet. */
const WAIT_FOR_FILE_MS = 2000;

export interface LlmConfigWatcherOptions {
  /** Called with the new config after a successful reload. */
  onChange: (config: LlmConfig) => void;
  /** Called when a reload failed; `reason` is user-facing. */
  onError?: (reason: string) => void;
  /** Disable entirely (tests). */
  enabled?: boolean;
}

/**
 * Watches `llm-config.json` and reloads on change.
 *
 * The watcher never applies an invalid config: `loadLlmConfig` returns `null`
 * and the previous snapshot stays live. This is the whole point — a typo in the
 * JSON view must not take the gateway down mid-conversation.
 */
export class LlmConfigWatcher {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** Set only while waiting for the config file to appear for the first time. */
  private awaitTimer: NodeJS.Timeout | null = null;
  /** Epoch ms until which self-write echoes are ignored. */
  private selfWriteGuardUntil = 0;
  private disposed = false;

  constructor(private readonly options: LlmConfigWatcherOptions) {}

  /** Tell the watcher the next N ms of events are our own write echoing back. */
  markSelfWrite(withinMs = SETTLE_MS * 3): void {
    this.selfWriteGuardUntil = Date.now() + withinMs;
  }

  start(): void {
    if (this.options.enabled === false || this.watcher) return;
    if (!existsSync(LLM_CONFIG_PATH)) {
      // The file may not exist yet at startup — the user has never opened the
      // LLM settings, or this is a fresh install. Returning here makes the
      // watcher permanently deaf for the whole process lifetime: creating the
      // file later (from the UI, or by a migration) would never be noticed, and
      // the gateway would stay disarmed until the next launch.
      //
      // Poll for the file instead. This is a single stat() on a slow interval,
      // and only until the file shows up or stop() is called.
      if (this.awaitTimer) return;
      this.awaitTimer = setInterval(() => {
        if (existsSync(LLM_CONFIG_PATH)) {
          this.stopAwaiting();
          this.start();
        }
      }, WAIT_FOR_FILE_MS);
      // Deliberately not unref'd. An unref'd interval does not keep the loop
      // awake, and in a process whose only other pending work is itself a timer
      // the callback never runs — verified: the file appeared and onChange never
      // fired. stop() clears this, so there is no leak to avoid.
      return;
    }

    try {
      this.watcher = watch(LLM_CONFIG_PATH, () => this.schedule());
      // A file that appeared while we were polling produced no fs event, so
      // nothing will ever call schedule() for it. Reload once explicitly,
      // otherwise the first config after boot is silently ignored.
      this.schedule();
    } catch {
      // Non-fatal: hot reload is a convenience, not a requirement.
    }
  }

  private stopAwaiting(): void {
    if (this.awaitTimer) {
      clearInterval(this.awaitTimer);
      this.awaitTimer = null;
    }
  }

  stop(): void {
    this.disposed = true;
    this.stopAwaiting();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
  }

  /** Debounced reload. Exposed so callers can force a reload after creating the file. */
  schedule(): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.reload(), SETTLE_MS);
  }

  /** Reload now. Returns the applied config, or `null` when the file is invalid. */
  reload(): LlmConfig | null {
    if (Date.now() < this.selfWriteGuardUntil) return null;

    const errors: string[] = [];
    const next = loadLlmConfig((msg) => errors.push(msg));
    if (!next) {
      // Discard — keep serving the previous config.
      this.options.onError?.(errors[0] ?? `${'llm-config.json'} 加载失败`);
      return null;
    }
    this.options.onChange(next);
    return next;
  }
}

