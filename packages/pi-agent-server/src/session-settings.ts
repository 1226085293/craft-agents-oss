/**
 * Pi SDK settings for Craft-embedded sessions.
 *
 * `createAgentSession` defaults to `SettingsManager.create(cwd, agentDir)`, which
 * merges the *working directory's* `.pi/settings.json` (project scope, trusted by
 * default) on top of `agentDir/settings.json`, and persists every SDK-side
 * settings write (e.g. `setModel` → defaultProvider/defaultModel) into the
 * session's `.pi-agent/` folder. Neither is wanted here: Craft owns model,
 * thinking level and compaction for its sessions, a repo checked out as the
 * working directory must not be able to flip retry/compaction/tool defaults,
 * and nothing should be written next to the session transcript.
 *
 * The in-memory manager starts from the SDK defaults and pins the retry policy
 * explicitly. The main process surfaces the resulting `auto_retry_*` events —
 * see `packages/shared/src/agent/backend/pi/event-adapter.ts`.
 */
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { LLM_QUERY_TIMEOUT_MS } from '../../shared/src/agent/llm-tool.ts';

/**
 * Default HTTP idle/request timeout for main Pi sessions.
 *
 * History: 120_000 was killing legitimately slow upstream requests. Session
 * 261005-fresh-tulip (d4f0731 via uni-api): 700-message contexts with 15–63 s
 * time-to-first-token and ~115 s total completion — a cluster of completions
 * at exactly ~120 s − 5 s proved the client cut the stream right before the
 * upstream finished. Raised to 300_000 (SDK default). Override with
 * CRAFT_PI_HTTP_IDLE_TIMEOUT_MS (0 = disabled).
 */
export const CRAFT_PI_HTTP_IDLE_TIMEOUT_MS_DEFAULT = 300_000;

/** Read the Pi HTTP idle/request timeout from env (ms). 0 disables. */
export function getCraftPiHttpIdleTimeoutMs(): number {
  const raw = process.env.CRAFT_PI_HTTP_IDLE_TIMEOUT_MS;
  if (raw == null || raw.trim() === '') {
    return CRAFT_PI_HTTP_IDLE_TIMEOUT_MS_DEFAULT;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return CRAFT_PI_HTTP_IDLE_TIMEOUT_MS_DEFAULT;
  }
  return Math.floor(parsed);
}

type PiSettings = NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>;

export type CraftPiSessionPurpose = 'main' | 'ephemeral';

/**
 * Finish inside the host RPC timeout so the subprocess has time to serialize a
 * targeted result and the host can clear its pending request before its own
 * deadline fires.
 */
export const CRAFT_PI_EPHEMERAL_QUERY_DEADLINE_MS = LLM_QUERY_TIMEOUT_MS - 5_000;

/**
 * Retry policy for every Pi session Craft spawns — deliberately OFF at both
 * SDK layers, with no environment switch to turn them back on.
 *
 * Craft owns retrying, in two places above this one:
 *
 *  - `packages/shared/src/config/llm-gateway.ts` routes one client request:
 *    it rotates keys (per-account failures), hops providers, cools what failed
 *    and answers a per-attempt usage row for each hop;
 *  - the main-process retry ladder (`packages/shared/src/agent/pi-agent.ts`)
 *    re-issues a turn after the gateway has given up, with the UI aware of it.
 *
 * The two SDK layers used to run underneath both:
 *
 *  - agent level (`AgentSession._handleRetryableError`): `maxRetries` ×
 *    exponential backoff (2s/4s/8s…), re-running the whole assistant turn;
 *  - provider level (`maxRetries` forwarded to the Anthropic/OpenAI SDK
 *    client): 2 pre-stream retries per attempt, ~0.5s/1s apart.
 *
 * Multiplied, they turn one message into many upstream requests, and every
 * extra request re-enters the same cooling key. 261027-long-bronze is the
 * case in point: a single 「你好」 became 10 gateway requests (3 provider
 * attempts + 3 + 3 + the real prompt); only the first reached an upstream,
 * the other nine were refused locally because the key was already cooling —
 * the log showed "9 failed requests" for a message the user sent once.
 * (261005-fresh-tulip was the earlier symptom on the main session: silent
 * in-stream retries made the turn-idle watchdog fire mid-retry.)
 *
 * Retrying is a routing decision, so it belongs to the router. The settings are
 * still written explicitly rather than left undefined: `undefined` means "SDK
 * default", and the SDK default is 2 provider retries.
 */
export const CRAFT_PI_RETRY_SETTINGS = {
  enabled: false,
  maxRetries: 0,
  baseDelayMs: 2_000,
  provider: {
    maxRetries: 0,
    maxRetryDelayMs: 0,
  },
} as const;

/**
 * Same policy for utility sessions (`call_llm`, titles, summaries).
 *
 * These used to carry a smaller budget of their own (2 agent retries × 2
 * provider retries). They now fail fast like the main session: a utility call
 * that cannot be served is a routing problem, and the gateway already spent its
 * own key/provider ladder on it before the error surfaced.
 */
