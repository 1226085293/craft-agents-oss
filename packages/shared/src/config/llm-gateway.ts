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

import type { LlmConfig, LlmProvider, LlmStrategy, LlmPreset } from './llm-config.ts';
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
import { loadCooldowns, saveCooldowns, cooldownKey } from './llm-cooldown-store.ts';
import {
  planRequest,
  resolveStrategyForClientKey,
  resolveUpstreamModel,
  type Plan,
} from './llm-planner.ts';
import { transcodeRequestToOpenAI, openAIHeaders } from './llm-transcode-request.ts';
import { ResponseTranscoder, transcodeResponseToAnthropic } from './llm-transcode-response.ts';
import { DEFAULT_PRESET, resolvePreset, resolvePresetId } from './llm-config.ts';

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
  providerId: string;
  keyId: string;
  upstreamModel: string;
  previous: {
    strategyId: string;
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
   * This is what the composer's "策略组-当前模型" label reads. It has to come
   * from the gateway rather than being derived in the UI: a strategy's members
   * can each map a public model to a different upstream name, and which one
   * wins depends on who answers first — so "the current model" is a fact about
   * traffic, not about configuration.
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
  strategy: string;
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

  private inFlight = 0;
  private usage: UsageRecord[] = [];

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
    for (const [providerId, pool] of pools) {
      const oldPool = oldPools.get(providerId);
      if (oldPool) {
        pool.importCooling(oldPool.exportCooling());
      } else {
        const entries: Record<string, number> = {};
        for (const [persistKey, until] of Object.entries(persisted)) {
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
  }

  /** Persist every provider's cooldown state to disk. */
  private persistCooldowns(): void {
    const map: Record<string, number> = {};
    for (const [providerId, pool] of this.pools) {
      for (const [keyId, until] of pool.exportCooling()) {
        map[cooldownKey(providerId, keyId)] = until;
      }
    }
    saveCooldowns(map);
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
        // "No provider" is the more fundamental fault: with every member
        // disabled the model list is empty for a second reason, and saying
        // "未配置模型" would send the user to the wrong screen.
        const reason = enabledProviders === 0
          ? '没有可用的提供商'
          : models.size === 0
            ? '未配置模型'
            : undefined
        return {
          id: s.id,
          type: s.type,
          providers: s.members.length,
          models: [...models],
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
    try {
      // Fallback chain: try the resolved strategy, then its `fallbackStrategyId`,
      // then that one's, and so on. `visited` catches a cycle (p1→p2→p1) so a
      // loop never spins forever — revisiting a strategy already in the chain
      // is a terminal error.
      const visited = new Set<string>();
      let current: LlmStrategy | null = strategy;
      let limited = false;
      let tprRejected = false;
      let retryAfterSeconds = 0;
      // The last thing that went wrong, so the final status can say "no healthy
      // account" (503) instead of pretending the upstreams failed (502).
      let lastOutcome: 'plan_failed' | 'exhausted' | null = null;

      while (current && !visited.has(current.id)) {
        visited.add(current.id);

        // Exclude providers whose keys are ALL cooling / rate-limited so the
        // planner never picks a provider that cannot serve the request. When
        // that leaves nothing, the planner throws and we fall through below.
        const availability = await this.unavailableProvidersFor(current, publicModel);

        let plan: ReturnType<typeof planRequest>;
        try {
          plan = planRequest({
            config,
            strategy: current,
            publicModel,
            unavailableProviders: availability.excluded,
          });
        } catch (err) {
          this.log(`planning failed for ${current.id}: ${describeError(err)}`);
          this.recordUsage({
            ts: Date.now(),
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
          });
          lastOutcome = 'plan_failed';
          // Nothing was dispatched and every member was excluded only because
          // its keys are rate-limited or busy. That is a limit wall, not an
          // unhealthy account: answer 429 + Retry-After (handled below) so the
          // client backs off for the real time instead of reading a 503 as an
          // outage. Cooling-only exclusions keep the 503.
          if (availability.allLimited) {
            limited = true;
            retryAfterSeconds = Math.max(retryAfterSeconds, availability.retryAfterSeconds);
          }
          current = this.resolveFallback(config, current.id);
          continue;
        }

        const outcome = await this.execute(plan, payload, res, generation, requestKind, sessionId);
        if (outcome.kind === 'success') return;
        if (outcome.kind === 'reloaded') {
          // Config reloaded mid-flight: the caller retries against the new plan.
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ error: { type: 'overloaded_error', message: 'gateway reloaded, retry' } }),
          );
          return;
        }
        limited = limited || outcome.limited;
        tprRejected = tprRejected || outcome.tprRejected;
        retryAfterSeconds = Math.max(retryAfterSeconds, outcome.retryAfterSeconds);
        lastOutcome = 'exhausted';
        // Exhausted — transfer to the fallback strategy, if one is configured.
        current = this.resolveFallback(config, current.id);
      }

      // Every strategy in the chain is exhausted (or a cycle was detected).
      // A limit wall is a 429 with the soonest cooldown as Retry-After; anything
      // else is the generic 502. Either way the client is told when to come back
      // instead of retrying into the same cooling keys.
      if (limited) {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (retryAfterSeconds > 0) headers['retry-after'] = String(retryAfterSeconds);
        res.writeHead(429, headers);
        res.end(
          JSON.stringify({
            error: { type: 'rate_limit_error', message: 'all upstreams are rate limited' },
          }),
        );
      } else if (tprRejected) {
        // The request itself is too large for every usable key — retrying will
        // never help, so this is a client error rather than a 502/429.
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              type: 'invalid_request_error',
              message: 'request exceeds the token ceiling (TPR) of every available key',
            },
          }),
        );
      } else if (lastOutcome === 'plan_failed') {
        // Nothing was dispatched: every member was disabled, outside its window
        // or cooling. That is a 503, not an upstream failure. A member that was
        // merely rate-limited is answered 429 above instead.
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { type: 'overloaded_error', message: 'no healthy account for this model' },
          }),
        );
      } else {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { type: 'api_error', message: 'all upstreams failed' },
          }),
        );
      }
    } finally {
      this.inFlight -= 1;
    }
  }

  /**
   * Run the retry ladder across the planned providers.
   *
   * Streaming responses are piped through as they arrive; a failure before the
   * first byte is retryable, a failure mid-stream is not (the client has
   * already committed to that body).
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
  ): Promise<
    | { kind: 'success' }
    | { kind: 'reloaded' }
    | { kind: 'exhausted'; limited: boolean; tprRejected: boolean; retryAfterSeconds: number }
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
    let lastError = '';
    // Where the last attempt was aimed, so the failure row names a provider and
    // a key instead of leaving both columns empty.
    let lastProvider = '';
    let lastKeyId = '';
    let lastUpstreamModel = '';
    // Reservation sent against TPM/TPD. Estimated before dispatch, reconciled
    // with the real usage once a response lands.
    const estimatedTokens = estimateRequestTokens(payload);
    // Set when the failure was a limit (429/quota or "no key available"), so
    // the caller can answer 429 + Retry-After instead of a generic 502.
    let limited = false;
    // The request is larger than every key's TPR ceiling: a client error, not
    // a retryable upstream failure.
    let tprRejected = false;

    for (const planned of plan.providers) {
      const provider = planned.provider;
      // A second-or-later provider in this request is a retry across providers,
      // which is the only place that stage can be observed.
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
      const sessionKey = sessionId;
      const upstreamModel = plan.modelAliases[String(payload.model ?? '')]
        ?? resolveUpstreamModel(plan.strategy, provider, String(payload.model ?? ''));

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
          if (reason === 'cooling') limited = true;
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

      /**
       * Cool the key and give up on this provider without rotating.
       *
       * For endpoint-level failures: a transport error (DNS / TLS / connection)
       * or a first byte that never arrived is a property of `provider.baseUrl`,
       * not of the key — every key on the provider pays the same cost, so
       * rotating would only multiply the wait before the request moves on. The
       * 2026-10-25 incident is the case in point: a relay that answers large
       * prompts in 25–30s blew the 30s first-byte budget on one key, then on
       * the next two, turning a 60s failure into a 120s one.
       */
      const leaveProvider = async (
        kind: 'default' | 'rate_limit' | 'quota',
        signal?: RateLimitSignal,
      ): Promise<void> => {
        await coolKey(kind, signal);
        releaseKey();
      };

      // Same-key retry: a transient failure retries THIS key up to
      // `maxAttempts`; when the key is done it is cooled and the next key of the
      // provider is tried, then the next provider.
      // Rate-limit / quota / deterministic failures cool + rotate immediately.
      for (;;) {
        attempt += 1;
        keyAttempts += 1;
        // Stamp the target before the call so the failure row can name it even
        // when the attempt itself throws.
        lastProvider = provider.id;
        lastKeyId = selection.keyId;
        lastUpstreamModel = upstreamModel;

        let call: UpstreamCall;
        try {
          call = await this.callUpstream(provider, selection.keyId, upstreamModel, payload);
        } catch (err) {
          lastError = `upstream ${provider.id} transport error: ${describeError(err)}`;
          this.log(lastError);
          if (keyAttempts >= maxAttempts) {
            markStage('cooldown_provider');
            // Connection-level: the endpoint is unreachable, not the account.
            await leaveProvider('default');
            break;
          }
          releaseKey();
          if (plan.retry.backoffMs > 0) await sleep(plan.retry.backoffMs);
          continue;
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
          }, { firstByteMs, abort: call.abort });
          if (outcome?.firstByteTimeout) {
            // Nothing was written to the client yet, so another provider (or a
            // retry of this key) can still serve the turn.
            lastError = `upstream ${provider.id} first byte timeout (${firstByteMs}ms)`;
            this.log(lastError);
            if (keyAttempts >= maxAttempts) {
              markStage('cooldown_provider');
              // The relay was too slow to answer at all: the provider's other
              // keys share that latency, so go to the next provider instead of
              // paying the same budget again per key.
              await leaveProvider('default');
              break;
            }
            releaseKey();
            if (plan.retry.backoffMs > 0) await sleep(plan.retry.backoffMs);
            continue;
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
            strategy: plan.strategyId,
            provider: provider.id,
            keyId: selection.keyId,
            publicModel: String(payload.model ?? ''),
            upstreamModel,
            ...(requestKind ? { kind: requestKind } : {}),
            // A stream that ends without a finish_reason is a failed turn even
            // though the HTTP status was 200. Recording it as success hid the
            // failure from the log, the usage totals and the provider's health.
            status: outcome?.truncated ? 'error' : 'success',
            statusCode: 200,
            ...(outcome?.truncated ? { error: 'upstream stream ended without a finish_reason' } : {}),
            attempts: attempt,
            sessionId,
            retried: attempt > 1,
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
            this.noteRoute(plan, provider, selection.keyId, upstreamModel, sessionId, outcome?.truncated === true);
          }
          releaseKey();
          return { kind: 'success' };
        }

        // Classify the non-200 failure: status code first, then body text for
        // quota/balance errors that some upstreams report without a 402.
        const code = response.status;
        let errorBody = '';
        try {
          errorBody = await response.text();
        } catch {
          // Body read failure — classify by status code alone.
        }
        const kind = classifyUpstreamFailure(code, errorBody);

        if (kind === 'rate_limit') {
          markStage('cooldown_provider');
          const signal = parseRateLimitSignal(response.headers, errorBody);
          limited = true;
          lastError = `upstream ${provider.id} rate limited (${code})`;
          this.log(lastError);
          if (!(await rotateKey('rate_limit', signal))) break;
          continue;
        }
        if (kind === 'quota') {
          markStage('cooldown_provider');
          limited = true;
          lastError = `upstream ${provider.id} quota exhausted (${code})`;
          this.log(lastError);
          if (!(await rotateKey('quota'))) break;
          continue;
        }
        if (kind === 'deterministic') {
          markStage('cooldown_provider');
          lastError = `upstream ${provider.id} returned ${code}`;
          this.log(lastError);
          if (!(await rotateKey('default'))) break;
          continue;
        }

        // Transient: retry the same key unless the code is non-retryable or the
        // budget is spent.
        lastError = `upstream ${provider.id} returned ${code}`;
        this.log(lastError);
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

    this.recordUsage({
      ts: Date.now(),
      strategy: plan.strategyId,
      // The account the request actually died on. Empty only when nothing was
      // ever dispatched (every provider excluded), which is the "no provider"
      // case the log must keep showing as "—" — a request that reached an
      // upstream always belongs to a provider and a key.
      provider: lastProvider,
      keyId: lastKeyId,
      publicModel: String(payload.model ?? ''),
      upstreamModel: lastUpstreamModel,
      ...(requestKind ? { kind: requestKind } : {}),
      status: 'error',
      statusCode: 502,
      attempts: attempt,
      error: lastError,
      // A failed request still walked real stages; the timeline is most useful
      // here, since it shows how far it got and where it stopped.
      trace: TRACE_STAGE_ORDER.filter((stage) => stageMs[stage] !== undefined).map(
        (stage) => `${stage}@${Math.round(stageMs[stage]!)}`,
      ),
    });

    if (generation !== this.generation) return { kind: 'reloaded' };
    return {
      kind: 'exhausted',
      limited,
      tprRejected,
      retryAfterSeconds: this.minRemainingCooldown(),
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
    provider: LlmProvider,
    keyId: string,
    upstreamModel: string,
    sessionId: string | undefined,
    truncated: boolean,
  ): void {
    if (!sessionId || truncated) return;
    const previous = this.sessionRoutes.get(sessionId);
    const next: SessionRoute = {
      strategyId: plan.strategyId,
      providerId: provider.id,
      keyId,
      upstreamModel,
    };
    // Always record the route (even when the flag is off) so re-enabling the
    // option does not compare against a stale route from hours ago.
    this.sessionRoutes.set(sessionId, next);
    if (!previous || plan.strategy.compactAfterSwitch === false) return;

    const keyChanged = previous.keyId !== next.keyId || previous.providerId !== next.providerId;
    const modelChanged =
      previous.upstreamModel !== next.upstreamModel || previous.strategyId !== next.strategyId;
    if (!keyChanged && !modelChanged) return;

    const reason: LlmRouteChange['reason'] =
      keyChanged && modelChanged ? 'both' : keyChanged ? 'key' : 'model';
    try {
      this.onRouteChanged?.({ sessionId, ...next, previous, reason });
    } catch (err) {
      // The upstream request already succeeded; a listener failure must not
      // turn it into a client-visible error.
      this.log(`route-change listener failed: ${describeError(err)}`);
    }
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
    const body = isOpenAI
      ? transcodeRequestToOpenAI(payload as never, {
          upstreamModel,
          maxImageParts: preset.maxImageParts ?? DEFAULT_PRESET_MAX_IMAGE_PARTS,
        })
      : { ...payload, model: upstreamModel };
    // Only the Anthropic path has a sessionKey to strip; the transcoder already
    // omits unknown fields, which is why this cannot be left to it.
    if (!isOpenAI) {
      delete (body as Record<string, unknown>).sessionKey;
      // Same reason as sessionKey: an upstream would reject an unknown field.
      delete (body as Record<string, unknown>).kind;
    }

    const controller = new AbortController();
    const totalSeconds = preset.totalSeconds ?? DEFAULT_TOTAL_SECONDS;
    const firstByteSeconds = preset.firstByteSeconds ?? DEFAULT_PRESET.firstByteSeconds ?? 0;
    const firstByteMs = Math.max(0, Math.round(firstByteSeconds * 1000));
    const totalTimer = setTimeout(() => controller.abort(), totalSeconds * 1000);
    // Headers are the first bytes: an upstream that never answers must not sit
    // on the total timeout alone. The first body chunk is enforced separately in
    // `pipeResponse`, where the stream is actually read.
    const startedAt = Date.now();
    const headerTimer = firstByteMs > 0
      ? setTimeout(() => controller.abort(), firstByteMs)
      : undefined;
    const settle = (): void => {
      clearTimeout(totalTimer);
      if (headerTimer) clearTimeout(headerTimer);
    };
    try {
      const response = await this.fetchImpl(provider.baseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
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
    guard: { firstByteMs: number; abort: () => void } = { firstByteMs: 0, abort: () => {} },
  ): Promise<{ truncated: boolean; firstByteTimeout?: boolean } | undefined> {
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
          timing.usage.promptTokens = usage?.input_tokens ?? 0;
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
    guard: { firstByteMs: number; abort: () => void } = { firstByteMs: 0, abort: () => {} },
  ): Promise<{ truncated: boolean; firstByteTimeout?: boolean }> {
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
      res.end(transcoder.finish({ truncated: !receivedDone }));
      return { truncated: !receivedDone };
    } catch (err) {
      this.log(`transcode stream failed: ${describeError(err)}`);
      const partial = transcoder.usage();
      if (timing) {
        timing.usage.promptTokens = partial.promptTokens;
        timing.usage.completionTokens = partial.completionTokens;
        timing.usage.cachedTokens = partial.cachedTokens;
        timing.totalMs = Date.now() - timing.startedAt;
      }
      res.end(transcoder.finish({ truncated: true }));
      return { truncated: true };
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
   */
  clearKeyCooldown(providerId?: string, keyId?: string): Promise<boolean> {
    const targets: Array<readonly [string, KeyPool | undefined]> = providerId
      ? [[providerId, this.pools.get(providerId)] as const]
      : [...this.pools.entries()];
    return (async () => {
      let cleared = false;
      for (const [, pool] of targets) {
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
      }
      return cleared;
    })();
  }

  /**
   * Providers in `strategy` whose keys are ALL cooling / rate-limited, so the
   * planner can exclude them before any upstream call — the "state-driven"
   * scheduling that lets a new session avoid a known-failing provider.
   */
  private async unavailableProvidersFor(
    strategy: LlmStrategy,
    publicModel: string,
  ): Promise<{ excluded: Set<string>; allLimited: boolean; retryAfterSeconds: number }> {
    const excluded = new Set<string>();
    const config = this.getConfig();
    // `allLimited` means "every enabled member was excluded because its keys are
    // merely rate-limited / busy". It is what separates a 429 from a 503 when the
    // planner ends up with nothing to route to.
    let allLimited = true;
    let sawEnabledMember = false;
    let soonestWait = Number.POSITIVE_INFINITY;
    for (const member of strategy.members) {
      const provider = config.providers.find((p) => p.id === member.provider);
      if (!provider || provider.enabled === false) continue;
      sawEnabledMember = true;
      const pool = this.pools.get(provider.id);
      if (!pool) {
        allLimited = false;
        continue;
      }
      const upstreamModel = strategy.modelAliases?.[publicModel]
        ?? resolveUpstreamModel(strategy, provider, publicModel);
      const availability = await pool.availability(upstreamModel);
      if (availability.available) {
        allLimited = false;
        continue;
      }
      excluded.add(provider.id);
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
      allLimited: allLimited && sawEnabledMember,
      retryAfterSeconds: Number.isFinite(soonestWait) ? soonestWait : 0,
    };
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
 * Classify an upstream failure into the cooldown / retry policy buckets.
 *
 * Status code is authoritative: 429 → rate-limit, 402 → quota, 400/403/404 →
 * deterministic. For any other abnormal code (a 4xx/5xx that is not one of the
 * above) the body text is consulted — some upstreams report a balance/quota
 * failure without a 402, so "insufficient balance" etc. is classified as quota.
 */
function classifyUpstreamFailure(
  code: number,
  body: string,
): 'rate_limit' | 'quota' | 'deterministic' | 'transient' {
  if (code === 429) return 'rate_limit';
  if (code === 402) return 'quota';
  if (code === 400 || code === 403 || code === 404) return 'deterministic';
  const low = body.toLowerCase();
  if (/insufficient|balance|quota|billing|余额|欠费|额度|充值/i.test(low)) return 'quota';
  return 'transient';
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
