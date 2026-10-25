/**
 * Runtime owner of the in-process LLM gateway.
 *
 * The gateway itself (`llm-gateway.ts`) is deliberately a plain object with an
 * injected config snapshot: it has no idea where the config lives or how it
 * changes. This module is the piece that lives in the Craft main process —
 * it owns the singleton, loads `llm-config.json`, wires the watcher so the
 * gateway rebuilds its pools on save, and answers the one question the session
 * wiring needs: "which env vars should this session's subprocess get?".
 *
 * It also resolves the **availability** question. The gateway is only wired
 * into sessions when the new config is actually usable — at least one enabled
 * provider and one client key. Otherwise every session keeps the legacy
 * `resolveAuthEnvVars()` path, which is the safety property that lets this
 * rollout happen without a flag: a broken or absent `llm-config.json`
 * degrades to today's behaviour rather than to "no LLM at all".
 */

// NOTE: do NOT `createRequire(import.meta.url)` here. The Electron main
// process is bundled by esbuild with `--format=cjs` (see
// scripts/electron-build-main.ts), which leaves `import.meta.url` undefined
// for bundled inner modules — calling createRequire with it throws
// ERR_INVALID_ARG_VALUE at load time. This module is imported directly from
// the main process bundle (via config/index.ts), so keep it free of
// module-init require()/import.meta side effects.

import { loadLlmConfig, LLM_CONFIG_PATH } from './llm-config-loader.ts';
import type { LlmConfig } from './llm-config.ts';
import { LlmConfigWatcher } from './llm-config-watcher.ts';
import { LlmGateway, type LlmGatewayStatus, type LlmRouteChange } from './llm-gateway.ts';
import { appendLlmUsage, clearLlmUsageTemp, pruneDayFiles } from './llm-usage-store.ts';

export interface GatewayRuntimeOptions {
  /** Log sink; must tolerate masked values only. */
  log?: (message: string) => void;
  /** Injectable in tests. */
  now?: () => number;
}

/** Env vars a session's subprocess needs in order to reach the gateway. */
export interface GatewaySessionEnv {
  ANTHROPIC_BASE_URL: string;
  ANTHROPIC_API_KEY: string;
}

let singleton: GatewayRuntime | null = null;

/** The session log is wiped on the first start(), not on every reconnect. */
let tempCleared = false;

/**
 * Process-wide gateway runtime.
 *
 * Kept as a module-level singleton (rather than a DI value) because the
 * session wiring reaches it from several unrelated call sites, exactly like
 * `McpPoolServer` is held on the SessionManager.
 */
export class GatewayRuntime {
  private gateway: LlmGateway | null = null;
  private watcher: LlmConfigWatcher | null = null;
  private config: LlmConfig | null = null;
  /**
   * Bumped whenever a new config is applied. The gateway instance is recreated
   * on reconcile (so its own counter restarts at 1); this runtime-level counter
   * is what the settings page watches to know the on-disk config moved.
   */
  private revision = 0;
  /**
   * Why the most recent route was refused, for the settings UI. A session that
   * cannot be served needs to say so in the interface; chewing on a silent
   * `null` from the send path leaves the user with no next step.
   */
  private lastRefusal: string | null = null;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  /**
   * Session layer's listener for route changes. Held here (rather than passed
   * into `start()`) because the gateway instance is recreated on every config
   * reload; the runtime outlives it and re-supplies the same closure.
   */
  private routeChangeHandler: ((event: LlmRouteChange) => void) | null = null;