export const CRAFT_PI_EPHEMERAL_RETRY_SETTINGS = CRAFT_PI_RETRY_SETTINGS;

/**
 * Worst-case SDK-side backoff before an ephemeral query gives up.
 *
 * Zero by construction now that the SDK retry budget is disabled. The constant
 * (and the deadline assertion in the tests) stays: it is the invariant that
 * keeps utility calls inside their RPC budget, and it must keep holding if a
 * retry policy is ever reintroduced here.
 */
export const CRAFT_PI_EPHEMERAL_MAX_BACKOFF_MS =
  CRAFT_PI_EPHEMERAL_RETRY_SETTINGS.provider.maxRetries *
    CRAFT_PI_EPHEMERAL_RETRY_SETTINGS.provider.maxRetryDelayMs *
    (CRAFT_PI_EPHEMERAL_RETRY_SETTINGS.maxRetries + 1) +
  CRAFT_PI_EPHEMERAL_RETRY_SETTINGS.baseDelayMs *
    (2 ** CRAFT_PI_EPHEMERAL_RETRY_SETTINGS.maxRetries - 1);

/**
 * Upstream compaction defaults, mirrored so an explicit override never drops a
 * field the SDK reads (see `DEFAULT_COMPACTION_SETTINGS` in
 * `@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js`).
 */
export const PI_DEFAULT_COMPACTION_RESERVE_TOKENS = 16_384;
export const PI_DEFAULT_KEEP_RECENT_TOKENS = 20_000;

/**
 * Ceiling for the compaction reserve. 0.8 × reserve is the summarization
 * request's `maxTokens`, so 32k leaves ~26k output tokens — enough for a
 * reasoning model to think and still write the summary.
 */
export const CRAFT_PI_COMPACTION_RESERVE_TOKENS = 32_768;

/** Share of the context window reserved on large-context models. */
const COMPACTION_RESERVE_WINDOW_SHARE = 0.16;

/**
 * Compaction settings for a session on a model with the given context window.
 *
 * `reserveTokens` drives two things in the Pi SDK:
 *  - when auto-compaction fires: `contextTokens > contextWindow - reserveTokens`
 *  - how much the summary itself may emit: `maxTokens = 0.8 * reserveTokens`
 *
 * The second is why the upstream default is too small for Craft.
 * `createSummarizationOptions` forwards the session's thinking level to the
 * summarization call (`options.reasoning = thinkingLevel`), so on a reasoning
 * model thinking tokens are charged against that same small budget. At `xhigh`
 * a single summary can burn >13k thinking tokens — more than the default
 * 16384 reserve allows (0.8 × 16384 ≈ 13.1k) — so the response comes back
 * `stopReason: "length"` ("generation hit the token cap and the summary is
 * incomplete") and the whole compaction fails, killing the turn.
 *
 * Reserving more both raises the summary's own cap and triggers compaction
 * earlier, which shrinks the prompt and frees further output budget.
 *
 * Falls back to the upstream default when the window is unknown, and never
 * reserves more than the ceiling — a small-window model must not end up with
 * the reserve larger than its context.
 */
export function craftCompactionSettings(contextWindow?: number): {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
} {
  const reserveTokens =
    typeof contextWindow === 'number' && contextWindow > 0
      ? Math.max(
          PI_DEFAULT_COMPACTION_RESERVE_TOKENS,
          Math.min(
            CRAFT_PI_COMPACTION_RESERVE_TOKENS,
            Math.floor(COMPACTION_RESERVE_WINDOW_SHARE * contextWindow),
          ),
        )
      : PI_DEFAULT_COMPACTION_RESERVE_TOKENS;

  return {
    enabled: true,
    reserveTokens,
    keepRecentTokens: PI_DEFAULT_KEEP_RECENT_TOKENS,
  };
}

/** Settings applied to one Pi session, isolated from project/global Pi files. */
export function buildCraftPiSettings(purpose: CraftPiSessionPurpose = 'main'): PiSettings {
  const retry = purpose === 'ephemeral'
    ? CRAFT_PI_EPHEMERAL_RETRY_SETTINGS
    : CRAFT_PI_RETRY_SETTINGS;

  return {
    retry: {
      enabled: retry.enabled,
      maxRetries: retry.maxRetries,
      baseDelayMs: retry.baseDelayMs,
      provider: { ...retry.provider },
    },
    // PiAgent re-asserts auto-compaction on every subprocess start
    // (requestSetAutoCompaction(true)); keep the SDK default explicit here so
    // the intent is visible next to the retry policy.
    compaction: { enabled: true },
  };
}

/**
 * Fresh in-memory settings manager for one Pi session. Cheap to create; not
 * shared between the main session and `queryLlm` ephemeral sessions so a
 * `setModel` on one can never leak a "default model" into the other.
 */
export function createCraftSettingsManager(
  purpose: CraftPiSessionPurpose = 'main',
): SettingsManager {
  return SettingsManager.inMemory(buildCraftPiSettings(purpose));
}
