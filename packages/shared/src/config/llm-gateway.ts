/**
 * LlmGateway — the embedded multi-upstream LLM gateway.
 *
 * Craft's pi SDK runs in a child process and only honours
 * `ANTHROPIC_BASE_URL`, so the gateway is a local HTTP server bound to
 * 127.0.0.1 on a random port, with the SDK pointed at it. That keeps the
 * scheduling engine inside the main process without touching the SDK.
 *
 * Two constraints shaped this file:
 *
 * 1. **The URL shape is load-bearing.** `unified-network-interceptor.ts`
 *    decides to intercept by `baseUrl.startsWith(ANTHROPIC_BASE_URL) &&
 *    url.includes('/messages')`. The gateway must therefore serve
 *    `POST /v1/messages`; anything else breaks metadata injection for every
 *    request.
 * 2. **Nothing here may log a key.** Keys are inline plaintext in
 *    `llm-config.json`, so error messages, trace spans, and console output
 *    must go through `maskKey` and never interpolate a raw key.
 *
 * Scope in this phase: scheduling plus a direct passthrough to
 * `anthropic-messages` upstreams. Protocol conversion to `openai-completions`
 * is a later phase and is stubbed as an explicit error rather than a silent
 * failure.
 */

import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { createHash } from 'node:crypto';

import type {
  LlmConfig,
  LlmProvider,
  LlmStrategy,
  LlmPreset,
  LlmSwitchAction,
  LlmSwitchFailure,
  LlmSwitchPolicy,
} from './llm-config.ts';
import { maskKey } from './llm-config.ts';
import { rulesForModel, type RateLimitRule, type WindowEntry } from './llm-rate-limiter.ts';
import { MODEL_KIND_HEADER, MODEL_KIND_OVERRIDE_HEADER, SESSION_HEADER } from './model-request-kind.ts';
import {
  AllKeysUnavailableError,
  KeyPool,
  type CooldownDurations,
  type RateLimitSignal,
} from './llm-key-pool.ts';
import { estimateRequestTokens } from './llm-token-estimate.ts';
import { openStrategyModels } from './strategy-availability.ts';
import {
  capEffort,
  clampEffort,
  effortCandidates,
  isEffortRejection,
  parseEffortsCatalog,
  requestedEffort,
  thinkingForEffort,
} from './reasoning-effort.ts';
import { loadCooldowns, saveCooldowns, cooldownKey } from './llm-cooldown-store.ts';
import {
  candidateUnits,
  planRequest,
  resolveStrategyForClientKey,
  type Plan,
  type PlannedUnit,
} from './llm-planner.ts';
import { transcodeRequestToOpenAI, openAIHeaders } from './llm-transcode-request.ts';
import { ResponseTranscoder, transcodeResponseToAnthropic } from './llm-transcode-response.ts';
import { DEFAULT_PRESET, resolvePreset, resolvePresetId } from './llm-config.ts';
import { chatEndpointFor, modelsEndpointFor } from './llm-endpoint.ts';
import {
  GATEWAY_STREAM_TRUNCATION_EXHAUSTED_MARKER,
  GATEWAY_STREAM_TRUNCATION_RETRY_MARKER,
  GatewayStreamRetryStateStore,
  gatewayRequestFingerprint,
  type GatewayStreamRetryState,
} from './gateway-stream-retry.ts';

/** How long a provider's discovered `GET /models` effort catalog is trusted. */
const CATALOG_TTL_MS = 10 * 60_000;

/** How long to wait for a `GET /models` catalog before giving up on it. */
const CATALOG_TIMEOUT_MS = 10_000;

export interface LlmGatewayOptions {
  /** Current config snapshot. Replaced wholesale on hot reload. */
  getConfig: () => LlmConfig;
  /** Injectable transport, so tests never touch the network. */
  fetchImpl?: typeof fetch;
  /** Log sink. Must tolerate being called with masked values only. */
  log?: (message: string) => void;
  /**
   * Called after a successful request when this session's route (key,
   * provider or upstream model) differs from the previous one. The gateway
   * only reports the change; the session layer owns compaction.
   */
  onRouteChanged?: (event: LlmRouteChange) => void;
}

/** A session's route changed since its previous successful request. */
export interface LlmRouteChange {
  sessionId: string;
  strategyId: string;
  /** Switching unit that served the request: `provider::model`. */
  unitId: string;
  providerId: string;
  keyId: string;
  upstreamModel: string;
  /**
   * The public model the serving unit represents — the name in the group's
   * `modelAliases` / member list, not the provider-specific upstream alias.
   * This is the id a session can adopt: it matches the routed connection's
   * model entries (context windows, capabilities) and the router's own
   * `resolvedModel` hint (2026-10-30, failover display did not follow).
   */
  publicModel: string;
  previous: {
    strategyId: string;
    unitId?: string;
    providerId: string;
    keyId: string;
    upstreamModel: string;
  };
  /** Which part moved; a fallback can move all three at once. */
  reason: 'key' | 'model' | 'both';
}

/** Last successful route per session, used to detect a switch. */
interface SessionRoute {
  strategyId: string;
  unitId: string;
  providerId: string;
  keyId: string;
  upstreamModel: string;
}

/** Per-key scheduling snapshot, for the provider detail key table. */
export interface LlmGatewayKeyState {
  provider: string;
  keyId: string;
  cooling: boolean;
  cooldownRemaining: number;
  inFlight: number;
  available: boolean;
  weight: number;
}

export interface LlmGatewayStatus {
  running: boolean;
  port: number;
  baseUrl: string;
  /**
   * Strategies with the public model names they can actually serve.
   * `models` is the union over enabled members' provider mappings — an empty
   * array means the strategy is configured but unusable, which the composer
   * must say out loud instead of falling back to some other list.
   */
  strategies: Array<{
    id: string
    type: string
    providers: number
    models: string[]
    /**
     * The subset of `models` that can serve a request right now, in declared
     * order — availability windows applied. Empty with a non-empty `models`
     * means "every model is closed right now", which is a state the composer
     * shows as unavailable rather than naming a model that will fail.
     */
    openModels?: string[]
    /** Display name; the id is a slug and reads badly for non-ASCII names. */
    name?: string
    /** Disabled strategies are hidden from the composer entirely. */
    enabled: boolean
    /** False when the strategy is configured but cannot serve anything. */
    usable: boolean
    /** Why it is unusable, for the picker's warning tooltip. */
    reason?: string
  }>;
  /**
   * The last model each strategy actually routed to, `strategyId -> model`.
   *
   * This is history, and the composer uses it for the one thing history is good
   * for: sizing the context ring against the model that produced the current
   * context. It is deliberately *not* what the "next request" half of the
   * label reads — that is `openModels` plus the session's own model, because
   * naming the last model is how the label ended up disagreeing with the very
   * next request (2026-10-29: chip said `hy3` from a finished mini completion
   * while the conversation request went to `hy4-preview`).
   */
  lastModels?: Record<string, string>;
  coolingKeys: number;
  inFlight: number;
  /** Per-key cooldown / in-flight snapshot; drives the UI's countdowns. */
  keyStates?: LlmGatewayKeyState[];
  /**
   * Bumped on every config rebuild (load, hot reload, save). The settings page
   * compares it against the generation it rendered and re-reads the config, so
   * an edit made outside the app shows up without a manual refresh.
   */
  generation: number;
}

/**
 * One gateway decision, as persisted to `llm-usage.jsonl`.
 *
 * Field set is fixed by the design doc §7: token counts, latencies and the
 * trace stages are what the overview charts aggregate, and the trace array is
 * what a provider's timeline renders. Keep the names stable — the file is
 * append-only and read by dashboards written against these keys.
 */
/** Accumulator shape for `scrapeUsage`. */
interface MutableUsage {
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
}

/**
 * One in-flight upstream call.
 *
 * The controller has to outlive `fetch()`: the total timeout must cover the
 * streamed body, and the first-byte timeout has to be able to abort a body that
 * never produces a chunk. `settle()` releases both timers once the body is done
 * (or abandoned), so a retry does not inherit the previous attempt's clock.
 */
interface UpstreamCall {
  response: Response;
  /**
   * First-byte budget left after the headers arrived. Measured from the moment
   * the request went out, so a slow header cannot buy the body extra time.
   */
  firstByteRemainingMs: number;
  /** Abort the request and its body stream. */
  abort: () => void;
  /** Clear the header/total timers. Must be called once the body is consumed. */
  settle: () => void;
}

/**
 * Canonical order the provider-detail timeline renders stages in.
 *
 * Stages that did not run are dropped rather than emitted with a zero offset,
 * so a first-attempt success shows four entries and a retried one shows six.
 */
const TRACE_STAGE_ORDER = [
  'provider_selected',
  'retry_provider',
  'cooldown_provider',
  'upstream_first_chunk',
  'stream_end',
  'usage_recorded',
] as const;

/**
 * Build the `stage@ms` trace array from measured offsets.
 *
 * The two upstream stages take their real latencies; `usage_recorded` is
 * stamped at build time since the write happens immediately after. Keeping the
 * format as `name@ms` strings means the append-only log stays a flat string
 * array and older readers simply ignore the suffix.
 */
function buildTraceStages(
  stageMs: Record<string, number>,
  firstByteMs: number | undefined,
  totalMs: number | undefined,
): string[] {
  const merged: Record<string, number> = { ...stageMs };
  if (typeof firstByteMs === 'number' && Number.isFinite(firstByteMs)) {
    merged.upstream_first_chunk = firstByteMs;
  }
  if (typeof totalMs === 'number' && Number.isFinite(totalMs)) {
    merged.stream_end = totalMs;
  }
  merged.usage_recorded = Math.max(0, ...Object.values(merged), typeof totalMs === 'number' ? totalMs : 0);

  return TRACE_STAGE_ORDER.filter((stage) => merged[stage] !== undefined).map(
    (stage) => `${stage}@${Math.round(merged[stage]!)}`,
  );
}

export interface UsageRecord {
  ts: number;
  /** When the request was sent; the log's 时间 column. See `LlmUsageRecord`. */
  startedAt?: number;
  strategy: string;
  /** Switching unit that served (or died on) the request: `provider::model`. */
  unitId?: string;
  provider: string;
  keyId: string;
  publicModel: string;
  upstreamModel: string;
  /** What the request was for; see `LlmUsageRecord.kind`. */
  kind?: string;
  status: 'success' | 'error' | 'no_healthy_account';
  statusCode: number;
  attempts: number;
  error?: string;
  /** Session that issued the request, when the client supplied one. */
  sessionId?: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  firstByteMs?: number;
  totalMs?: number;
  retried?: boolean;
  /**
   * An upstream attempt that was followed by another one. Logged, not counted:
   * see `LlmUsageRecord.superseded`.
   */
  superseded?: boolean;
  trace?: string[];
}

/** Default request timeout when no preset value applies. */
const DEFAULT_TOTAL_SECONDS = 600;
/** Cap on request body size, guarding against a runaway prompt. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** Matches DEFAULT_PRESET.maxImageParts; used when a preset leaves it unset. */
const DEFAULT_PRESET_MAX_IMAGE_PARTS = DEFAULT_PRESET.maxImageParts ?? 4;
/**
 * Keys of one provider a single request may try before moving on.
 *
 * Keys are separate accounts: one that times out or is rate-limited says
 * nothing about the next, so the ladder rotates within the provider first (it
 * is the cheapest hop). The cap is a wall-clock guard rather than a policy —
 * a first-byte timeout costs the whole preset budget, so three keys is the most
 * a client should wait for one provider before the request goes elsewhere.
 */
const MAX_KEY_TRIES_PER_PROVIDER = 3;

/** Persisted-cooldown namespaces; key cooldowns stay unprefixed for compat. */
const UNIT_COOLDOWN_PREFIX = 'unit|';
const ENDPOINT_COOLDOWN_PREFIX = 'endpoint|';

/** A model that cannot be served is retried after this, not before. */
const DEFAULT_ROUTE_COOLDOWN_SECONDS = 300;

/**
 * See `LlmStrategy.switchPolicy`; these are the shipped defaults.
 *
 * `transport` is `retry-same` for the same reason `server_error` is: an
 * aborted connection or a first-byte timeout is the *one* failure a retry can
 * plausibly fix, and both surface to the user as the same 503 ("no healthy
 * account"). Giving up after a single one dropped a whole model out of a
 * group on a transient blip while the retry budget the user configured sat
 * unspent (2026-10-30, deepseek-v4.1-flash → hy4-preview after one aborted
 * request). The budget is `retry.maxAttempts`, so "retry 3 times" now means
 * three tries on the route before the group moves on.
 *
 * The account-level kinds stay on `next-*` on purpose: a 429 that names its
 * own reset (60124s), an empty balance or a revoked key is not going to
 * answer differently on the second identical request — the account has to
 * change, which is exactly what those actions do.
 */
const DEFAULT_SWITCH_POLICY: Required<LlmSwitchPolicy> = {
  rate_limit: 'next-key',
  quota: 'next-key',
  auth: 'next-key',
  model_not_found: 'next-unit',
  transport: 'retry-same',
  server_error: 'retry-same',
};