  constructor(options: GatewayRuntimeOptions = {}) {
    this.log = options.log ?? (() => {});
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Install the listener told about key/model switches. Idempotent: the last
   * installer wins, which is what a single SessionManager wants.
   */
  setRouteChangeHandler(handler: ((event: LlmRouteChange) => void) | null): void {
    this.routeChangeHandler = handler;
  }

  /** Current config snapshot, loaded on demand. */
  getConfig(): LlmConfig | null {
    if (!this.config) {
      this.config = loadLlmConfig((message) => this.log(`config rejected: ${message}`));
    }
    return this.config;
  }

  /** Swap in an already-parsed config and reconcile the gateway with it. */
  apply(config: LlmConfig): void {
    this.config = config;
    this.revision++;
    void this.reconcile();
  }

  /** Re-read the config from disk and reschedule the gateway if needed. */
  refresh(): LlmConfig | null {
    this.config = loadLlmConfig((message) => this.log(`config rejected: ${message}`));
    this.revision++;
    void this.reconcile();
    return this.config;
  }

  /**
   * True when the new config can actually serve traffic.
   *
   * Deliberately not a "gateway on" flag: enabling should follow from having a
   * usable config, so there is one source of truth instead of two that can
   * disagree.
   *
   * A client key is **not** part of that definition. The app reaches the
   * gateway through strategy-scoped paths (`/s/<id>/…`) on loopback, which the
   * server already treats as trusted — requiring a key to arm meant a user who
   * configured everything through the UI still had no running gateway, and
   * there is no UI for creating one. A key is only needed by an external
   * client calling the unscoped `/v1/messages`, and that case is refused at
   * request time (401), which is where it belongs.
   */
  get enabled(): boolean {
    const cfg = this.getConfig();
    if (!cfg) return false;
    return cfg.providers.some(
      (p) => p.enabled !== false && p.keys.some((k) => k.enabled !== false),
    );
  }

  get port(): number {
    return this.gateway?.port ?? 0;
  }

  get baseUrl(): string {
    return this.gateway?.baseUrl ?? '';
  }

  get running(): boolean {
    return this.gateway !== null;
  }

  /** Load config, start the gateway, and watch for changes. */
  async start(): Promise<boolean> {
    // Once per process: the session log starts empty. Detail persistence, when
    // enabled, lives in per-day files that survive restarts.
    if (!tempCleared) {
      tempCleared = true;
      clearLlmUsageTemp();
      pruneDayFiles(loadLlmConfig()?.usage?.retainDays);
    }
    const cfg = this.refresh();

    // The watcher is started unconditionally, even when we cannot arm yet. If it
    // were gated on `enabled`, a machine that boots without llm-config.json —
    // fresh install, or the file not created until the user opens LLM settings —
    // would have nothing listening when the file finally appears, and the
    // gateway would stay disarmed for the whole process lifetime.
    if (!this.watcher) {
      // The watcher owns the file handle and the debounce; it hands us the
      // parsed config so we never re-read the disk ourselves.
      this.watcher = new LlmConfigWatcher({
        onChange: (config) => {
          this.log('config changed on disk; re-scheduling gateway');
          this.apply(config);
        },
        onError: (reason) => {
          // A missing or invalid file lands here rather than in onChange.
          // Re-evaluate from disk rather than from the cached snapshot: if the
          // file is gone, `enabled` must become false so the gateway comes
          // down. A merely *invalid* file keeps the last good config
          // (`loadLlmConfig` returns null, leaving this.config untouched), so a
          // broken save never takes the gateway down — only deletion does.
          this.log(`config rejected: ${reason}`);
          this.refresh();
        },
      });
      this.watcher.start();
    }

    if (!this.enabled) {
      this.log('gateway not armed: llm-config.json missing or has no usable provider/client key');
      return false;
    }
    if (!this.gateway) {
      await this.spawn();
    }
    return true;
  }

  /** Stop the gateway and the watcher. Safe to call twice. */
  async stop(): Promise<void> {
    this.stopWatching();
    await this.stopGateway();
  }

  /** Stop watching for config changes. */
  private stopWatching(): void {
    this.watcher?.stop();
    this.watcher = null;
  }

  /**
   * Stop only the gateway, leaving the watcher alive.
   * reconcile() calls this when the config becomes unusable. Stopping the
   * watcher here as well would be self-defeating: with nothing listening, a
   * config that later becomes valid again would never be noticed, and the
   * gateway would stay down until the next launch. Verified on a dev instance
   * — delete llm-config.json, restore it, and the gateway used to stay dead.
   */
  private async stopGateway(): Promise<void> {
    // Drop the in-flight spawn first: otherwise its assignment below would
    // re-arm the gateway we are tearing down.
    const pending = this.spawnPromise;
    this.spawnPromise = null;
    await pending?.catch(() => {});
    await this.gateway?.stop();
    this.gateway = null;
  }

  /**
   * Env vars for a session that should route through the gateway.
   *
   * Returns null when the gateway is not armed, which is the caller's signal to
   * fall back to the legacy per-connection path.
   *
   * `clientKey` is picked by the caller so a session keeps the same key across
   * reconnects — the gateway's sticky sessions are keyed by it, and a session
   * that changed key on every resume would lose its key affinity.
   */
  sessionEnv(clientKey: string): GatewaySessionEnv | null {
    if (!this.gateway) return null;
    return {
      ANTHROPIC_BASE_URL: this.gateway.baseUrl,
      ANTHROPIC_API_KEY: clientKey,
    };
  }

  /** The client key to use for a session.
   *
   * A single key is the common case and must be stable. With several keys the
   * first is the default; the UI can pin a session to a specific key for
   * quota isolation.
   */
  defaultClientKey(): string | null {
    const keys = this.getConfig()?.clientKeys ?? [];
    return keys[0]?.key ?? null;
  }

  /** Snapshot for the settings UI and status broadcasts. */
  status(): LlmGatewayStatus & { enabled: boolean; lastRouteRefusal: string | null } {
    if (!this.gateway) {
      return {
        running: false,
        port: 0,
        baseUrl: '',
        generation: this.revision,
        strategies: [],
        lastModels: {},
        coolingKeys: 0,
        inFlight: 0,
        enabled: this.enabled,
        keyStates: [],
        lastRouteRefusal: this.lastRefusal,
      };
    }
    // The gateway already includes keyStates in its snapshot; do not fetch it
    // twice or the list is computed for nothing.
    const s = this.gateway.status();
    // Report the runtime revision, not the gateway's own counter: a reconcile
    // can replace the gateway instance, whose counter restarts at 1.
    return { ...s, generation: this.revision, enabled: true, keyStates: s.keyStates ?? [], lastRouteRefusal: this.lastRefusal };
  }

  /**
   * Record why a session could not be routed through the gateway.
   *
   * Exposed because the enforcement is a hard stop: without this the UI can
   * only say "something went wrong", while the reason (no group selected, group
   * has no models, group disabled) is exactly what the user needs to fix.
   */
  noteRouteRefusal(reason: string): void {
    this.lastRefusal = reason;
  }

  /** The last refusal reason, or null when routing has not been refused. */
  lastRouteRefusal(): string | null {
    return this.lastRefusal;
  }

/**
   * Persist whatever usage has accumulated since the last flush.
   *
   * Returns the number of records written. A flush failure is swallowed by the
   * store itself — usage is observability, never a dependency of the request
   * path — so this is safe to call from a timer without guarding every caller.
   *
   * This is the only way usage leaves the gateway: calling the gateway's
   * `drainUsage()` directly would consume records the next flush expects.
   */
  flushUsage(): number {
    const drained = this.gateway?.drainUsage() ?? [];
    if (drained.length === 0) return 0;
    appendLlmUsage(drained as never);
    return drained.length;
  }

  /**
   * Clear a key's cooldown (or every key's when `keyId` is omitted).
   *
   * The escape hatch for "this key is fine, the upstream was just having a
   * moment" — without it, a single bad minute costs the full cooldown window.
   * Returns whether anything was actually cleared, so the UI can tell the user
   * the difference between success and a key that was not cooling.
   */
  clearKeyCooldown(providerId?: string, keyId?: string): Promise<boolean> {
    if (!this.gateway) return Promise.resolve(false);
    return this.gateway.clearKeyCooldown(providerId, keyId);
  }

  /**
   * Tell the config watcher that the next events are our own write echoing
   * back, so a save does not trigger a redundant rebuild of every pool.
   */
  markConfigSelfWrite(withinMs?: number): void {
    this.watcher?.markSelfWrite(withinMs);
  }

  private spawnPromise: Promise<void> | null = null;

  /**
   * Create and start the gateway, at most once at a time.
   *
   * `refresh()` fires `reconcile()` without awaiting it, so a `start()`
   * racing a config reload could otherwise create two gateways — one of which
   * would be started but its promise dropped, leaving `port` 0 while the
   * runtime already reports running.
   */
  private spawn(): Promise<void> {
    if (this.spawnPromise) return this.spawnPromise;
    this.spawnPromise = (async () => {
      const cfg = this.getConfig();
      if (!cfg) return;
      const gateway = new LlmGateway({
        getConfig: () => this.getConfig() ?? cfg,
        log: (message) => this.log(`[gateway] ${message}`),
        // Read through `this` on every call so a listener installed after the
        // gateway started still receives events.
        onRouteChanged: (event) => this.routeChangeHandler?.(event),
      });
      await gateway.start();
      this.gateway = gateway;
      this.log(`gateway listening on ${gateway.baseUrl}`);
    })().catch((err: unknown) => {
      this.log(`gateway failed to start: ${err instanceof Error ? err.message : String(err)}`);
    }).finally(() => {
      this.spawnPromise = null;
    });
    return this.spawnPromise;
  }

  /** Build if we should be running and aren't, or tear down if the reverse. */
  private async reconcile(): Promise<void> {
    const shouldRun = this.enabled;
    if (shouldRun && !this.gateway) {
      await this.spawn();
      return;
    }
    if (!shouldRun && this.gateway) {
      // Only the gateway goes down; the watcher must survive so a config that
      // becomes valid again can re-arm without a restart.
      await this.stopGateway();
      return;
    }
    if (shouldRun && this.gateway) {
      // Hot reload while armed. `getConfig` already returns the new object, but
      // pools and breakers are keyed by the config that built them — and the
      // generation counter is what tells the settings page to re-read. Both
      // only move on rebuild.
      this.gateway.rebuild();
    }
  }
}

/** The process-wide runtime. Created lazily so importing this module is cheap. */
export function getGatewayRuntime(): GatewayRuntime {
  if (!singleton) singleton = new GatewayRuntime();
  return singleton;
}

/** Test seam: drop the singleton. */
export function resetGatewayRuntime(): void {
  void singleton?.stop().catch(() => {});
  singleton = null;
}