/** See `LlmGateway.execute`: an attempt waiting for its log row. */
interface PendingAttempt {
  unitId: string;
  provider: string;
  keyId: string;
  /** The model this attempt asked for; differs from the request on a fallback. */
  publicModel: string;
  upstreamModel: string;
  statusCode: number;
  error: string;
  firstByteMs?: number;
  attemptNumber?: number;
}

export class LlmGateway {
  private readonly getConfig: LlmGatewayOptions['getConfig'];
  private readonly fetchImpl: typeof fetch;
  private readonly log: (message: string) => void;
  private readonly onRouteChanged?: LlmGatewayOptions['onRouteChanged'];

  private httpServer: HttpServer | null = null;
  private _port = 0;
  private sockets = new Set<Socket>();

  /** Per-provider scheduling state, rebuilt on config reload. */
  private pools = new Map<string, KeyPool>();
  private generation = 0;

  /**
   * Route-scoped cooldown: `provider::publicModel` -> epoch-seconds.
   *
   * A model that 404s on one provider says nothing about the account: the next
   * key would fail the same way, while another model on the same account may be
   * perfectly fine. Cooling the *unit* is what keeps a single bad model from
   * taking every model of that provider down with it — 261027-long-bronze
   * cooled the only key on a 404 and refused all three configured models for a
   * minute.
   */
  private unitCooling = new Map<string, number>();

  /**
   * Endpoint-scoped cooldown: provider id -> epoch-seconds.
   *
   * Transport failures (DNS / TLS / connection / first-byte timeout) belong to
   * `baseUrl`, not to a key or a model: every unit of that provider pays the
   * same cost, so the request skips the whole endpoint instead of multiplying
   * the wait per key and per model.
   */
  private endpointCooling = new Map<string, number>();

  /**
   * Highest effort this route has actually accepted, keyed `provider::model`.
   *
   * Filled only when a level was rejected and a lower one worked, so the next
   * turn starts at the working level instead of paying the same 400 again.
   * `'none'` means the route refused every level and requests carry no field.
   */
  private effortCeilings = new Map<string, string>();

  /**
   * Upstream `reasoning_efforts` ladders discovered from `GET /models`, keyed
   * `provider.id`. Timestamped so a relay probed once is not re-probed on every
   * turn; cleared on rebuild alongside the ceilings, because a hot reload can
   * legitimately change the provider set.
   */
  private effortsCatalog = new Map<string, { at: number; byModel: Map<string, string[]> }>();

  private inFlight = 0;
  private usage: UsageRecord[] = [];
  private readonly streamRetryStates = new GatewayStreamRetryStateStore();

  /**
   * Last upstream model each strategy routed to, `strategyId -> model`.
   *
   * Written on a successful request and never evicted: an idle strategy keeps
   * reporting its last answer rather than going blank, which is what a user
   * reading the composer label expects. Cleared on reload so a renamed or
   * removed strategy does not linger in the payload.
   */
  private lastModels = new Map<string, string>();

  /**
   * Last successful route per session, keyed by the inbound session id.
   * Cleared on rebuild: a hot reload can legitimately change the provider
   * set, and comparing across that boundary would report a phantom switch.
   */
  private sessionRoutes = new Map<string, SessionRoute>();

  constructor(options: LlmGatewayOptions) {
    this.getConfig = options.getConfig;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log ?? (() => {});
    this.onRouteChanged = options.onRouteChanged;
    this.rebuild();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  get port(): number {
    return this._port;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this._port}`;
  }

  /** The URL the pi SDK is pointed at. Shape must stay `…/v1/messages`. */
  get messagesUrl(): string {
    return `${this.baseUrl}/v1/messages`;
  }

  async start(): Promise<void> {
    if (this.httpServer) return;

    this.httpServer = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        this.log(`gateway request handler error: ${describeError(err)}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
        }
        res.end(JSON.stringify({ error: { type: 'api_error', message: 'gateway internal error' } }));
      });
    });

    // Track sockets so stop() can drop in-flight connections instead of
    // waiting for every SSE stream to end on its own.
    this.httpServer.on('connection', (socket: Socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once('error', reject);
      this.httpServer!.listen(0, '127.0.0.1', () => {
        const addr = this.httpServer!.address();
        this._port = typeof addr === 'object' && addr ? addr.port : 0;
        this.log(`gateway listening on 127.0.0.1:${this._port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.httpServer) return;
    const server = this.httpServer;
    this.httpServer = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this._port = 0;
  }

  /**
   * Rebuild scheduling state from the current config.
   *
   * Called on load and on hot reload. In-flight requests keep the generation
   * they captured, so a reload cannot swap the pool underneath a retry ladder
   * — the "planned snapshot" semantic from the design doc.
   */
  rebuild(): void {
    const config = this.getConfig();
    const generation = ++this.generation;
    const oldPools = this.pools;

    // Drop stale routes: a renamed or deleted strategy must not keep reporting
    // a model in the composer's label.
    const live = new Set(config.strategies.map((s) => s.id));
    for (const id of [...this.lastModels.keys()]) {
      if (!live.has(id)) this.lastModels.delete(id)
    }
    // A reload can legitimately change providers/models. Comparing across it
    // would report a switch that the user did not make.
    this.sessionRoutes.clear();
    // Same reason: a saved config may declare a different ladder (or fix one
    // that was dropped), so a cached discovery — and especially a learned
    // ceiling from the old declaration — must not outlive the reload.
    this.effortCeilings.clear();
    // A saved config may declare a different ladder (or fix one that was
    // dropped), so a cached discovery must not outlive the reload either.
    this.effortsCatalog.clear();

    const pools = new Map<string, KeyPool>();

    for (const strategy of config.strategies) {
      const providers = strategy.members
        .map((m) => config.providers.find((p) => p.id === m.provider))
        .filter((p): p is LlmProvider => Boolean(p) && p!.enabled !== false);

      for (const provider of providers) {
        const enabledKeys = provider.keys.filter((k) => k.enabled !== false);

        const keyEntries: Array<{ id: string; enabled: boolean; weight: number }> = [];
        const rules = new Map<string, RateLimitRule[]>();
        const cooldowns = new Map<string, CooldownDurations>();
        const concurrency = new Map<string, number>();

        if (enabledKeys.length === 0) {
          // Keyless provider (a local relay with no credentials): give it one
          // synthetic key `''` so it still gets cooldown state — a keyless
          // upstream that fails must be cooled like any other. Its durations
          // come from the provider's default preset.
          keyEntries.push({ id: '', enabled: true, weight: 1 });
          const preset = config.presets[resolvePresetId(config, provider)] ?? {};
          cooldowns.set('', cooldownDurationsFromPreset(preset));
          concurrency.set('', preset.concurrency ?? 0);
        } else {
          for (const key of enabledKeys) {
            keyEntries.push({ id: key.id, enabled: true, weight: 1 });
            const preset = presetFor(this.getConfig(), provider, key.id);
            cooldowns.set(key.id, cooldownDurationsFromPreset(preset));
            rules.set(key.id, rulesForModel(preset, undefined));
            concurrency.set(key.id, preset.concurrency ?? 0);
          }
        }

        // A single pool per provider; strategy type decides the algorithm.
        const pool = new KeyPool({
          keys: keyEntries,
          algorithm: strategy.type,
          rules,
          now: () => Math.floor(Date.now() / 1000),
          stickySession: {
            ttlSeconds: strategy.stickySession?.ttlSeconds ?? 3600,
            maxEntries: strategy.stickySession?.maxEntries ?? 128,
          },
          cooldowns,
          concurrency,
          returnToOriginalPosition: strategy.cooldown?.returnToOriginalPosition ?? true,
          log: this.log,
        });
        // A provider can appear in several strategies; the shared pool keeps
        // cooldowns and in-flight counts consistent across them.
        pools.set(provider.id, pool);
      }
    }

    // Restore cooldown state: a live pool's state carries forward (a hot reload
    // must not un-cool a key that just 429'd); a NEW pool (or the first build
    // after an app restart) is restored from the persisted snapshot.
    const persisted = loadCooldowns();
    // Route and endpoint layers survive a reload the same way keys do: they are
    // longer-lived decisions (a model that 404'd is still 404ing), so rebuilding
    // them from scratch would re-probe a known-bad route on every config write.
    const nowSeconds = Math.floor(Date.now() / 1000);
    this.unitCooling = new Map(
      Object.entries(persisted)
        .filter(([key, until]) => key.startsWith(UNIT_COOLDOWN_PREFIX) && until > nowSeconds)
        .map(([key, until]) => [key.slice(UNIT_COOLDOWN_PREFIX.length), until]),
    );
    this.endpointCooling = new Map(
      Object.entries(persisted)
        .filter(([key, until]) => key.startsWith(ENDPOINT_COOLDOWN_PREFIX) && until > nowSeconds)
        .map(([key, until]) => [key.slice(ENDPOINT_COOLDOWN_PREFIX.length), until]),
    );
    for (const [providerId, pool] of pools) {
      const oldPool = oldPools.get(providerId);
      if (oldPool) {
        pool.importCooling(oldPool.exportCooling());
      } else {
        const entries: Record<string, number> = {};
        for (const [persistKey, until] of Object.entries(persisted)) {
          // The route/endpoint layers are not key cooldowns; their ids never
          // match a provider prefix, but skipping them keeps the intent clear.
          if (persistKey.startsWith(UNIT_COOLDOWN_PREFIX)) continue;
          if (persistKey.startsWith(ENDPOINT_COOLDOWN_PREFIX)) continue;
          const sep = persistKey.indexOf('::');
          if (sep < 0) continue;
          if (persistKey.slice(0, sep) === providerId) entries[persistKey.slice(sep + 2)] = until;
        }
        pool.importCooling(entries);
      }
    }

    // Only swap once everything built, so a failure leaves the old state live.
    this.pools = pools;
    this.log(`gateway rebuilt (generation ${generation}, ${pools.size} provider pools)`);
    // Log the rewrite once per rebuild rather than per request: this is the line
    // that turns "upstream returned 404" into an actionable
    // "you pasted a version root, the call goes to …/chat/completions".
    for (const provider of config.providers) {
      const original = provider.baseUrl.trim();
      const endpoint = chatEndpointFor(provider.baseUrl, provider.protocol);
      if (endpoint && endpoint !== original) {
        this.log(`provider ${provider.id}: chat endpoint ${endpoint} (baseUrl ${original})`);
      }
    }
  }

  /** Persist every provider's cooldown state to disk. */
  private persistCooldowns(): void {
    const map: Record<string, number> = {};
    for (const [providerId, pool] of this.pools) {
      for (const [keyId, until] of pool.exportCooling()) {
        map[cooldownKey(providerId, keyId)] = until;
      }
    }
    for (const [unitId, until] of this.unitCooling) {
      map[`${UNIT_COOLDOWN_PREFIX}${unitId}`] = until;
    }
    for (const [providerId, until] of this.endpointCooling) {
      map[`${ENDPOINT_COOLDOWN_PREFIX}${providerId}`] = until;
    }
    saveCooldowns(map);
  }

  /**
   * Whether at least one candidate unit for `model` under `strategy` is free
   * of route/endpoint cooldown right now. Mirrors the route-level half of
   * {@link unavailableUnitsFor} synchronously — key-pool health is consulted
   * live by the planner, not projected here.
   */
  private hasUncooledUnit(strategy: LlmStrategy, publicModel: string): boolean {
    let units: ReturnType<typeof candidateUnits>['units']
    try {
      units = candidateUnits(this.getConfig(), strategy, publicModel).units
    } catch {
      // A dangling provider reference is the planner's error to report.
      return true
    }
    const now = Date.now() / 1000
    return units.some((unit) => {
      if (
        (this.unitCooling.get(unit.id) ?? 0) > now ||
        (this.endpointCooling.get(unit.provider.id) ?? 0) > now
      ) {
        return false
      }
      // Key-pool health, synchronously via the pool's snapshot: a unit whose
      // every key is cooling / rate-limited / at capacity cannot serve either,
      // and ignoring it let the composer name a model the planner would
      // refuse (same single-key provider cooling took the fallback down with
      // it, 2026-10-30 `261029-quiet-jasmine`).
      const pool = this.pools.get(unit.provider.id)
      if (!pool) return true
      return pool.snapshot(unit.upstreamModel).some((k) => k.available)
    })
  }

  status(): LlmGatewayStatus {
    const config = this.getConfig();
    return {
      running: this.httpServer !== null,
      port: this._port,
      baseUrl: this.baseUrl,
      generation: this.generation,
      strategies: config.strategies.map((s) => {
        // `modelAliases` is the strategy's own public model list and is what
        // the session actually routes with (see applyGatewayStrategy). Only
        // fall back to the members' provider mappings when it is absent.
        const aliases = Object.keys(s.modelAliases ?? {})
        const models = new Set<string>(aliases)
        if (aliases.length === 0) {
          for (const member of s.members) {
            const provider = config.providers.find((p) => p.id === member.provider)
            if (!provider || provider.enabled === false) continue
            for (const publicName of Object.values(provider.models ?? {})) models.add(publicName)
          }
        }
        const enabledProviders = s.members.filter((m) => {
          const provider = config.providers.find((p) => p.id === m.provider)
          return Boolean(provider) && provider!.enabled !== false
        }).length
        const enabled = s.enabled !== false
        // Availability is recomputed on every push (2s), so a model whose
        // window has just opened shows up without a config edit. Without this
        // the composer named a model the router was about to skip, and a group
        // with every window closed looked perfectly healthy until the request
        // came back 503 (2026-10-29, `261029-airy-orbit`).
        const publicModels = [...models]
        const windowOpenModels = openStrategyModels(s, publicModels, config.providers, Date.now())
        // A window being open is necessary but not sufficient: the planner
        // also excludes units that are route/endpoint cooling, so the composer
        // must not name a model whose every unit is parked. Without this the
        // label predicted `deepseek-v4.1-flash`, the planner 503'd on the same
        // request, and a fully-cooled group looked healthy and let messages
        // through just to fail (2026-10-30, `261029-quiet-jasmine`).
        const openModels = windowOpenModels.filter((m) => this.hasUncooledUnit(s, m))
        // "No provider" is the more fundamental fault: with every member
        // disabled the model list is empty for a second reason, and saying
        // "未配置模型" would send the user to the wrong screen.
        const reason = enabledProviders === 0
          ? '没有可用的提供商'
          : models.size === 0
            ? '未配置模型'
            : openModels.length === 0
              ? windowOpenModels.length === 0
                ? '当前没有可用模型（时间限制）'
                : '当前没有可用模型（冷却中，稍后自动恢复）'
              : undefined
        return {
          id: s.id,
          type: s.type,
          providers: s.members.length,
          models: publicModels,
          // The models a request made right now could land on, in declared
          // order. Empty while `models` is not means every window is closed.
          openModels,
          // The slug is not a label: `日常主用` normalises to `provider`, and the
          // composer used to show that. Fall back to the id only for strategies
          // written before the name was persisted.
          name: s.name ?? s.id,
          enabled,
          usable: enabled && reason === undefined,
          reason,
        }
      }),
      lastModels: Object.fromEntries(this.lastModels),
      coolingKeys: this.coolingKeyCount(),
      inFlight: this.inFlight,
      keyStates: this.keyStates(),
    };
  }

  /** Usage records accumulated in memory; persisted by the caller. */
  drainUsage(): UsageRecord[] {
    const out = this.usage;
    this.usage = [];
    return out;
  }

  // -------------------------------------------------------------------------
  // Request handling
  // -------------------------------------------------------------------------

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, port: this._port }));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'POST only' } }));
      return;
    }

    if (url.pathname === '/v1/messages' || url.pathname === '/v1/chat/completions') {
      await this.handleMessages(req, res);
      return;
    }

    // Strategy-scoped endpoint: `/s/<strategyId>/v1/...`.
    //
    // A client key alone cannot express "use *this* strategy" when the key is
    // authorized for several of them, so the caller pins it in the path. The
    // server binds to 127.0.0.1, so a request that arrives here without a key
    // is still local; a supplied key must authorize the strategy.
    const scoped = /^\/s\/([^/]+)\/v1\/(messages|chat\/completions)$/.exec(url.pathname);
    if (scoped) {
      await this.handleMessages(req, res, decodeURIComponent(scoped[1] ?? ''));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'not_found_error', message: `unknown path ${url.pathname}` } }));
  }

  private async handleMessages(
    req: IncomingMessage,
    res: ServerResponse,
    strategyHint?: string,
  ): Promise<void> {
    const generation = this.generation;
    const body = await readBody(req, MAX_BODY_BYTES);
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'body is not JSON' } }));
      return;
    }

    const publicModel = typeof payload.model === 'string' ? payload.model : '';
    // The body field is the documented channel; the header is what both
    // backends can actually set (they do not build the body themselves). The
    // gateway needs this to attribute a route change to the right session.
    const sessionId =
      (typeof payload.sessionKey === 'string' && payload.sessionKey ? payload.sessionKey : undefined) ??
      headerValue(req.headers[SESSION_HEADER]);
    // What the request is for (对话 / call_llm / 标题 / 记忆 …), in priority
    // order:
    //
    //   1. the override header — set per call by a subprocess that serves
    //      several kinds from one process (call_llm, the judge, the steer check)
    //   2. the plain header — set once per backend at provider registration,
    //      right for auxiliary backends where the whole process is one kind
    //   3. the body field — for clients we do not control (a curl, a script)
    //
    // The override has to win: the plain header describes the process, and a
    // request made from inside a session would otherwise be indistinguishable
    // from the conversation. All three are stripped before the request goes
    // upstream.
    const requestKind =
      headerValue(req.headers[MODEL_KIND_OVERRIDE_HEADER]) ??
      headerValue(req.headers[MODEL_KIND_HEADER]) ??
      (typeof payload.kind === 'string' && payload.kind ? payload.kind : undefined);
    const config = this.getConfig();

    // Inbound auth: resolve the client key to a strategy. Anthropic clients
    // send it either as x-api-key or as a bearer token.
    const clientKey =
      headerValue(req.headers['x-api-key']) ??
      bearerFrom(req.headers['authorization']) ??
      '';

    let strategy = null as ReturnType<typeof resolveStrategyForClientKey>;
    if (strategyHint) {
      strategy = config.strategies.find((s) => s.id === strategyHint) ?? null;
      if (!strategy) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { type: 'not_found_error', message: `unknown strategy ${strategyHint}` },
          }),
        );
        return;
      }
      if (strategy.enabled === false) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { type: 'not_found_error', message: `strategy ${strategy.id} is disabled` },
          }),
        );
        return;
      }
      // A known key must be allowed to use the strategy it names. Unknown keys
      // are tolerated on loopback (the app's own subprocess sends a local
      // placeholder), which is why this only rejects a *configured* key that
      // does not list the strategy.
      const entry = config.clientKeys.find((c) => c.key === clientKey);
      if (entry && !entry.strategies.includes(strategy.id)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { type: 'authentication_error', message: 'client key is not authorized for this strategy' },
          }),
        );
        return;
      }
    } else {
      strategy = resolveStrategyForClientKey(config, clientKey, publicModel);
    }

    if (!strategy) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ error: { type: 'authentication_error', message: 'invalid client key' } }),
      );
      return;
    }

    this.inFlight += 1;
    const streamRetryState = sessionId && payload.stream === true && (!requestKind || requestKind === 'chat')
      ? this.streamRetryStates.getOrCreate(sessionId, gatewayRequestFingerprint(payload), strategy.id)
      : undefined;
    try {
      // Fallback chain: try the resolved strategy, then its `fallbackStrategyId`,
      // then that one's, and so on. `visited` catches a cycle (p1→p2→p1) so a
      // loop never spins forever — revisiting a strategy already in the chain
      // is a terminal error.
      const visited = new Set<string>();
      let current: LlmStrategy | null = strategy;
      // Failure classes seen across the whole chain. The client status is
      // derived from them below: a balance wall (402) must not read as a rate
      // limit (429), and a model that no unit can serve (503) must not read as
      // a bad gateway (502).
      let rateLimited = false;
      let quotaExhausted = false;
      let requestRejected = false;
      let routeFailed = false;
      let tprRejected = false;
      let retryAfterSeconds = 0;
      // One row per exhausted strategy. Written *after* the status is decided,
      // so the 状态码 column always matches what the client was told.
      const exhaustedRows: UsageRecord[] = [];
      // The last thing that went wrong, so the final status can say "no healthy
      // account" (503) instead of pretending the upstreams failed (502).
      let lastOutcome: 'plan_failed' | 'exhausted' | null = null;

      while (current && !visited.has(current.id)) {
        visited.add(current.id);

        // Exclude units whose keys are all cooling / rate-limited, or whose
        // route/endpoint is cooling, so the planner never picks a unit that
        // cannot serve the request. When that leaves nothing, the planner
        // throws and we fall through below.
        const availability = await this.unavailableUnitsFor(current, publicModel);

        let plan: ReturnType<typeof planRequest>;
        try {
          plan = planRequest({
            config,
            strategy: current,
            publicModel,
            unavailableUnits: availability.excluded,
          });
        } catch (err) {
          this.log(`planning failed for ${current.id}: ${describeError(err)}`);
          this.recordUsage({
            // Nothing was dispatched, so this row is where the request started
            // and ended at the same instant. `startedAt` is still set: the log
            // reads one column and must not have to special-case "no timing".
            ts: Date.now(),
            startedAt: Date.now(),
            strategy: current.id,
            provider: '',
            keyId: '',
            publicModel,
            upstreamModel: '',
            status: 'no_healthy_account',
            ...(requestKind ? { kind: requestKind } : {}),
            statusCode: 503,
            attempts: 0,
            error: describeError(err),
            sessionId,
            totalMs: 0,
          });
          lastOutcome = 'plan_failed';
          // Nothing was dispatched and every member was excluded only because
          // its keys are rate-limited or busy. That is a limit wall, not an
          // unhealthy account: answer 429 + Retry-After (handled below) so the
          // client backs off for the real time instead of reading a 503 as an
          // outage. Cooling-only exclusions keep the 503.
          if (availability.allLimited) {
            rateLimited = true;
            retryAfterSeconds = Math.max(retryAfterSeconds, availability.retryAfterSeconds);
          }
          current = this.resolveFallback(config, current.id);
          continue;
        }

        const outcome = await this.execute(plan, payload, res, generation, requestKind, sessionId, streamRetryState, config);
        if (outcome.kind === 'success') {
          if (!outcome.truncated || !outcome.retryable) {
            if (streamRetryState && sessionId) {
              this.streamRetryStates.delete(sessionId, gatewayRequestFingerprint(payload), strategy.id);
            }
          }
          return;
        }
        if (outcome.kind === 'reloaded') {
          // Config reloaded mid-flight: the caller retries against the new plan.
          this.recordUsage({ ...outcome.row, statusCode: 503 });
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ error: { type: 'overloaded_error', message: 'gateway reloaded, retry' } }),
          );
          return;
        }
        exhaustedRows.push(outcome.row);
        rateLimited = rateLimited || outcome.rateLimited;
        quotaExhausted = quotaExhausted || outcome.quotaExhausted;
        requestRejected = requestRejected || outcome.requestError;
        routeFailed = routeFailed || outcome.routeFailure;
        tprRejected = tprRejected || outcome.tprRejected;
        retryAfterSeconds = Math.max(retryAfterSeconds, outcome.retryAfterSeconds);
        lastOutcome = 'exhausted';
        // Exhausted — transfer to the fallback strategy, if one is configured.
        current = this.resolveFallback(config, current.id);
      }

      if (streamRetryState && sessionId) {
        this.streamRetryStates.delete(sessionId, gatewayRequestFingerprint(payload), strategy.id);
      }

      // Every strategy in the chain is exhausted (or a cycle was detected).
      // A limit wall is a 429 with the soonest cooldown as Retry-After; anything
      // else is the generic 502. Either way the client is told when to come back
      // instead of retrying into the same cooling keys.
      //
      // The status is decided here and only here, then stamped onto the rows:
      // the log must say what the client got, not a constant.
      //
      // Precedence follows what the operator can act on: a malformed request is
      // the client's fault, an empty balance is the account's, a rate wall is
      // temporary, a route with no usable unit is configuration, and only an
      // unclassified upstream failure is a gateway error.
      const clientStatus =
        requestRejected ? 400
          : tprRejected ? 400
            : quotaExhausted ? 402
              : rateLimited ? 429
                : lastOutcome === 'plan_failed' ? 503
                  : routeFailed ? 503
                    : 502;
      for (const row of exhaustedRows) this.recordUsage({ ...row, statusCode: clientStatus });

      // Respond with the same status that was stamped onto the rows. Keeping a
      // separate if/else chain here is how the log and the client drifted apart
      // before (502 in the log, 429 to the client, 2026-10-25).
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (clientStatus === 429 && retryAfterSeconds > 0) {
        headers['retry-after'] = String(retryAfterSeconds);
      }
      res.writeHead(clientStatus, headers);
      res.end(
        JSON.stringify({
          error: clientErrorFor(clientStatus, { tprRejected }),
        }),
      );
    } finally {
      this.inFlight -= 1;
    }
  }

  /**
   * Run the retry ladder across the planned providers.
   *
   * Streaming responses are piped through as they arrive. A mid-stream cut
   * cannot be retried inside this HTTP response after bytes are committed, so
   * Craft chat streams carry a retry marker and resume the same model step in a
   * new request; the strategy's per-key budget is retained across requests.
   */
  private async execute(
    plan: ReturnType<typeof planRequest>,
    payload: Record<string, unknown>,
    res: ServerResponse,
    generation: number,
    /** What the request was for; stored on the usage row. */
    requestKind?: string,
    /** Craft session id (body or header); absent for external/auxiliary callers. */
    sessionId?: string,
    streamRetryState?: GatewayStreamRetryState,
    config: LlmConfig = this.getConfig(),
  ): Promise<
    | { kind: 'success'; truncated?: boolean; retryable?: boolean; retryMarker?: string }
    | { kind: 'reloaded'; row: UsageRecord }
    | {
      kind: 'exhausted';
      /** At least one unit hit a 429 / busy key. */
      rateLimited: boolean;
      /** At least one unit hit a balance/quota wall (402 or a quota body). */
      quotaExhausted: boolean;
      /** The request itself was invalid; other units cannot fix it. */
      requestError: boolean;
      /** Every attempt died on a route/transport problem (no healthy account). */
      routeFailure: boolean;
      tprRejected: boolean;
      retryAfterSeconds: number;
      row: UsageRecord;
    }
  > {
    // Anchored before any upstream call, so firstByteMs measures the upstream
    // rather than time already spent parsing and planning.
    const requestStartedAt = Date.now();
    // Stage offsets in ms from requestStartedAt. A stage that never ran is
    // simply absent — the detail view renders the sequence that happened rather
    // than assuming every request walks the whole pipeline.
    const stageMs: Record<string, number> = { provider_selected: 0 };
    const markStage = (stage: string): void => {
      if (stageMs[stage] === undefined) stageMs[stage] = Date.now() - requestStartedAt;
    };
    // Same-key transient retry budget, from the strategy's "失败重试上限".
    const maxAttempts = plan.retry.maxAttempts;
    let attempt = 0;
    let logicalAttempt = streamRetryState?.totalAttempts ?? 0;
    let lastError = '';
    // Where the last attempt was aimed, so the failure row names a provider and
    // a key instead of leaving both columns empty.
    let lastProvider = '';
    let lastKeyId = '';
    let lastUpstreamModel = '';
    let lastUnitId = '';
    // The model the last attempt actually asked the upstream for (the unit's
    // public model), which differs from the client's request on a fallback.
    let lastPublicModel = '';
    // Reservation sent against TPM/TPD. Estimated before dispatch, reconciled
    // with the real usage once a response lands.
    const estimatedTokens = estimateRequestTokens(payload);
    // Failure classes, so the caller can answer 402 for an empty balance and
    // 429 only for a genuine rate wall instead of collapsing both into one.
    let rateLimited = false;
    let quotaExhausted = false;
    let requestError = false;
    let routeFailure = false;
    // The request is larger than every key's TPR ceiling: a client error, not
    // a retryable upstream failure.
    let tprRejected = false;

    /**
     * The attempt we just gave up on, written to the log when the next one
     * starts.
     *
     * A request that timed out on provider A and then died on B produced ONE
     * row — B's — so A's 60s first-byte timeout left no trace anywhere but the
     * trace offsets of a row attributed to another provider. Every attempt now
     * gets its own row. The final attempt is deliberately *not* flushed here:
     * it becomes the request's own row below, which is what keeps "one request,
     * one outcome" true for the aggregates.
     */
    let pendingAttempt: PendingAttempt | null = null;
    // Read through a function: TypeScript's flow analysis would otherwise pin
    // `pendingAttempt` to the `null` it was initialised with, since every write
    // happens inside a nested callback.
    const takePendingAttempt = (): PendingAttempt | null => {
      const failed = pendingAttempt;
      pendingAttempt = null;
      return failed;
    };
    const flushPendingAttempt = (): void => {
      const failed = takePendingAttempt();
      if (!failed) return;
      this.recordUsage({
        ts: Date.now(),
        startedAt: requestStartedAt,
        strategy: plan.strategyId,
        // Every attempt names the route it failed on, not just the last one: a
        // multi-unit plan is the normal case now, and the unit column is how an
        // operator tells "same provider, next model" from "same model, next key".
        unitId: failed.unitId,
        provider: failed.provider,
        keyId: failed.keyId,
        // The route that failed, which on a fallback is a different model than
        // the one the client named. Naming only the client's model here made
        // the log disagree with the unit column about what was attempted.
        publicModel: failed.publicModel,
        upstreamModel: failed.upstreamModel,
        ...(requestKind ? { kind: requestKind } : {}),
        status: 'error',
        statusCode: failed.statusCode,
        attempts: failed.attemptNumber ?? attempt,
        error: failed.error,
        sessionId,
        totalMs: Date.now() - requestStartedAt,
        ...(failed.firstByteMs != null ? { firstByteMs: failed.firstByteMs } : {}),
        superseded: true,
        trace: TRACE_STAGE_ORDER.filter((stage) => stageMs[stage] !== undefined).map(
          (stage) => `${stage}@${Math.round(stageMs[stage]!)}`,
        ),
      });
    };

    // Strategy-level policy, with the shipped defaults for anything unset.
    const policy: Required<LlmSwitchPolicy> = {
      ...DEFAULT_SWITCH_POLICY,
      ...(plan.strategy.switchPolicy ?? {}),
    };
    const switchAction = (failure: LlmSwitchFailure): LlmSwitchAction => policy[failure];

    // One pass per switching unit. A unit is a (provider, model) route: the
    // key ladder runs inside it, and only when it is spent does the request
    // move to the next model/provider the strategy declares.
    units: for (const unit of plan.units) {
      const provider = unit.provider;
      // A second-or-later unit in this request is a switch, which is the only
      // place that stage can be observed.
      if (attempt > 0) markStage('retry_provider');
      // Both protocol families are supported: `anthropic-messages` is passed
      // through verbatim, `openai-completions` is transcoded in callUpstream /
      // pipeResponse. Anything else is a genuine gap worth failing on loudly.
      if (
        provider.protocol !== 'anthropic-messages' &&
        provider.protocol !== 'openai-completions'
      ) {
        lastError = `provider ${provider.id} protocol ${provider.protocol} is not supported`;
        this.log(lastError);
        continue;
      }

      const pool = this.pools.get(provider.id);
      if (!pool) {
        lastError = `provider ${provider.id} has no pool`;
        this.log(lastError);
        continue;
      }
      // Sticky scope is part of the unit: the same provider serving two models
      // must not hand a session's model-A key to model B, whose rate-limit
      // windows are separate.
      const sessionKey = sessionId
        ? plan.stickyScope === 'session+model'
          ? `${sessionId}::${unit.id}`
          : `${sessionId}::${provider.id}`
        : undefined;
      const upstreamModel = unit.upstreamModel;

      /**
       * Record how this attempt is about to die, so the moment the ladder moves
       * on the row can be written with the provider/key that actually failed —
       * not with whichever provider the request eventually gave up on.
       */
      const failAttempt = (statusCode: number, error: string, firstByteMs?: number): void => {
        pendingAttempt = {
          unitId: unit.id,
          provider: provider.id,
          keyId: selection.keyId,
          publicModel: unit.publicModel,
          upstreamModel,
          statusCode,
          error,
          ...(firstByteMs != null ? { firstByteMs } : {}),
          attemptNumber: logicalAttempt,
        };
      };

      // Keys of this provider one request may try. A key is its own account, so
      // a *per-key* failure (rate limit, quota, a revoked key) is worth another
      // key of the same provider — without it one bad key ended the turn while
      // the provider's other keys sat idle. Endpoint-level failures (transport,
      // first byte) do not rotate: see `leaveProvider`.
      const enabledKeys = provider.keys.filter((k) => k.enabled !== false).length;
      const keyBudget = Math.min(Math.max(1, enabledKeys), MAX_KEY_TRIES_PER_PROVIDER);
      let keyTries = 0;
      let keyAttempts = 0;
      // Placeholder until the first successful `pickKey()`; every read of it
      // below happens after that, and `pooled: false` keeps the placeholder
      // inert for release/cool if it ever were not.
      let selection: {
        keyId: string;
        pooled: boolean;
        reservation?: WindowEntry;
      } = { keyId: '', pooled: false };

      /**
       * Take this provider's next usable key (skipping cooling / rate-limited
       * ones). Returns false when the provider has nothing left to offer.
       * Keyless providers have a synthetic `''` key in their pool (see rebuild),
       * so this path is uniform — no special case.
       */
      const pickKey = async (): Promise<boolean> => {
        try {
          const picked = await pool.next(upstreamModel, sessionKey, estimatedTokens);
          selection = { keyId: picked.keyId, pooled: true, reservation: picked.reservation };
          keyTries += 1;
          keyAttempts = 0;
          return true;
        } catch (err) {
          const reason = err instanceof AllKeysUnavailableError ? err.reason : 'cooling';
          lastError = `all keys on provider ${provider.id} are unavailable (${reason})`;
          this.log(lastError);
          if (reason === 'cooling') rateLimited = true;
          if (reason === 'tpr') tprRejected = true;
          return false;
        }
      };

      if (!(await pickKey())) continue;

      const releaseKey = (): void => {
        if (selection.pooled) pool.finishRequest(selection.keyId);
      };
      const coolKey = async (kind: 'default' | 'rate_limit' | 'quota', signal?: RateLimitSignal): Promise<number> => {
        if (!selection.pooled) return 0;
        // A keyless provider has one synthetic `''` key shared by every model
        // on the relay. A 429 for one model must cool that model's *route*,
        // not the shared key — cooling the key would take the whole relay down
        // and defeat the model-level switch (deepseek → hy4, 2026-10-29).
        if (kind === 'rate_limit' && selection.keyId === '') {
          const seconds = await pool.rateLimitSeconds('', signal);
          this.coolUnit(unit.id, seconds);
          return seconds;
        }
        const seconds = kind === 'rate_limit'
          ? await pool.setRateLimited(selection.keyId, signal)
          : await pool.setCooling(selection.keyId, kind);
        this.persistCooldowns();
        return seconds;
      };

      /**
       * Cool the key that just failed and hand back the provider's next one.
       * False means "this provider is done; try the next one".
       *
       * For per-key failures only: a 429 / quota / deterministic status belongs
       * to the account, so another key of the same provider is a genuinely
       * different quota and the cheapest thing to try next.
       */
      const rotateKey = async (
        kind: 'default' | 'rate_limit' | 'quota',
        signal?: RateLimitSignal,
      ): Promise<boolean> => {
        await coolKey(kind, signal);
        releaseKey();
        return keyTries < keyBudget && (await pickKey());
      };

      // Same-key retry: a transient failure retries THIS key up to
      // `maxAttempts`; when the key is done it is cooled and the next key of the
      // provider is tried, then the next provider.
      // Rate-limit / quota / deterministic failures cool + rotate immediately.
      for (;;) {
        // Leaving an attempt behind: give it its own row before the next one
        // starts. Runs on the same-key retry, the key rotation and the
        // cross-provider hop alike — every one of them is a separate upstream
        // request and must be readable as such.
        flushPendingAttempt();
        attempt += 1;
        logicalAttempt = streamRetryState ? ++streamRetryState.totalAttempts : attempt;
        keyAttempts += 1;
        // Stamp the target before the call so the failure row can name it even
        // when the attempt itself throws.
        lastProvider = provider.id;
        lastUnitId = unit.id;
        lastPublicModel = unit.publicModel;
        lastKeyId = selection.keyId;
        lastUpstreamModel = upstreamModel;

        let call: UpstreamCall;
        try {
          call = await this.callUpstream(provider, selection.keyId, upstreamModel, payload);
        } catch (err) {
          lastError = `upstream ${provider.id} transport error: ${describeError(err)}`;
          this.log(lastError);
          // No HTTP response at all: 0 renders as "—" rather than as a status.
          failAttempt(0, lastError);
          routeFailure = true;
          // Connection-level: the endpoint is unreachable, not the account, so
          // another key of the same baseUrl pays the same cost. Cool the
          // route and move to the next unit (2026-10-25 first-byte incident).
          if (switchAction('transport') === 'retry-same' && keyAttempts < maxAttempts) {
            releaseKey();
            if (plan.retry.backoffMs > 0) await sleep(plan.retry.backoffMs);
            continue;
          }
          markStage('cooldown_provider');
          this.coolRouteAfterTransport(unit.id, provider, selection.keyId);
          releaseKey();
          break;
        }

        const response = call.response;
        const firstByteMs = call.firstByteRemainingMs;
        // Keep the total timer alive through the body read; `finally` releases
        // it on every exit (success, retry, cooldown).
        try {

        const timing = {
          usage: {} as MutableUsage,
          startedAt: requestStartedAt,
          firstByteMs: undefined as number | undefined,
          totalMs: undefined as number | undefined,
        };

        if (response.status === 200) {
          // "The model this strategy is on" is only knowable after a request
          // lands, because the alias map is resolved per provider.
          this.lastModels.set(plan.strategyId, upstreamModel);
          const outcome = await this.pipeResponse(response, res, timing, {
            provider,
            upstreamModel,
            publicModel: String(payload.model ?? ''),
            // Derived from stable inputs rather than random: the same retry
            // should produce a comparable id, which makes trace correlation
            // possible across attempts.
            messageId: `msg_${stableHash(`${provider.id}:${selection.keyId}:${requestStartedAt}`)}`,
            // Anthropic clients send `stream: true`; the SDK's retry probes do
            // not, and the response shape has to match what was asked for.
            stream: payload.stream === true,
          }, {
            firstByteMs,
            abort: call.abort,
            onTruncated: streamRetryState
              ? async () => this.onStreamTruncated({
                  config,
                  strategy: plan.strategy,
                  publicModel: String(payload.model ?? ''),
                  unitId: unit.id,
                  keyId: selection.keyId,
                  maxAttempts,
                  state: streamRetryState,
                  coolKey,
                })
              : undefined,
          });
          if (outcome?.firstByteTimeout) {
            // Nothing was written to the client yet, so another provider (or a
            // retry of this key) can still serve the turn.
            lastError = `upstream ${provider.id} first byte timeout (${firstByteMs}ms)`;
            this.log(lastError);
            // The endpoint answered the connection and then went silent, so
            // there is no HTTP status to record — the timeout itself is.
            failAttempt(0, lastError, firstByteMs);
            routeFailure = true;
            if (switchAction('transport') === 'retry-same' && keyAttempts < maxAttempts) {
              releaseKey();
              if (plan.retry.backoffMs > 0) await sleep(plan.retry.backoffMs);
              continue;
            }
            markStage('cooldown_provider');
            // The relay was too slow to answer at all: the provider's other
            // keys share that latency, so go to the next unit instead of paying
            // the same budget again per key.
            this.coolRouteAfterTransport(unit.id, provider, selection.keyId);
            releaseKey();
            break;
          }
          // Replace the pre-dispatch estimate with the measured usage so the
          // token window reflects reality, then reset the 429 ladder.
          const actualTokens = (timing.usage.promptTokens ?? 0) + (timing.usage.completionTokens ?? 0);
          if (selection.reservation && actualTokens > 0) {
            pool.reconcileTokens(selection.reservation, actualTokens);
          }
          pool.noteSuccess(selection.keyId);
          this.recordUsage({
            ts: Date.now(),
            startedAt: requestStartedAt,
            strategy: plan.strategyId,
            unitId: unit.id,
            provider: provider.id,
            keyId: selection.keyId,
            // The model this route served. A fallback names itself, so the log's
            // model, unit and upstream columns agree with each other.
            publicModel: unit.publicModel,
            upstreamModel,
            ...(requestKind ? { kind: requestKind } : {}),
            // A stream that ends without a finish_reason is a failed attempt
            // even though the HTTP status was 200. It remains visible in usage
            // records even when a client retry supersedes it.
            status: outcome?.truncated ? 'error' : 'success',
            statusCode: 200,
            ...(outcome?.truncated ? { error: 'upstream stream ended without a finish_reason' } : {}),
            attempts: logicalAttempt,
            sessionId,
            retried: logicalAttempt > 1,
            ...(outcome?.retryMarker === GATEWAY_STREAM_TRUNCATION_RETRY_MARKER ? { superseded: true } : {}),
            promptTokens: timing.usage.promptTokens,
            completionTokens: timing.usage.completionTokens,
            cachedTokens: timing.usage.cachedTokens,
            firstByteMs: timing.firstByteMs,
            totalMs: timing.totalMs,
            // The two upstream stages carry real measurements: first chunk is
            // firstByteMs, stream end is the total. The rest are decision
            // points with no upstream wait, recorded as their offset.
            trace: buildTraceStages(stageMs, timing.firstByteMs, timing.totalMs),
          });
          // Only the conversation owns "this session's key/model" state.
          // Auxiliary calls (title, judge, call_llm) may route through a
          // different group; letting them update the route would attribute
          // their switches to the conversation and trigger pointless work.
          if (!requestKind || requestKind === 'chat') {
            this.noteRoute(plan, unit, selection.keyId, sessionId, outcome?.truncated === true);
          }
          releaseKey();
          return {
            kind: 'success',
            ...(outcome?.truncated ? { truncated: true } : {}),
            ...(outcome?.retryMarker ? { retryMarker: outcome.retryMarker } : {}),
            ...(outcome?.retryMarker === GATEWAY_STREAM_TRUNCATION_RETRY_MARKER ? { retryable: true } : {}),
          };
        }

        // Classify the non-200 failure. Status code first; the body is consulted
        // only where the code is ambiguous, and its digest is kept so the log
        // stops saying just "returned 404" with no trace of what the relay said.
        const code = response.status;
        let errorBody = '';
        try {
          errorBody = await response.text();
        } catch {
          // Body read failure — classify by status code alone.
        }
        const failure = classifyUpstreamFailure(code, errorBody);
        lastError = describeUpstreamFailure(provider.id, code, errorBody, failure.kind);
        this.log(lastError);
        failAttempt(code, lastError);

        if (failure.kind === 'rate_limit') {
          rateLimited = true;
          markStage('cooldown_provider');
          const signal = parseRateLimitSignal(response.headers, errorBody);
          const action = switchAction('rate_limit');
          if (action === 'stop') break units;
          if (action === 'next-unit') {
            await coolKey('rate_limit', signal);
            releaseKey();
            break;
          }
          if (action === 'retry-same' && keyAttempts < maxAttempts) {
            releaseKey();
            if (plan.retry.backoffMs > 0) await sleep(plan.retry.backoffMs);
            continue;
          }
          if (!(await rotateKey('rate_limit', signal))) break;
          continue;
        }

        if (failure.kind === 'quota') {
          // A balance wall is the account's, not the endpoint's: another key is
          // a different account and worth trying, but the client must be told
          // 402 rather than a rate limit.
          quotaExhausted = true;
          markStage('cooldown_provider');
          const action = switchAction('quota');
          if (action === 'stop') break units;
          if (action === 'next-unit') {
            await coolKey('quota');
            releaseKey();
            break;
          }
          if (action === 'retry-same' && keyAttempts < maxAttempts) {
            releaseKey();
            if (plan.retry.backoffMs > 0) await sleep(plan.retry.backoffMs);
            continue;
          }
          if (!(await rotateKey('quota'))) break;
          continue;
        }

        if (failure.kind === 'auth') {
          markStage('cooldown_provider');
          const action = switchAction('auth');
          if (action === 'stop') break units;
          if (action === 'next-unit') {
            await coolKey('quota');
            releaseKey();
            break;
          }
          // A revoked/forbidden key stays that way for a while; cooling it as a
          // quota failure keeps it out of the rotation without hiding the model.
          if (!(await rotateKey('quota'))) break;
          continue;
        }

        if (failure.kind === 'model_not_found') {
          // Cooling the *route* is the whole point: the key is fine, the model
          // is not. Cooling the key would take every other model of the same
          // account down with it (261027-long-bronze).
          routeFailure = true;
          markStage('cooldown_provider');
          const action = switchAction('model_not_found');
          if (action === 'stop') break units;
          this.coolUnit(unit.id, this.routeCooldownSeconds(provider, selection.keyId));
          releaseKey();
          break;
        }

        if (failure.kind === 'request') {
          // The request itself is unacceptable; another unit will reject it too.
          requestError = true;
          releaseKey();
          break units;
        }

        // 5xx / timeout-ish: retry the same key while the budget allows, then
        // rotate the account as a last resort before leaving the unit.
        const action = switchAction('server_error');
        if (action === 'stop') break units;
        if (action === 'next-unit') {
          markStage('cooldown_provider');
          await coolKey('default');
          releaseKey();
          break;
        }
        if (!plan.retry.onStatusCodes.includes(code) || keyAttempts >= maxAttempts) {
          markStage('cooldown_provider');
          if (!(await rotateKey('default'))) break;
          continue;
        }
        releaseKey();
        if (plan.retry.backoffMs > 0) await sleep(plan.retry.backoffMs);
        continue;
        } finally {
          call.settle();
        }
      }
      // Provider exhausted (cooled + switched); continue to the next provider.
    }

    // The request's own row — built here, *written by the caller* once the
    // status the client will actually see is known.
    //
    // It used to be written here with a hardcoded 502, while the 429/400/503
    // decision lived in `handleMessages`. A request whose keys all ended up
    // cooling was answered 429 to the client but logged as 502, so the one
    // place an operator looks said "bad gateway" for a rate wall
    // (2026-10-25 22:18, reported as "log says 502 but the session says 429").
    const lastAttempt = takePendingAttempt();
    const row: UsageRecord = {
      ts: Date.now(),
      startedAt: requestStartedAt,
      strategy: plan.strategyId,
      unitId: lastUnitId,
      // The account the request actually died on. Empty only when nothing was
      // ever dispatched (every provider excluded), which is the "no provider"
      // case the log must keep showing as "—" — a request that reached an
      // upstream always belongs to a provider and a key.
      provider: lastProvider,
      keyId: lastKeyId,
      publicModel: lastPublicModel || String(payload.model ?? ''),
      upstreamModel: lastUpstreamModel,
      ...(requestKind ? { kind: requestKind } : {}),
      status: 'error',
      statusCode: 0, // filled in by the caller; 0 renders as "—"
      attempts: attempt,
      error: lastError,
      sessionId,
      // Total time the client waited for this request (not just the last hop):
      // that is the number the 耗时 column is read for.
      totalMs: Date.now() - requestStartedAt,
      ...(lastAttempt?.firstByteMs != null ? { firstByteMs: lastAttempt.firstByteMs } : {}),
      // A failed request still walked real stages; the timeline is most useful
      // here, since it shows how far it got and where it stopped.
      trace: TRACE_STAGE_ORDER.filter((stage) => stageMs[stage] !== undefined).map(
        (stage) => `${stage}@${Math.round(stageMs[stage]!)}`,
      ),
    };

    if (generation !== this.generation) return { kind: 'reloaded', row };
    return {
      kind: 'exhausted',
      rateLimited,
      quotaExhausted,
      requestError,
      routeFailure,
      tprRejected,
      retryAfterSeconds: this.minRemainingCooldown(),
      row,
    };
  }

  /** Soonest key cooldown across every pool, for a `Retry-After` header. */
  private minRemainingCooldown(): number {
    let min = Number.POSITIVE_INFINITY;
    for (const pool of this.pools.values()) {
      for (const entry of pool.snapshot()) {
        if (entry.cooldownRemaining > 0) min = Math.min(min, entry.cooldownRemaining);
      }
    }
    const now = Date.now() / 1000;
    for (const until of this.unitCooling.values()) {
      const remaining = until - now;
      if (remaining > 0) min = Math.min(min, remaining);
    }
    for (const until of this.endpointCooling.values()) {
      const remaining = until - now;
      if (remaining > 0) min = Math.min(min, remaining);
    }
    return Number.isFinite(min) ? Math.ceil(min) : 0;
  }

  /**
   * Record the route a successful request used and report a switch.
   *
   * Compaction is deliberately not performed here: the response has been
   * piped, but the agent may still be finishing its turn, and rewriting the
   * context under an active stream is unsafe. The callback only reports the
   * change; the session layer waits for idle and calls the existing compact
   * path.
   */
  private noteRoute(
    plan: Plan,
    unit: PlannedUnit,
    keyId: string,
    sessionId: string | undefined,
    truncated: boolean,
  ): void {
    if (!sessionId || truncated) return;
    const previous = this.sessionRoutes.get(sessionId);
    const next: SessionRoute = {
      strategyId: plan.strategyId,
      unitId: unit.id,
      providerId: unit.provider.id,
      keyId,
      upstreamModel: unit.upstreamModel,
    };
    // Always record the route (even when the flag is off) so re-enabling the
    // option does not compare against a stale route from hours ago.
    this.sessionRoutes.set(sessionId, next);
    if (!previous || plan.strategy.compactAfterSwitch === false) return;

    const keyChanged = previous.keyId !== next.keyId || previous.providerId !== next.providerId;
    // A model-level switch is exactly what the unit represents now: the public
    // model the client asked for can stay the same while the upstream model
    // changes, and that still costs the prompt cache.
    const modelChanged =
      previous.unitId !== next.unitId ||
      previous.upstreamModel !== next.upstreamModel ||
      previous.strategyId !== next.strategyId;
    if (!keyChanged && !modelChanged) return;

    const reason: LlmRouteChange['reason'] =
      keyChanged && modelChanged ? 'both' : keyChanged ? 'key' : 'model';
    try {
      this.onRouteChanged?.({ sessionId, ...next, publicModel: unit.publicModel, previous, reason });
    } catch (err) {
      // The upstream request already succeeded; a listener failure must not
      // turn it into a client-visible error.
      this.log(`route-change listener failed: ${describeError(err)}`);
    }
  }

  /**
   * The levels this model accepts per the user's own `reasoningEfforts`
   * declaration, or `undefined` when none was made.
   *
   * This is only the first source. The full ladder — declaration first, then
   * the upstream's discovered `GET /models` catalog — is assembled in
   * `knownEfforts`, which `callUpstream` actually consumes.
   */
  private declaredEfforts(
    provider: LlmProvider,
    publicModel: string,
    upstreamModel: string,
  ): string[] | undefined {
    const list =
      provider.modelOptions?.[publicModel]?.reasoningEfforts
      ?? provider.modelOptions?.[upstreamModel]?.reasoningEfforts;
    const cleaned = (list ?? [])
      .map((entry) => String(entry).trim().toLowerCase())
      .filter(Boolean);
    return cleaned.length ? cleaned : undefined;
  }

  /**
   * Fetch the upstream's `GET /models` catalog and extract each model's
   * `reasoning_efforts` ladder, cached for `CATALOG_TTL_MS`.
   *
   * A relay that silently falls back to its own default when handed an
   * unsupported level (200, no rejection) defeats the step-down ladder:
   * `callUpstream` never sees a refusal, so the requested level is quietly
   * replaced by the upstream's default. The catalog is the one place that says
   * what the model will actually honour, so it is consulted and clamped into
   * before the request goes out (see `knownEfforts`).
   *
   * Best-effort: a bad URL, an auth failure, a timeout, or a body with no
   * usable ladders all return `undefined`, and the caller falls back to
   * sending the session's level as-is.
   */
  private async fetchEffortsCatalog(provider: LlmProvider): Promise<Map<string, string[]> | undefined> {
    const cached = this.effortsCatalog.get(provider.id);
    if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.byModel;

    const endpoint = modelsEndpointFor(provider.baseUrl);
    if (!endpoint) return undefined;

    const key = provider.keys.find((k) => k.enabled !== false)?.key;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(endpoint, {
        headers: key
          ? { authorization: `Bearer ${key}`, accept: 'application/json' }
          : { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) return undefined;
      const body: unknown = await res.json().catch(() => undefined);
      if (body == null) return undefined;
      const byModel = parseEffortsCatalog(body);
      if (byModel.size === 0) return undefined;
      this.effortsCatalog.set(provider.id, { at: Date.now(), byModel });
      return byModel;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The ladder `effortCandidates` should clamp into: the user's own
   * declaration first, then the upstream's discovered catalog.
   *
   * A declared ladder always wins — it is the only thing that can name a level
   * a relay accepts but does not advertise — and the catalog fills the gap when
   * nothing was declared, which is how 「最大」 reaches a model whose top level
   * is `xhigh` without anyone hand-maintaining `reasoningEfforts` in config.
   */
  private async knownEfforts(
    provider: LlmProvider,
    publicModel: string,
    upstreamModel: string,
  ): Promise<string[] | undefined> {
    const declared = this.declaredEfforts(provider, publicModel, upstreamModel);
    if (declared) return declared;
    const catalog = await this.fetchEffortsCatalog(provider);
    if (!catalog) return undefined;
    const ladder = catalog.get(publicModel) ?? catalog.get(upstreamModel);
    return ladder && ladder.length ? ladder : undefined;
  }

  /** `provider::model` — one route's learned effort state. */
  private effortKey(provider: LlmProvider, upstreamModel: string): string {
    return `${provider.id}::${upstreamModel}`;
  }

  /**
   * The body an `anthropic-messages` upstream receives.
   *
   * Those relays were only ever sent a budget-based `thinking` block, so an
   * adaptive request (the shape the SDK uses to preserve `max`) is translated
   * back into a budget and `output_config` is dropped: a relay that does not
   * understand adaptive thinking would reject the request outright, and losing
   * a little precision beats losing the turn.
   */
  private anthropicBodyWithEffort(
    payload: Record<string, unknown>,
    upstreamModel: string,
    effort: string | undefined,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = { ...payload, model: upstreamModel };
    if (!effort) return body;
    const translated = thinkingForEffort(effort);
    if (translated) body.thinking = translated;
    delete body.output_config;
    return body;
  }

  private async callUpstream(
    provider: LlmProvider,
    keyId: string,
    upstreamModel: string,
    payload: Record<string, unknown>,
  ): Promise<UpstreamCall> {
    // `''` is the synthetic key for a keyless provider (a local relay with no
    // credentials). It still has a pool entry for cooldown/in-flight tracking,
    // but no credential is attached to the request.
    const rawKey = keyId ? provider.keys.find((k) => k.id === keyId)?.key : undefined;
    if (keyId && !rawKey) {
      throw new Error(`no key material for keyId ${keyId}`);
    }

    const isOpenAI = provider.protocol === 'openai-completions';

    const headers: Record<string, string> = isOpenAI
      ? rawKey
        ? openAIHeaders(rawKey)
        : { 'content-type': 'application/json' }
      : {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...(rawKey ? { 'x-api-key': rawKey } : {}),
        };

    // The client's body is Anthropic-shaped. An Anthropic upstream takes it
    // verbatim (with the model swapped); an OpenAI upstream needs it transcoded
    // first, including its own auth header shape. The image cap comes from the
    // key's effective preset so a provider can raise or lower it per key.
    const preset = presetFor(this.getConfig(), provider, keyId);
    // The session's thinking level arrives as an Anthropic `thinking` block (or
    // `output_config.effort` when the SDK takes the adaptive path). OpenAI
    // upstreams only understand `reasoning_effort`, so the level is resolved
    // here, where the model's ladder is in scope.
    const publicModel = String(payload.model ?? '');
    const routeKey = this.effortKey(provider, upstreamModel);
    const options = provider.modelOptions?.[publicModel] ?? provider.modelOptions?.[upstreamModel];
    // No thinking asked for — or a model declared not to reason — means no field.
    const wanted = options?.supportsThinking === false ? undefined : requestedEffort(payload as never);
    // The levels to try, best first. A declared ladder clamps 最大 down to the
    // nearest level it has; an undeclared model gets exactly what the session
    // asked for, and only a refusal moves it down (max → xhigh → high → …).
    // Either way the last candidate omits the field, which no relay rejects.
    // When no level was asked for, skip the ladder lookup (and its `/models`
    // catalog probe): the field stays absent no matter what the model accepts.
    const ladder = wanted
      ? (await this.knownEfforts(provider, publicModel, upstreamModel)) ?? []
      : [];
    const candidates = effortCandidates(
      wanted,
      ladder,
      this.effortCeilings.get(routeKey),
    );

    const buildBody = (level: string | undefined): Record<string, unknown> => {
      const body = isOpenAI
        ? transcodeRequestToOpenAI(payload as never, {
            upstreamModel,
            maxImageParts: preset.maxImageParts ?? DEFAULT_PRESET_MAX_IMAGE_PARTS,
            ...(level ? { reasoningEffort: level } : {}),
          })
        : this.anthropicBodyWithEffort(payload, upstreamModel, level);
      // Only the Anthropic path has a sessionKey to strip; the transcoder already
      // omits unknown fields, which is why this cannot be left to it.
      if (!isOpenAI) {
        delete (body as Record<string, unknown>).sessionKey;
        // Same reason as sessionKey: an upstream would reject an unknown field.
        delete (body as Record<string, unknown>).kind;
      }
      return body as Record<string, unknown>;
    };

    const totalSeconds = preset.totalSeconds ?? DEFAULT_TOTAL_SECONDS;
    const firstByteSeconds = preset.firstByteSeconds ?? DEFAULT_PRESET.firstByteSeconds ?? 0;
    const firstByteMs = Math.max(0, Math.round(firstByteSeconds * 1000));
    // `baseUrl` is what the user typed (a version root, a full chat endpoint, or
    // either with a query). Normalising here — the single outbound call site —
    // means the stored value stays untouched while the request always lands on
    // a real endpoint. Posting it verbatim is what made every workbuddycn
    // request a 404 on the relay's root (261027-long-bronze).
    const endpoint = chatEndpointFor(provider.baseUrl, provider.protocol);

    /** One upstream attempt with its own timers, so a step-down can discard it. */
    const dispatch = async (level: string | undefined): Promise<UpstreamCall> => {
      const controller = new AbortController();
      const totalTimer = setTimeout(() => controller.abort(), totalSeconds * 1000);
      // Headers are the first bytes: an upstream that never answers must not sit
      // on the total timeout alone. The first body chunk is enforced separately
      // in `pipeResponse`, where the stream is actually read.
      const startedAt = Date.now();
      const headerTimer = firstByteMs > 0
        ? setTimeout(() => controller.abort(), firstByteMs)
        : undefined;
      const settle = (): void => {
        clearTimeout(totalTimer);
        if (headerTimer) clearTimeout(headerTimer);
      };
      try {
        const response = await this.fetchImpl(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(buildBody(level)),
          signal: controller.signal,
        });
        // Headers arrived; hand the first body chunk only the time that is left.
        if (headerTimer) clearTimeout(headerTimer);
        const firstByteRemainingMs = firstByteMs > 0
          ? Math.max(1, firstByteMs - (Date.now() - startedAt))
          : 0;
        return { response, firstByteRemainingMs, abort: () => controller.abort(), settle };
      } catch (err) {
        settle();
        throw err;
      }
    };

    for (let i = 0; ; i += 1) {
      const level = candidates[i];
      const call = await dispatch(level);
      const status = call.response.status;
      // A level that worked after a step-down is this route's new ceiling: the
      // next turn starts there instead of paying the same 400 again. Only
      // remembered for stepped-down attempts, so a deliberately low request
      // never lowers what a higher request may use.
      if (i > 0 && status === 200) {
        this.effortCeilings.set(routeKey, level ?? 'none');
        this.log(
          `upstream ${provider.id} accepts reasoning_effort=${level ?? '(none)'}; capping this route at it`,
        );
      }
      const more = i + 1 < candidates.length;
      if (!more) return call;
      if (status !== 400 && status !== 422) return call;
      // A 400 is ambiguous: maybe the effort, maybe the request. Only the body
      // can tell, and it has to be read to find out — so a 400 that turns out to
      // be unrelated is handed back with its body intact for the caller's
      // classifier.
      let text = '';
      try {
        text = await call.response.text();
      } catch {
        return call;
      }
      if (!isEffortRejection(status, text)) {
        return { ...call, response: new Response(text, { status, statusText: call.response.statusText, headers: call.response.headers }) };
      }
      call.settle();
      // Remember the ceiling this rejection implies so the next request starts
      // at the level that works instead of repeating the same 400.
      if (i + 2 >= candidates.length) this.effortCeilings.set(routeKey, 'none');
      this.log(
        `upstream ${provider.id} rejected reasoning_effort=${String(level)}; stepping down to ${String(candidates[i + 1])}`,
      );
    }
  }

/**
   * Token usage scraped from an Anthropic-style SSE stream.
   *
   * Anthropic sends usage on `message_start` (input + cache) and again on
   * `message_delta` (output), so the later value wins for output tokens.
   * OpenAI-shaped upstreams arrive via P5's transcoder, which emits the same
   * event names, so this stays the single place that reads usage.
   */
  private scrapeUsage(text: string, into: MutableUsage): void {
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const raw = trimmed.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // A chunk split across TCP segments is not an error; the next chunk
        // carries the rest of that SSE event's data lines.
        continue;
      }
      const usage = (parsed as { usage?: Record<string, unknown> })?.usage;
      if (!usage) continue;
      for (const [field, target] of [
        ['input_tokens', 'promptTokens'],
        ['output_tokens', 'completionTokens'],
        ['cache_read_input_tokens', 'cachedTokens'],
      ] as const) {
        const value = usage[field];
        if (typeof value === 'number' && Number.isFinite(value)) {
          into[target] = value;
        }
      }
    }
  }

  /**
   * Pipe an upstream response back to the client.
   *
   * An Anthropic upstream is byte-forwarded as-is. An OpenAI upstream is
   * rewritten event by event into Anthropic's SSE vocabulary, because the SDK
   * parses those names and would otherwise see an unparseable stream. The
   * rewrite is incremental — buffering the whole turn would add a full turn of
   * latency and lose the streaming behaviour Craft relies on.
   *
   * Response headers are written only after the first body chunk arrives, so a
   * first-byte timeout can still fall through to another provider.
   */
  private async pipeResponse(
    response: Response,
    res: ServerResponse,
    timing?: {
      firstByteMs?: number;
      totalMs?: number;
      usage: MutableUsage;
      startedAt: number;
    },
    transcode?: {
      provider: LlmProvider;
      upstreamModel: string;
      publicModel: string;
      messageId: string;
      /** Whether the *client* asked for a stream; decides the response shape. */
      stream: boolean;
    },
    guard: {
      firstByteMs: number;
      abort: () => void;
      onTruncated?: () => Promise<string>;
    } = { firstByteMs: 0, abort: () => {} },
  ): Promise<{ truncated: boolean; firstByteTimeout?: boolean; retryMarker?: string } | undefined> {
    const isOpenAI = transcode?.provider.protocol === 'openai-completions';
    const { firstByteMs, abort } = guard;

    if (isOpenAI && transcode) {
      if (!transcode.stream) {
        // The client asked for a single JSON body. Reading the upstream as SSE
        // here is what produced "upstream stream ended without a finish_reason"
        // for every non-streaming caller.
        const read = await this.readTextWithTimeout(response, firstByteMs, abort);
        if (read.firstByteTimeout) return { truncated: true, firstByteTimeout: true };
        const text = read.text;
        let payloadOut: Record<string, unknown>;
        try {
          payloadOut = transcodeResponseToAnthropic(JSON.parse(text), {
            publicModel: transcode.publicModel,
            upstreamModel: transcode.upstreamModel,
            messageId: transcode.messageId,
          });
        } catch {
          // Not JSON: hand the upstream body through rather than inventing a
          // message, so the caller sees what actually came back.
          if (timing) {
            timing.firstByteMs = Date.now() - timing.startedAt;
            timing.totalMs = Date.now() - timing.startedAt;
          }
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
          res.end(text);
          return { truncated: false };
        }
        if (timing) {
          const usage = payloadOut.usage as
            | { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number }
            | undefined;
          timing.usage.promptTokens = (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0);
          timing.usage.completionTokens = usage?.output_tokens ?? 0;
          timing.usage.cachedTokens = usage?.cache_read_input_tokens ?? 0;
          timing.firstByteMs = Date.now() - timing.startedAt;
          timing.totalMs = Date.now() - timing.startedAt;
        }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
        res.end(JSON.stringify(payloadOut));
        return { truncated: false };
      }
      // `pipeTranscoded` writes the SSE headers after its first chunk.
      return this.pipeTranscoded(response, res, transcode, timing, guard);
    }

    const contentType = response.headers.get('content-type') ?? 'application/json';

    if (!response.body) {
      const text = await response.text();
      if (timing) {
        this.scrapeUsage(text, timing.usage);
        timing.firstByteMs = Date.now() - timing.startedAt;
        timing.totalMs = Date.now() - timing.startedAt;
      }
      res.writeHead(200, {
        'content-type': contentType,
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.end(text);
      return { truncated: false };
    }

    const reader = response.body.getReader();
    const first = await this.readFirstChunk(reader, firstByteMs, abort);
    if (first.firstByteTimeout) {
      try {
        await reader.cancel();
      } catch {
        // The request was already aborted.
      }
      return { truncated: true, firstByteTimeout: true };
    }

    res.writeHead(200, {
      'content-type': contentType,
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    let sawByte = false;
    let pending = first.value;
    try {
      for (;;) {
        const chunk = pending
          ? { done: false, value: pending }
          : await reader.read();
        pending = undefined;
        if (chunk.done) break;
        if (!sawByte && timing) {
          sawByte = true;
          timing.firstByteMs = Date.now() - timing.startedAt;
        }
        if (timing) {
          this.scrapeUsage(Buffer.from(chunk.value!).toString('utf8'), timing.usage);
        }
        res.write(Buffer.from(chunk.value!));
      }
    } finally {
      if (timing) timing.totalMs = Date.now() - timing.startedAt;
      reader.releaseLock();
      res.end();
    }
    return { truncated: false };
  }

  /**
   * Read the first body chunk, failing fast when the upstream sends nothing.
   *
   * Returns `firstByteTimeout` without consuming the stream: no response
   * headers have been written yet, so the caller can still retry elsewhere.
   */
  private async readFirstChunk(
    // Minimal shape rather than `ReadableStreamDefaultReader<Uint8Array>`: the
    // DOM and Bun type libraries disagree about `readMany`, and this method
    // only consumes `read()`. A full reader satisfies it structurally.
    reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> },
    firstByteMs: number,
    abort: () => void,
  ): Promise<{ done: boolean; value?: Uint8Array; firstByteTimeout?: boolean }> {
    const read = reader.read().then((r) => ({ done: r.done, value: r.value }));
    if (firstByteMs <= 0) return read;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ done: true; firstByteTimeout: true }>((resolve) => {
      timer = setTimeout(() => {
        // Abort the request too: `reader.cancel()` alone can leave the socket
        // open on some transports.
        abort();
        resolve({ done: true, firstByteTimeout: true });
      }, firstByteMs);
    });
    try {
      return await Promise.race([read, timeout]);
    } catch {
      // An abort or stream error before the first byte is the same outcome.
      return { done: true, firstByteTimeout: true };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** `response.text()` with the first-byte deadline applied. */
  private async readTextWithTimeout(
    response: Response,
    firstByteMs: number,
    abort: () => void,
  ): Promise<{ text: string; firstByteTimeout?: boolean }> {
    const read = response.text().then((text) => ({ text }));
    if (firstByteMs <= 0) return read;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ text: string; firstByteTimeout: true }>((resolve) => {
      timer = setTimeout(() => {
        abort();
        resolve({ text: '', firstByteTimeout: true });
      }, firstByteMs);
    });
    try {
      return await Promise.race([read, timeout]);
    } catch {
      return { text: '', firstByteTimeout: true };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Rewrite an OpenAI SSE stream into Anthropic's event shape, chunk by chunk.
   *
   * A chunk boundary can split an SSE `data:` line, so partial lines are held
   * in `carry` until the rest arrives. OpenAI's `[DONE]` sentinel has no
   * Anthropic equivalent and is dropped — the transcoder emits the closing
   * events itself.
   *
   * The SSE headers are written only after the first chunk, so a first-byte
   * timeout leaves the response untouched and retryable.
   */
  private async pipeTranscoded(
    response: Response,
    res: ServerResponse,
    transcode: { upstreamModel: string; publicModel: string; messageId: string },
    timing?: { firstByteMs?: number; totalMs?: number; usage: MutableUsage; startedAt: number },
    guard: {
      firstByteMs: number;
      abort: () => void;
      onTruncated?: () => Promise<string>;
    } = { firstByteMs: 0, abort: () => {} },
  ): Promise<{ truncated: boolean; firstByteTimeout?: boolean; retryMarker?: string }> {
    const transcoder = new ResponseTranscoder({
      publicModel: transcode.publicModel,
      upstreamModel: transcode.upstreamModel,
      messageId: transcode.messageId,
    });
    const { firstByteMs, abort } = guard;
    // The response must expose Anthropic's content type regardless of what the
    // upstream called it, or the SDK will not treat it as an SSE stream.
    const sseHeaders = {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    };

    if (!response.body) {
      if (timing) {
        timing.firstByteMs = Date.now() - timing.startedAt;
        timing.totalMs = Date.now() - timing.startedAt;
      }
      res.writeHead(200, sseHeaders);
      res.end(transcoder.finish());
      return { truncated: false };
    }

    const reader = response.body.getReader();
    const first = await this.readFirstChunk(reader, firstByteMs, abort);
    if (first.firstByteTimeout) {
      try {
        await reader.cancel();
      } catch {
        // The request was already aborted.
      }
      return { truncated: true, firstByteTimeout: true };
    }

    res.writeHead(200, sseHeaders);

    const decoder = new TextDecoder();
    let carry = '';
    let sawByte = false;
    let receivedDone = false;
    let pending = first.value;

    const consume = (value: Uint8Array): void => {
      if (!sawByte && timing) {
        sawByte = true;
        timing.firstByteMs = Date.now() - timing.startedAt;
      }

      carry += decoder.decode(value, { stream: true });
      // Keep the last element only when it is an unterminated line: a chunk
      // may end mid-`data:` and the remainder arrives in the next read.
      const lines = carry.split('\n');
      carry = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const raw = trimmed.slice(5).trim();
        if (!raw) continue;
        if (raw === '[DONE]') {
          receivedDone = true;
          continue;
        }
        let chunk: unknown;
        try {
          chunk = JSON.parse(raw);
        } catch {
          continue;
        }
        const written = transcoder.push(chunk as never);
        if (written) res.write(written);
      }
    };

    try {
      for (;;) {
        const chunk = pending
          ? { done: false, value: pending }
          : await reader.read();
        pending = undefined;
        if (chunk.done) break;
        consume(chunk.value!);
      }

      // Flush any trailing line without a newline — some gateways omit it.
      const tail = `${carry}${decoder.decode()}`.trim();
      if (tail.startsWith('data:')) {
        const raw = tail.slice(5).trim();
        if (raw === '[DONE]') receivedDone = true;
        else if (raw) {
          try {
            const written = transcoder.push(JSON.parse(raw) as never);
            if (written) res.write(written);
          } catch {
            // Ignored: a malformed trailing line is not worth failing the turn.
          }
        }
      }

      // A stream that ended without [DONE] was cut, not completed. Reporting it
      // as a normal finish would hide a failed turn from the retry logic.
      const usage = transcoder.usage();
      if (timing) {
        timing.usage.promptTokens = usage.promptTokens;
        timing.usage.completionTokens = usage.completionTokens;
        timing.usage.cachedTokens = usage.cachedTokens;
        timing.totalMs = Date.now() - timing.startedAt;
      }
      const truncated = !receivedDone;
      const retryMarker = truncated ? await guard.onTruncated?.() : undefined;
      res.end(transcoder.finish({ truncated, retryMarker }));
      return { truncated, ...(retryMarker ? { retryMarker } : {}) };
    } catch (err) {
      this.log(`transcode stream failed: ${describeError(err)}`);
      const partial = transcoder.usage();
      if (timing) {
        timing.usage.promptTokens = partial.promptTokens;
        timing.usage.completionTokens = partial.completionTokens;
        timing.usage.cachedTokens = partial.cachedTokens;
        timing.totalMs = Date.now() - timing.startedAt;
      }
      const retryMarker = await guard.onTruncated?.();
      res.end(transcoder.finish({ truncated: true, retryMarker }));
      return { truncated: true, ...(retryMarker ? { retryMarker } : {}) };
    } finally {
      reader.releaseLock();
    }
  }

  // -------------------------------------------------------------------------
  // Introspection helpers
  // -------------------------------------------------------------------------

  /** Per-key state snapshot for the provider detail table. */
  keyStates(): LlmGatewayKeyState[] {
    const out: LlmGatewayKeyState[] = [];
    for (const [providerId, pool] of this.pools) {
      for (const entry of pool.snapshot()) {
        out.push({ provider: providerId, ...entry });
      }
    }
    return out;
  }

  /**
   * Clear a cooldown, or every cooldown when `keyId` is omitted.
   *
   * Delegates to each pool so the sliding-window bookkeeping and the
   * in-flight counter stay consistent — clearing a key must not leave the pool
   * believing it is still cooling.
   *
   * Route and endpoint cooling belong to the same "parked, try again later"
   * state and are cleared alongside the keys — otherwise a relay whose 429
   * carried a long reset (60124s, 2026-10-30: deepseek parked until 18:00)
   * stayed out of the group with nothing in the UI able to release it, since
   * neither the key table nor a restart touches these maps.
   */
  clearKeyCooldown(providerId?: string, keyId?: string): Promise<boolean> {
    const targets: Array<readonly [string, KeyPool | undefined]> = providerId
      ? [[providerId, this.pools.get(providerId)] as const]
      : [...this.pools.entries()];
    // A named key is a single account's problem; route/endpoint cooling is
    // broader than that key and stays (clearing it would undo another
    // account's cooldown as a side effect of one row's button).
    const clearRoutes = !keyId;
    return (async () => {
      let cleared = false;
      for (const [id, pool] of targets) {
        if (!pool) continue;
        if (keyId) {
          await pool.clearCooling(keyId);
          cleared = true;
        } else {
          for (const entry of pool.snapshot()) {
            if (!entry.cooling) continue;
            await pool.clearCooling(entry.keyId);
            cleared = true;
          }
        }
        if (!clearRoutes) continue;
        // `provider::publicModel` — every route this provider serves.
        const prefix = `${id}::`;
        for (const routeKey of [...this.unitCooling.keys()]) {
          if (!routeKey.startsWith(prefix)) continue;
          this.unitCooling.delete(routeKey);
          cleared = true;
        }
        if (this.endpointCooling.delete(id)) cleared = true;
      }
      if (clearRoutes && !providerId) {
        // No provider named: release every route and endpoint.
        if (this.unitCooling.size > 0) { this.unitCooling.clear(); cleared = true; }
        if (this.endpointCooling.size > 0) { this.endpointCooling.clear(); cleared = true; }
      }
      if (cleared) this.persistCooldowns();
      return cleared;
    })();
  }

  /**
   * Providers in `strategy` whose keys are ALL cooling / rate-limited, so the
   * planner can exclude them before any upstream call — the "state-driven"
   * scheduling that lets a new session avoid a known-failing provider.
   */
  private async onStreamTruncated(args: {
    config: LlmConfig;
    strategy: LlmStrategy;
    publicModel: string;
    unitId: string;
    keyId: string;
    maxAttempts: number;
    state: GatewayStreamRetryState;
    coolKey: (kind: 'default' | 'rate_limit' | 'quota') => Promise<number>;
  }): Promise<string> {
    const routeKey = `${args.unitId}::${args.keyId}`;
    const attempts = (args.state.attemptsByRoute.get(routeKey) ?? 0) + 1;
    args.state.attemptsByRoute.set(routeKey, attempts);
    if (attempts < args.maxAttempts) return GATEWAY_STREAM_TRUNCATION_RETRY_MARKER;

    // This key has spent its configured stream-attempt budget. Cool only the
    // account that failed, then let the normal planner choose another key,
    // route or configured fallback on the client's same-turn continuation.
    await args.coolKey('default');

    const visited = new Set<string>();
    let strategy: LlmStrategy | null = args.strategy;
    while (strategy && !visited.has(strategy.id)) {
      visited.add(strategy.id);
      const availability = await this.unavailableUnitsFor(strategy, args.publicModel);
      try {
        const plan = planRequest({
          config: args.config,
          strategy,
          publicModel: args.publicModel,
          unavailableUnits: availability.excluded,
        });
        if (plan.units.length > 0) return GATEWAY_STREAM_TRUNCATION_RETRY_MARKER;
      } catch {
        // Check the configured fallback chain below.
      }
      strategy = this.resolveFallback(args.config, strategy.id);
    }
    return GATEWAY_STREAM_TRUNCATION_EXHAUSTED_MARKER;
  }

  private async unavailableUnitsFor(
    strategy: LlmStrategy,
    publicModel: string,
  ): Promise<{ excluded: Set<string>; allLimited: boolean; retryAfterSeconds: number }> {
    const excluded = new Set<string>();
    const config = this.getConfig();
    // `allLimited` means "every candidate unit was excluded because its keys are
    // merely rate-limited / busy". It is what separates a 429 from a 503 when
    // the planner ends up with nothing to route to.
    let allLimited = true;
    let sawUnit = false;
    let soonestWait = Number.POSITIVE_INFINITY;
    let candidates: ReturnType<typeof candidateUnits>;
    try {
      candidates = candidateUnits(config, strategy, publicModel);
    } catch {
      // A dangling provider reference is the planner's error to report; do not
      // turn it into "every unit is cooling".
      return { excluded, allLimited: false, retryAfterSeconds: 0 };
    }
    const now = Date.now() / 1000;
    for (const unit of candidates.units) {
      sawUnit = true;
      // Route and endpoint cooling are exclusions too — and neither is a rate
      // wall, so they must keep the answer at 503 rather than 429.
      const routeWait = Math.max(
        0,
        (this.unitCooling.get(unit.id) ?? 0) - now,
        (this.endpointCooling.get(unit.provider.id) ?? 0) - now,
      );
      if (routeWait > 0) {
        excluded.add(unit.id);
        allLimited = false;
        soonestWait = Math.min(soonestWait, routeWait);
        continue;
      }
      const pool = this.pools.get(unit.provider.id);
      if (!pool) {
        allLimited = false;
        continue;
      }
      const availability = await pool.availability(unit.upstreamModel);
      if (availability.available) {
        allLimited = false;
        continue;
      }
      excluded.add(unit.id);
      if (availability.reason === 'cooling') {
        // A cooled key can also free up soon, but it is a health signal rather
        // than a quota wall, so the response must stay "no healthy account".
        allLimited = false;
        continue;
      }
      if (availability.retryAfterSeconds > 0) {
        soonestWait = Math.min(soonestWait, availability.retryAfterSeconds);
      }
    }
    return {
      excluded,
      allLimited: allLimited && sawUnit,
      retryAfterSeconds: Number.isFinite(soonestWait) ? soonestWait : 0,
    };
  }

  /** Cool one route: the model is not served here, the account may still be. */
  private coolUnit(unitKey: string, seconds: number): void {
    const until = Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(seconds));
    this.unitCooling.set(unitKey, until);
    this.persistCooldowns();
  }

  /**
   * Cool the route that just failed at the transport level.
   *
   * The unit (`provider::model`), not the endpoint: a relay serves several
   * models from one `baseUrl`, and a timeout is usually one model's problem
   * (a slow or oversized route), not the whole machine's. Cooling the
   * endpoint took every other model of that provider down with it — on a
   * single-endpoint relay that is the entire group, so one aborted request
   * left nothing to fall back to (2026-10-30, workbuddycn: one transport
   * error parked deepseek *and* its fallbacks for 60s).
   */
  private coolRouteAfterTransport(
    unitKey: string,
    provider: LlmProvider,
    keyId: string,
  ): void {
    this.coolUnit(unitKey, this.endpointCooldownSeconds(provider, keyId));
  }

  /**
   * Cool one endpoint: transport failures belong to `baseUrl`, not a key.
   *
   * No longer written by the request path (which cools the route instead, see
   * {@link coolRouteAfterTransport}); kept so a cooldown file written by an
   * older build still excludes what it named, and so the status snapshot can
   * still report those entries.
   */
  private coolEndpoint(providerId: string, seconds: number): void {
    const until = Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(seconds));
    this.endpointCooling.set(providerId, until);
    this.persistCooldowns();
  }

  /**
   * Route cooldown from the key's preset (`routeSeconds`, default 300).
   *
   * Long enough that a misconfigured model id is not re-probed on every turn,
   * short enough that fixing the upstream does not need a restart.
   */
  private routeCooldownSeconds(provider: LlmProvider, keyId: string): number {
    const preset = presetFor(this.getConfig(), provider, keyId);
    return preset.routeSeconds ?? DEFAULT_ROUTE_COOLDOWN_SECONDS;
  }

  /** Endpoint cooldown uses the same default-failure budget as a key. */
  private endpointCooldownSeconds(provider: LlmProvider, keyId: string): number {
    const preset = presetFor(this.getConfig(), provider, keyId);
    return preset.defaultSeconds ?? 60;
  }

  /** Resolve a strategy's fallback, if one is configured and exists. */
  private resolveFallback(config: LlmConfig, strategyId: string): LlmStrategy | null {
    const s = config.strategies.find((x) => x.id === strategyId);
    if (!s?.fallbackStrategyId) return null;
    return config.strategies.find((x) => x.id === s.fallbackStrategyId) ?? null;
  }

  private coolingKeyCount(): number {
    let total = 0;
    for (const pool of this.pools.values()) {
      for (const entry of pool.snapshot()) if (entry.cooling) total += 1;
    }
    return total;
  }

  private recordUsage(record: UsageRecord): void {
    this.usage.push(record);
    if (this.usage.length > 1000) this.usage.splice(0, this.usage.length - 1000);
  }
}

// ============================================================================
// Module-local helpers
// ============================================================================

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function bearerFrom(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1];
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Stable hash used to keep trace ids free of raw keys. */
export function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Client-facing error body for a decided status.
 *
 * The status is chosen once (`clientStatus`); the type/message must describe
 * the same thing rather than re-deriving it — a balance wall answered as
 * `rate_limit_error` sent operators to the wrong screen.
 */
function clientErrorFor(
  status: number,
  context: { tprRejected: boolean },
): { type: string; message: string } {
  if (status === 400) {
    return context.tprRejected
      ? {
          type: 'invalid_request_error',
          message: 'request exceeds the token ceiling (TPR) of every available key',
        }
      : { type: 'invalid_request_error', message: 'the upstream rejected the request itself' };
  }
  if (status === 402) {
    return { type: 'insufficient_balance', message: 'every account is out of balance or quota' };
  }
  if (status === 429) {
    return { type: 'rate_limit_error', message: 'all upstreams are rate limited' };
  }
  if (status === 503) {
    return { type: 'overloaded_error', message: 'no healthy account for this model' };
  }
  return { type: 'api_error', message: 'all upstreams failed' };
}

/** Failure buckets the switch policy routes on. */
type UpstreamFailureKind =
  | 'rate_limit'
  | 'quota'
  | 'auth'
  | 'model_not_found'
  | 'server_error'
  | 'request';

/**
 * Classify an upstream failure into the cooldown / switch buckets.
 *
 * The code is authoritative where it is unambiguous; the body is consulted
 * where it is not:
 *
 *  - 429 → rate limit (the account is throttled, another key may not be);
 *  - 402 → quota (balance / plan exhausted);
 *  - 401 / 403 → auth (the key is wrong or revoked);
 *  - a balance/quota phrase on *any* code → quota. Relays routinely answer
 *    400/500 with 「余额不足」 instead of a 402, and calling that "transient"
 *    is what made a dead account look like a flaky gateway;
 *  - 404 → the model is not served here (route, not account);
 *  - 400 / 422 → request error unless the body names a model;
 *  - 408 / 409 / 5xx → server error (retryable).
 *
 * Splitting these is the point: cooling the *key* for a 404 took every model
 * of that provider down with it (261027-long-bronze).
 */
function classifyUpstreamFailure(code: number, body: string): { kind: UpstreamFailureKind } {
  if (code === 429) return { kind: 'rate_limit' };
  if (code === 402) return { kind: 'quota' };
  if (code === 401 || code === 403) return { kind: 'auth' };

  const low = body.toLowerCase();
  if (/insufficient|balance|quota|billing|credit|余额|欠费|额度|充值|配额/i.test(low)) {
    return { kind: 'quota' };
  }
  if (code === 404) return { kind: 'model_not_found' };
  if (code === 400 || code === 422) {
    // A malformed prompt is the client's problem; a model id the provider does
    // not serve is a routing problem. The body is the only thing that
    // distinguishes them at this status.
    const modelish = /model|模型|not\s*found|does not exist|unsupported|unknown|不存在|不支持/i.test(low);
    return { kind: modelish ? 'model_not_found' : 'request' };
  }
  if (code === 408 || code === 409 || code >= 500) return { kind: 'server_error' };
  return { kind: 'request' };
}

/**
 * Human-readable failure line for the log.
 *
 * Keeps a bounded digest of the upstream body. Without it the log said only
 * "upstream workbuddycn returned 404", which cannot distinguish a wrong URL
 * from a missing model from a relay's own JSON error — the operator had to
 * reproduce the request to learn anything.
 */
function describeUpstreamFailure(
  providerId: string,
  code: number,
  body: string,
  kind: UpstreamFailureKind,
): string {
  const label =
    kind === 'rate_limit' ? 'rate limited'
      : kind === 'quota' ? 'out of balance/quota'
        : kind === 'auth' ? 'rejected the credential'
          : kind === 'model_not_found' ? 'does not serve this model'
            : kind === 'server_error' ? 'failed'
              : 'rejected the request';
  const digest = bodyDigest(body);
  return `upstream ${providerId} ${label} (${code})${digest ? `: ${digest}` : ''}`;
}

/** First 200 characters of a response body, whitespace collapsed. */
function bodyDigest(body: string): string {
  const trimmed = body.trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

/** Headers upstreams use to say when the current limit window resets. */
const RATE_LIMIT_RESET_HEADERS = [
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens',
  'x-ratelimit-reset-input-tokens',
  'x-ratelimit-reset-output-tokens',
  'anthropic-ratelimit-requests-reset',
  'anthropic-ratelimit-tokens-reset',
  'anthropic-ratelimit-input-tokens-reset',
  'anthropic-ratelimit-output-tokens-reset',
];

/**
 * Turn a 429 into a cooldown hint.
 *
 * `Retry-After` is the upstream's own answer and always wins; otherwise the
 * `*-reset-*` headers are parsed and the soonest wins. A body that talks about
 * days/quota marks the limit as day-level, which skips the minute-scale ladder
 * — retrying a daily quota in 2s only produces another 429.
 */
export function parseRateLimitSignal(headers: Headers, body: string): RateLimitSignal {
  const retryAfter = parseRetryAfter(headers.get('retry-after'));
  const reset = parseResetHeaders(headers);
  const seconds = retryAfter ?? reset;
  // Only explicit day-scale wording counts. A generic "quota"/"额度" on a 429
  // is just as likely to be a per-minute ceiling, and cooling it to midnight
  // would waste a day of capacity; the escalation ladder handles those.
  const dayLevel = /per\s*day|daily|per-day|tokens?\s+per\s+day|\brpd\b|each day|每天|每日|当日/i.test(body);
  const signal: RateLimitSignal = {};
  if (seconds !== undefined && seconds > 0) signal.retryAfterSeconds = seconds;
  if (dayLevel) signal.dayLevel = true;
  return signal;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0 ? Math.ceil(n) : undefined;
  }
  const at = Date.parse(trimmed);
  if (!Number.isNaN(at)) {
    const seconds = Math.ceil((at - Date.now()) / 1000);
    return seconds > 0 ? seconds : undefined;
  }
  return undefined;
}

function parseResetHeaders(headers: Headers): number | undefined {
  let best: number | undefined;
  for (const name of RATE_LIMIT_RESET_HEADERS) {
    const raw = headers.get(name);
    if (!raw) continue;
    const seconds = parseDurationOrEpoch(raw);
    if (seconds === undefined || seconds <= 0) continue;
    if (best === undefined || seconds < best) best = seconds;
  }
  return best;
}

/** Parse `90`, `1m30s`, `500ms`, an epoch (s/ms) or an HTTP date into seconds. */
function parseDurationOrEpoch(raw: string): number | undefined {
  const value = raw.trim();
  const duration = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/.exec(value);
  if (duration && (duration[1] || duration[2] || duration[3] || duration[4])) {
    const hours = Number(duration[1] ?? 0);
    const minutes = Number(duration[2] ?? 0);
    const seconds = Number(duration[3] ?? 0);
    const ms = Number(duration[4] ?? 0);
    return Math.ceil(hours * 3600 + minutes * 60 + seconds + ms / 1000);
  }
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const n = Number(value);
    // Epoch millis, epoch seconds, or a plain number of seconds.
    if (n > 1e12) return Math.ceil(n / 1000 - Date.now() / 1000);
    if (n > 1e9) return Math.ceil(n - Date.now() / 1000);
    return Math.ceil(n);
  }
  const at = Date.parse(value);
  if (!Number.isNaN(at)) return Math.ceil((at - Date.now()) / 1000);
  return undefined;
}

/**
 * Effective preset for one key.
 *
 * Delegates to `resolvePreset` so the gateway and the settings page share one
 * chain (key type -> provider default -> built-in default, skipping empty and
 * deleted ids). The local guard only covers a key id that no longer exists.
 */
function presetFor(config: LlmConfig, provider: LlmProvider, keyId: string): LlmPreset {
  const key = provider.keys.find((k) => k.id === keyId);
  if (!key) return {};
  return resolvePreset(config, provider, key);
}

/** Cooldown durations resolved from a preset (with the built-in fallbacks). */
function cooldownDurationsFromPreset(preset: LlmPreset): CooldownDurations {
  return {
    defaultSeconds: preset.defaultSeconds ?? 60,
    rateLimitSeconds: preset.rateLimitSeconds ?? 60,
    quotaSeconds: preset.quotaExhaustedSeconds ?? 2592000,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
